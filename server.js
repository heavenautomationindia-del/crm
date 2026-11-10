const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');
const webpush = require('web-push');
let VAPID_PUB = '';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : false,
});
const q = (sql, p) => pool.query(sql, p);
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(e => { console.error(e); res.status(500).json({ error: e.message }); });

// ---------- master data ----------
const REPORT_PHOTO_REQUIRED = true;   // technician must attach a report-book photo before 'Work done'
const SERVICE_TYPES = ['Camera Issue', 'Automation Issue', 'Network / Wi-Fi Issue', 'Door Lock / Access Issue', 'Intercom Issue', 'Alarm / Sensor Issue', 'Power / Wiring Issue', 'Installation', 'Other'];
const VISIT_TYPES = ['Onsite', 'Offsite'];
const LEAD_STAGES = ['New Enquiry', 'Contacted', 'Site Visit', 'Quotation', 'Negotiation', 'Closed Won', 'Closed Lost'];
const LEAD_PRIORITIES = ['Hot', 'Warm', 'Cold'];
const LEAD_SOURCES = ['Call', 'WhatsApp', 'Walk-in', 'Website', 'Instagram', 'Referral', 'Other'];
const LEAD_INTERESTS = ['CCTV Cameras', 'Home Automation', 'Smart Lock / Access', 'Intercom', 'Alarm / Security', 'Networking / Wi-Fi', 'Other'];
const STATUSES = ['New Ticket', 'Work Not Started', 'On-Process', 'Work Pending', 'Awaiting Payment', 'Resolved', 'Cancelled'];
const APPROVALS = ['Pending', 'Approved', 'Rejected'];
const BANKS = ['HDFC BANK LTD - 50200080113661', 'HDFC BANK LTD - 50200090005267', 'SERVICE PETTY CASH', 'SALES PETTY CASH'];
// Super Admin = owner: everything, and the ONLY role that can delete anything.
// Admin staff / Sales staff / Technician staff: Super Admin ticks what each person can use.
const SUPER = 'Super Admin';
const ROLES = [SUPER, 'Admin', 'Sales', 'Technician'];
const PERMS = [
  { k: 'dashboard', l: 'Dashboard', g: 'Menus' }, { k: 'services', l: 'Services & jobs', g: 'Menus' },
  { k: 'customers', l: 'Customers', g: 'Menus' }, { k: 'team', l: 'Team', g: 'Menus' }, { k: 'leads', l: 'Leads', g: 'Menus' },
  { k: 'attendance', l: 'Team attendance, approvals & report (always on for Admin staff)', g: 'Menus' },
  { k: 'service_create', l: 'Create services & jobs', g: 'Actions' }, { k: 'service_assign', l: 'Assign technician', g: 'Actions' },
  { k: 'service_edit', l: 'Edit status & approval', g: 'Actions' }, { k: 'payments', l: 'Add payments & discounts', g: 'Actions' },
  { k: 'view_charges', l: 'See charges', g: 'Actions' }, { k: 'view_phone', l: 'See customer phone', g: 'Actions' },
  { k: 'types', l: 'Add issue types & job types', g: 'Actions' },
];
const TECH_KEYS = ['view_phone', 'view_charges'];
const ALL_KEYS = PERMS.map(p => p.k);
const DEFAULTS = {
  Admin: ALL_KEYS.filter(k => k !== 'team'),
  Sales: ['dashboard', 'services', 'customers', 'leads', 'service_create', 'view_charges', 'view_phone'],
  Technician: ['view_phone'],
};
const cleanPerms = (role, list) => role === SUPER ? ALL_KEYS : (Array.isArray(list) ? list : DEFAULTS[role] || []).filter(k => (role === 'Technician' ? TECH_KEYS : ALL_KEYS).includes(k));
const BRANDS = ['Heaven', 'G Media'];
const JOB_TYPES = ['New Installation', 'CCTV Camera Fitting', 'Automation Fitting', 'Wiring / Cabling', 'Site Survey', 'AMC Visit', 'Other'];
const OPEN_ST = ['Work Not Started', 'On-Process', 'Work Pending'];   // a technician with one of these is busy
const LEAVE_TYPES = ['Casual Leave', 'Sick Leave', 'Emergency Leave', 'Other'];
// Heaven Automation office, Thillai Nagar, Trichy (from the Google Maps listing). Super Admin can change it in Profile.
const OFFICE_DEFAULT = { name: 'Heaven Automation office, Thillai Nagar, Trichy', lat: 10.8225698, lng: 78.683858, radius: 150, late: '09:45' };

// ---------- auth helpers ----------
const hash = (pw, salt = crypto.randomBytes(16).toString('hex')) => salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
const verify = (pw, h) => { const [s, k] = (h || ':').split(':'); const a = Buffer.from(k || '', 'hex'), b = crypto.scryptSync(pw, s, 32); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const sign = d => { const p = Buffer.from(JSON.stringify(d)).toString('base64url'); return p + '.' + crypto.createHmac('sha256', SECRET).update(p).digest('base64url'); };
const unsign = t => {
  if (!t) return; const [p, s] = t.split('.'); if (!s) return;
  const e = crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
  if (e.length !== s.length || !crypto.timingSafeEqual(Buffer.from(e), Buffer.from(s))) return;
  const d = JSON.parse(Buffer.from(p, 'base64url')); return d.exp > Date.now() ? d : undefined;
};
const cookies = h => Object.fromEntries((h || '').split(';').map(c => c.trim().split('=')).filter(x => x[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
const randPw = () => Array.from({ length: 8 }, () => 'abcdefghjkmnpqrstuvwxyz23456789'[crypto.randomInt(31)]).join('');
const isSuper = u => u.role === SUPER;
const isBoss = u => u.role === SUPER || u.role === 'Admin';
const can = (u, k) => isSuper(u) || (u.permissions || []).includes(k);
const isTech = u => u.role === 'Technician';
const need = (...ks) => (req, res, next) => ks.some(k => can(req.user, k)) ? next() : res.status(403).json({ error: 'Not allowed' });
const superOnly = (req, res, next) => isSuper(req.user) ? next() : res.status(403).json({ error: 'Only the Super Admin can delete' });
const techOnly = (req, res, next) => (isTech(req.user) || isSuper(req.user)) ? next() : res.status(403).json({ error: 'Not allowed' });
const auth = wrap(async (req, res, next) => {
  const d = unsign(cookies(req.headers.cookie).gz);
  const u = d && (await q('SELECT u.*, b.name brand_name FROM users u LEFT JOIN brands b ON b.id=u.brand_id WHERE u.id=$1 AND u.active', [d.id])).rows[0];
  if (!u) return res.status(401).json({ error: 'Login required' });
  req.user = u; next();
});
const me = u => ({ id: u.id, name: u.name, role: u.role, username: u.username, brand_id: u.brand_id || null, brand: u.brand_name || null, permissions: isSuper(u) ? ALL_KEYS : u.permissions });
const pub = u => { const { password_hash, ...r } = u; return r; };

const tries = {};
app.post('/api/login', wrap(async (req, res) => {
  const ip = req.ip, t = tries[ip] || { n: 0, at: Date.now() };
  if (Date.now() - t.at > 600000) { t.n = 0; t.at = Date.now(); }
  if (t.n >= 8) return res.status(429).json({ error: 'Too many attempts. Try again in 10 minutes.' });
  const { username, password } = req.body || {};
  const u = (await q('SELECT * FROM users WHERE lower(username)=lower($1) AND active', [String(username || '').trim()])).rows[0];
  if (!u || !verify(String(password || ''), u.password_hash)) { tries[ip] = { n: t.n + 1, at: t.at }; return res.status(401).json({ error: 'Wrong username or password' }); }
  delete tries[ip];
  if (u.brand_id) u.brand_name = ((await q('SELECT name FROM brands WHERE id=$1', [u.brand_id])).rows[0] || {}).name;
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `gz=${sign({ id: u.id, exp: Date.now() + 30 * 864e5 })}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secure}`);
  res.json(me(u));
}));
app.post('/api/logout', (req, res) => { res.setHeader('Set-Cookie', 'gz=; Path=/; HttpOnly; Max-Age=0'); res.json({ ok: true }); });
// data version: bumped on every successful write so open apps can refresh themselves
let VER = Date.now();
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && !/^\/(login|logout|password|push\/|notifications\/read)/.test(req.path))
    res.on('finish', () => { if (res.statusCode < 400) VER = Math.max(VER + 1, Date.now()); });
  next();
});
app.use('/api', (req, res, next) => (req.path === '/login' || req.path === '/logout') ? next() : auth(req, res, next));
app.get('/api/pulse', wrap(async (req, res) => {
  const r = (await q('SELECT COALESCE(MAX(id),0)::int last, COUNT(*) FILTER (WHERE NOT read)::int unread FROM notifications WHERE user_id=$1', [req.user.id])).rows[0];
  res.set('Cache-Control', 'no-store').json({ v: VER, last: r.last, unread: r.unread });
}));
app.get('/api/me', (req, res) => res.json(me(req.user)));
app.post('/api/password', wrap(async (req, res) => {
  const { current, next } = req.body || {};
  if (!verify(String(current || ''), req.user.password_hash)) return res.status(400).json({ error: 'Current password is wrong' });
  if (!next || String(next).length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  await q('UPDATE users SET password_hash=$1 WHERE id=$2', [hash(String(next)), req.user.id]); res.json({ ok: true });
}));

// ---------- leads (Heaven Automation pipeline) ----------
const LSEL = `SELECT l.id,l.name,l.phone,l.email,l.source,l.interest,l.address,l.priority,l.stage,l.assigned_to,l.value,to_char(l.follow_up,'YYYY-MM-DD') follow_up,l.last_contact,l.notes,l.lost_reason,l.customer_id,l.created_at,l.lat,l.lng,l.map_url,l.location_by,l.location_on,u.name agent FROM leads l LEFT JOIN users u ON u.id=l.assigned_to`;
const digits = v => String(v || '').replace(/\D/g, '');
const pickOf = (v, list, d) => list.includes(v) ? v : d;
const cleanLead = (b, cur = {}) => {
  const o = {}, t = k => { if (b[k] !== undefined) o[k] = String(b[k] ?? '').trim() || null; };
  ['name', 'phone', 'email', 'address', 'notes', 'lost_reason'].forEach(t);
  if (b.source !== undefined) o.source = b.source ? pickOf(b.source, LEAD_SOURCES, 'Other') : null;
  if (b.interest !== undefined) o.interest = b.interest ? pickOf(b.interest, LEAD_INTERESTS, 'Other') : null;
  if (b.priority !== undefined) o.priority = pickOf(b.priority, LEAD_PRIORITIES, cur.priority || 'Warm');
  if (b.stage !== undefined) o.stage = pickOf(b.stage, LEAD_STAGES, cur.stage || 'New Enquiry');
  if (b.assigned_to !== undefined) o.assigned_to = Number.isInteger(+b.assigned_to) && +b.assigned_to > 0 ? +b.assigned_to : null;
  if (b.value !== undefined) o.value = money(b.value);
  if (b.follow_up !== undefined) o.follow_up = /^\d{4}-\d{2}-\d{2}$/.test(b.follow_up) ? b.follow_up : null;
  return o;
};
const insLead = async (o, uid) => (await q(`INSERT INTO leads(name,phone,email,source,interest,address,priority,stage,assigned_to,value,follow_up,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
  [o.name, o.phone || null, o.email || null, o.source || null, o.interest || null, o.address || null, o.priority || 'Warm', o.stage || 'New Enquiry', o.assigned_to || null, o.value || 0, o.follow_up || null, o.notes || null, uid])).rows[0].id;
const leadLog = (id, who, text) => q('INSERT INTO lead_activity(lead_id,by_name,text) VALUES($1,$2,$3)', [id, who, text]);
const MAPRE = /@(-?\d+\.\d+),(-?\d+\.\d+)|[?&](?:q|ll|query)=(-?\d+\.\d+),(-?\d+\.\d+)/;
// site-visit pin: either GPS (lat,lng) or a pasted Google Maps link; empty link removes the pin
const locFields = (b, u) => {
  const o = {};
  if (b.lat !== undefined && b.lat !== null && b.lat !== '') {
    const lat = Number(b.lat), lng = Number(b.lng);
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return { error: 'Invalid location' };
    return { lat, lng, map_url: `https://www.google.com/maps?q=${lat},${lng}`, location_by: u.name, location_on: new Date() };
  }
  if (b.map_url !== undefined) {
    const url = String(b.map_url || '').trim().slice(0, 500);
    if (!url) return { map_url: null, lat: null, lng: null, location_by: null, location_on: null };
    if (!/^https?:\/\//i.test(url)) return { error: 'Paste a valid Google Maps link (starts with https://)' };
    const m = MAPRE.exec(url);
    return { map_url: url, lat: m ? +(m[1] || m[3]) : null, lng: m ? +(m[2] || m[4]) : null, location_by: u.name, location_on: new Date() };
  }
  return o;
};
const userName = async id => id ? ((await q('SELECT name FROM users WHERE id=$1', [id])).rows[0] || {}).name || '—' : 'Unassigned';

app.get('/api/leads', need('leads'), wrap(async (_, res) => res.json((await q(`${LSEL} ORDER BY l.last_contact DESC, l.id DESC LIMIT 3000`)).rows)));

app.post('/api/leads/import', need('leads'), wrap(async (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows.slice(0, 2000) : [];
  const have = new Set((await q(`SELECT regexp_replace(phone,'[^0-9]','','g') d FROM leads WHERE phone IS NOT NULL`)).rows.map(r => r.d));
  let added = 0, skipped = 0;
  for (const r of rows) {
    const o = cleanLead(r); delete o.assigned_to;
    if (!o.name) { skipped++; continue; }
    const dg = digits(o.phone);
    if (dg.length >= 7) { if (have.has(dg)) { skipped++; continue; } have.add(dg); }
    await insLead(o, req.user.id); added++;
  }
  res.json({ added, skipped });
}));

app.post('/api/leads/bulk', need('leads'), wrap(async (req, res) => {
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger).slice(0, 500);
  if (!ids.length) return res.status(400).json({ error: 'Nothing selected' });
  if (req.body.delete) {
    if (!isSuper(req.user)) return res.status(403).json({ error: 'Only the Super Admin can delete' });
    await q('DELETE FROM leads WHERE id=ANY($1::int[])', [ids]); return res.json({ ok: true });
  }
  const o = cleanLead({ stage: req.body.stage, assigned_to: req.body.assigned_to, priority: req.body.priority }), keys = Object.keys(o);
  if (!keys.length) return res.json({ ok: true });
  await q(`UPDATE leads SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(',')}, updated_at=now()${o.stage ? ', last_contact=now()' : ''} WHERE id=ANY($${keys.length + 1}::int[])`, [...keys.map(k => o[k]), ids]);
  const txt = [o.stage && `Stage → ${o.stage}`, o.priority && `Priority → ${o.priority}`, 'assigned_to' in o && `Agent → ${await userName(o.assigned_to)}`].filter(Boolean).join(', ');
  await q('INSERT INTO lead_activity(lead_id,by_name,text) SELECT id,$1::text,$2::text FROM leads WHERE id=ANY($3::int[])', [req.user.name, txt, ids]);
  if (o.assigned_to && o.assigned_to !== req.user.id) notify([o.assigned_to], 'Leads assigned', `${ids.length} lead(s) were assigned to you`, null).catch(() => {});
  res.json({ ok: true });
}));

app.post('/api/leads', need('leads'), wrap(async (req, res) => {
  const o = cleanLead(req.body);
  if (!o.name) return res.status(400).json({ error: 'Enter the lead name' });
  const dg = digits(o.phone);
  if (dg.length >= 7) {
    const d = (await q(`SELECT name FROM leads WHERE regexp_replace(phone,'[^0-9]','','g')=$1 LIMIT 1`, [dg])).rows[0];
    if (d) return res.status(409).json({ error: `A lead with this phone already exists (${d.name})` });
  }
  const lf = locFields(req.body, req.user);
  if (lf.error) return res.status(400).json({ error: lf.error });
  const id = await insLead(o, req.user.id);
  if (Object.keys(lf).length) { const k = Object.keys(lf); await q(`UPDATE leads SET ${k.map((c, i) => `${c}=$${i + 1}`).join(',')} WHERE id=$${k.length + 1}`, [...k.map(c => lf[c]), id]); }
  await leadLog(id, req.user.name, 'Lead created');
  if (o.assigned_to && o.assigned_to !== req.user.id) notify([o.assigned_to], 'New lead assigned', `${o.name} was assigned to you`, null).catch(() => {});
  res.json({ id });
}));

app.get('/api/leads/:id', need('leads'), wrap(async (req, res) => {
  const l = (await q(`${LSEL} WHERE l.id=$1`, [req.params.id])).rows[0];
  if (!l) return res.status(404).json({ error: 'Not found' });
  l.activity = (await q('SELECT by_name, text, created_at FROM lead_activity WHERE lead_id=$1 ORDER BY id DESC LIMIT 100', [l.id])).rows;
  res.json(l);
}));

app.patch('/api/leads/:id', need('leads'), wrap(async (req, res) => {
  const cur = (await q('SELECT *, to_char(follow_up,\'YYYY-MM-DD\') fu FROM leads WHERE id=$1', [req.params.id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const o = cleanLead(req.body, cur);
  if ('name' in o && !o.name) return res.status(400).json({ error: 'Enter the lead name' });
  const lf = locFields(req.body, req.user);
  if (lf.error) return res.status(400).json({ error: lf.error });
  Object.assign(o, lf);
  const keys = Object.keys(o); if (!keys.length) return res.json({ ok: true });
  const stageChanged = o.stage && o.stage !== cur.stage;
  await q(`UPDATE leads SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(',')}, updated_at=now()${stageChanged ? ', last_contact=now()' : ''} WHERE id=$${keys.length + 1}`, [...keys.map(k => o[k]), cur.id]);
  const ch = [];
  if (stageChanged) ch.push(`Stage: ${cur.stage} → ${o.stage}` + (o.lost_reason ? ` (${o.lost_reason})` : ''));
  if (o.priority && o.priority !== cur.priority) ch.push(`Priority: ${cur.priority} → ${o.priority}`);
  if ('assigned_to' in o && o.assigned_to !== cur.assigned_to) ch.push(`Agent: ${await userName(cur.assigned_to)} → ${await userName(o.assigned_to)}`);
  if ('follow_up' in o && (o.follow_up || null) !== (cur.fu || null)) ch.push(`Follow-up: ${cur.fu || '—'} → ${o.follow_up || '—'}`);
  if ('value' in o && Number(o.value) !== Number(cur.value)) ch.push(`Value: ₹${Number(cur.value)} → ₹${Number(o.value)}`);
  if ('map_url' in lf) ch.push(lf.map_url ? `Site location pinned by ${req.user.name}` : 'Site location removed');
  if (!ch.length && keys.some(k => !['stage', 'priority', 'assigned_to', 'follow_up', 'value', 'lost_reason', 'lat', 'lng', 'map_url', 'location_by', 'location_on'].includes(k))) ch.push('Details updated');
  if (ch.length) await leadLog(cur.id, req.user.name, ch.join(' · '));
  if ('assigned_to' in o && o.assigned_to && o.assigned_to !== cur.assigned_to && o.assigned_to !== req.user.id) notify([o.assigned_to], 'Lead assigned to you', cur.name, null).catch(() => {});
  res.json({ ok: true });
}));

app.post('/api/leads/:id/note', need('leads'), wrap(async (req, res) => {
  const t = String(req.body.text || '').trim().slice(0, 1000);
  if (!t) return res.status(400).json({ error: 'Write a note first' });
  const r = await q('UPDATE leads SET last_contact=now(), updated_at=now() WHERE id=$1 RETURNING id', [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
  await leadLog(r.rows[0].id, req.user.name, t); res.json({ ok: true });
}));

app.post('/api/leads/:id/convert', need('leads'), wrap(async (req, res) => {
  const l = (await q('SELECT * FROM leads WHERE id=$1', [req.params.id])).rows[0];
  if (!l) return res.status(404).json({ error: 'Not found' });
  let c; if (l.customer_id) c = (await q('SELECT * FROM customers WHERE id=$1', [l.customer_id])).rows[0];
  if (!c && digits(l.phone).length >= 7) c = (await q(`SELECT * FROM customers WHERE regexp_replace(phone,'[^0-9]','','g')=$1 LIMIT 1`, [digits(l.phone)])).rows[0];
  if (!c) c = (await q('INSERT INTO customers(name,phone,email,address) VALUES($1,$2,$3,$4) RETURNING *', [l.name, l.phone, l.email, l.address])).rows[0];
  await q(`UPDATE leads SET customer_id=$1, stage='Closed Won', updated_at=now(), last_contact=now() WHERE id=$2`, [c.id, l.id]);
  await leadLog(l.id, req.user.name, l.customer_id ? 'Service requested' : 'Converted to customer · Closed Won');
  res.json({ customer: { id: c.id, name: c.name, phone: c.phone, address: c.address, tickets: 0 } });
}));

app.delete('/api/leads/:id', superOnly, wrap(async (req, res) => {
  await q('DELETE FROM leads WHERE id=$1', [req.params.id]); res.json({ ok: true });
}));

// ---------- schema ----------
// extra tables are created separately so a problem here can never stop the app from starting
async function initExtra() {
  try {
    await q(`
    CREATE TABLE IF NOT EXISTS leads (id SERIAL PRIMARY KEY, name TEXT NOT NULL, phone TEXT, email TEXT, source TEXT, interest TEXT, address TEXT, priority TEXT DEFAULT 'Warm', stage TEXT DEFAULT 'New Enquiry', assigned_to INT, value NUMERIC(12,2) DEFAULT 0, follow_up DATE, last_contact TIMESTAMPTZ DEFAULT now(), notes TEXT, lost_reason TEXT, customer_id INT, created_by INT, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE IF NOT EXISTS lead_activity (id SERIAL PRIMARY KEY, lead_id INT REFERENCES leads(id) ON DELETE CASCADE, by_name TEXT, text TEXT, created_at TIMESTAMPTZ DEFAULT now());
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS map_url TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS location_by TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS location_on TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage);
    CREATE INDEX IF NOT EXISTS idx_lead_act ON lead_activity(lead_id);
    CREATE TABLE IF NOT EXISTS issue_types (id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL);`);
    if (!(await q('SELECT 1 FROM issue_types LIMIT 1')).rows.length)
      for (const n of SERVICE_TYPES) await q('INSERT INTO issue_types(name) VALUES($1) ON CONFLICT DO NOTHING', [n]);
  } catch (e) { console.error('extra schema failed:', e.message); }
}

// brands, job types, Super Admin, attendance + leave / permission
async function initV2() {
  await q(`
  CREATE TABLE IF NOT EXISTS brands (id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL, created_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS job_types (id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL);
  ALTER TABLE users ADD COLUMN IF NOT EXISTS brand_id INT;
  ALTER TABLE services ADD COLUMN IF NOT EXISTS brand_id INT;
  ALTER TABLE services ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'Service';
  CREATE INDEX IF NOT EXISTS idx_services_brand ON services(brand_id);
  CREATE INDEX IF NOT EXISTS idx_services_tech ON services(technician_id, status);
  CREATE TABLE IF NOT EXISTS attendance (id SERIAL PRIMARY KEY, user_id INT NOT NULL, day DATE NOT NULL, status TEXT NOT NULL DEFAULT 'Present',
    check_in TIMESTAMPTZ, check_out TIMESTAMPTZ, in_lat DOUBLE PRECISION, in_lng DOUBLE PRECISION, out_lat DOUBLE PRECISION, out_lng DOUBLE PRECISION,
    note TEXT, marked_by TEXT, updated_at TIMESTAMPTZ DEFAULT now(), UNIQUE(user_id, day));
  CREATE TABLE IF NOT EXISTS leave_requests (id SERIAL PRIMARY KEY, user_id INT NOT NULL, kind TEXT NOT NULL, leave_type TEXT, session TEXT,
    from_date DATE NOT NULL, to_date DATE NOT NULL, from_time TEXT, to_time TEXT, reason TEXT, status TEXT DEFAULT 'Pending',
    decided_by TEXT, decided_at TIMESTAMPTZ, admin_note TEXT, created_at TIMESTAMPTZ DEFAULT now());
  CREATE INDEX IF NOT EXISTS idx_att_day ON attendance(day);
  CREATE INDEX IF NOT EXISTS idx_lr_user ON leave_requests(user_id, from_date);
  ALTER TABLE notifications ADD COLUMN IF NOT EXISTS link TEXT;
  ALTER TABLE attendance ADD COLUMN IF NOT EXISTS in_dist INT;
  ALTER TABLE attendance ADD COLUMN IF NOT EXISTS out_dist INT;
  ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
  ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
  ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS distance INT;`);
  if (!(await q(`SELECT 1 FROM settings WHERE k='office'`)).rows.length)
    await q(`INSERT INTO settings(k,v) VALUES('office',$1)`, [JSON.stringify(OFFICE_DEFAULT)]);
  if (!(await q('SELECT 1 FROM brands LIMIT 1')).rows.length)
    for (const n of BRANDS) await q('INSERT INTO brands(name) VALUES($1) ON CONFLICT DO NOTHING', [n]);
  if (!(await q('SELECT 1 FROM job_types LIMIT 1')).rows.length)
    for (const n of JOB_TYPES) await q('INSERT INTO job_types(name) VALUES($1) ON CONFLICT DO NOTHING', [n]);
  const heaven = (await q(`SELECT id FROM brands ORDER BY (lower(name)='heaven') DESC, id LIMIT 1`)).rows[0].id;
  await q(`UPDATE services SET brand_id=$1 WHERE brand_id IS NULL`, [heaven]);
  await q(`UPDATE services SET kind='Service' WHERE kind IS NULL`);
  // one-time: the first (owner) admin becomes Super Admin; other old admins become Admin staff of Heaven with every permission they had
  if (!(await q(`SELECT 1 FROM users WHERE role=$1 LIMIT 1`, [SUPER])).rows.length) {
    const own = (await q(`SELECT id FROM users WHERE role='Admin' ORDER BY (username='admin') DESC, id LIMIT 1`)).rows[0];
    if (own) await q(`UPDATE users SET role=$1, permissions=$2 WHERE id=$3`, [SUPER, ALL_KEYS, own.id]);
    await q(`UPDATE users SET brand_id=$1, permissions=$2 WHERE role='Admin' AND brand_id IS NULL`, [heaven, ALL_KEYS.filter(k => k !== 'team')]);
  }
  if (!(await q(`SELECT 1 FROM settings WHERE k='att_start'`)).rows.length)
    await q(`INSERT INTO settings(k,v) VALUES('att_start', to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD'))`);
}

async function init() {
  await q(`
  CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT, phone TEXT, role TEXT NOT NULL, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, permissions TEXT[] DEFAULT '{}', active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS customers (id SERIAL PRIMARY KEY, name TEXT NOT NULL, phone TEXT, email TEXT, address TEXT, city TEXT, customer_type TEXT DEFAULT 'End Customer', created_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS services (
    id SERIAL PRIMARY KEY, ticket_no INT UNIQUE NOT NULL, customer_id INT REFERENCES customers(id), product TEXT, request_details TEXT,
    visit_type TEXT DEFAULT 'Onsite', service_type TEXT DEFAULT 'Paid Service', status TEXT DEFAULT 'New Ticket', work_status TEXT DEFAULT 'Not Started', approval TEXT DEFAULT 'Pending',
    technician_id INT, helper_id INT, submitted_on TIMESTAMPTZ DEFAULT now(), work_started_on TIMESTAMPTZ, on_process_at TIMESTAMPTZ, resolved_on TIMESTAMPTZ,
    charges_applied NUMERIC(12,2) DEFAULT 0, discount NUMERIC(12,2) DEFAULT 0, location TEXT);
  ALTER TABLE services ADD COLUMN IF NOT EXISTS completion_note TEXT;
  ALTER TABLE services ADD COLUMN IF NOT EXISTS assigned_on TIMESTAMPTZ;
  ALTER TABLE services ADD COLUMN IF NOT EXISTS amount_received NUMERIC(12,2) DEFAULT 0;
  ALTER TABLE services ADD COLUMN IF NOT EXISTS received_settled NUMERIC(12,2) DEFAULT 0;
  ALTER TABLE services ADD COLUMN IF NOT EXISTS pending_reason TEXT;
  ALTER TABLE services ADD COLUMN IF NOT EXISTS billing_type TEXT;
  ALTER TABLE services ADD COLUMN IF NOT EXISTS pay_mode TEXT;
  ALTER TABLE services ADD COLUMN IF NOT EXISTS bank_amount NUMERIC(12,2) DEFAULT 0;
  ALTER TABLE services ADD COLUMN IF NOT EXISTS bank_settled NUMERIC(12,2) DEFAULT 0;
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS map_url TEXT;
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS location_by TEXT;
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS location_on TIMESTAMPTZ;
  CREATE TABLE IF NOT EXISTS notifications (id SERIAL PRIMARY KEY, user_id INT NOT NULL, title TEXT, body TEXT, service_id INT, read BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT now());
  CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read);
  UPDATE services SET status='Work Not Started' WHERE status='New Ticket' AND technician_id IS NOT NULL;
  CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
  CREATE TABLE IF NOT EXISTS push_subs (id SERIAL PRIMARY KEY, user_id INT NOT NULL, endpoint TEXT UNIQUE NOT NULL, p256dh TEXT, auth TEXT, created_at TIMESTAMPTZ DEFAULT now());
  ALTER TABLE services DROP CONSTRAINT IF EXISTS services_technician_id_fkey;
  ALTER TABLE services DROP CONSTRAINT IF EXISTS services_helper_id_fkey;
  CREATE TABLE IF NOT EXISTS payments (id SERIAL PRIMARY KEY, service_id INT REFERENCES services(id) ON DELETE CASCADE, amount NUMERIC(12,2) NOT NULL, bank TEXT, paid_on DATE DEFAULT CURRENT_DATE, note TEXT, approval TEXT DEFAULT 'Pending', created_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS service_history (id SERIAL PRIMARY KEY, service_id INT REFERENCES services(id) ON DELETE CASCADE, done_by TEXT, done_on TIMESTAMPTZ DEFAULT now(), changes TEXT);
  CREATE TABLE IF NOT EXISTS service_photos (id SERIAL PRIMARY KEY, service_id INT REFERENCES services(id) ON DELETE CASCADE, stage TEXT, caption TEXT, mime TEXT, data BYTEA, uploaded_by TEXT, created_at TIMESTAMPTZ DEFAULT now());
  CREATE INDEX IF NOT EXISTS idx_services_status ON services(status);
`);
  await initTodos();
  await initExtra();
  await initV2();
  let kp = (await q(`SELECT v FROM settings WHERE k='vapid'`)).rows[0];
  if (!kp) { const k = webpush.generateVAPIDKeys(); await q(`INSERT INTO settings(k,v) VALUES('vapid',$1)`, [JSON.stringify(k)]); kp = { v: JSON.stringify(k) }; }
  const vk = JSON.parse(kp.v); VAPID_PUB = vk.publicKey; webpush.setVapidDetails('mailto:heavenautomationindia@gmail.com', vk.publicKey, vk.privateKey);
  if (!(await q('SELECT 1 FROM users LIMIT 1')).rows.length) {
    const pw = process.env.ADMIN_PASSWORD || 'Admin123';
    await q('INSERT INTO users(name,role,username,password_hash,permissions) VALUES($1,$2,$3,$4,$5)', ['Super Admin', SUPER, 'admin', hash(pw), ALL_KEYS]);
    console.log('Created first admin → username: admin' + (process.env.ADMIN_PASSWORD ? ' (password from ADMIN_PASSWORD env)' : ' password: Admin123 (change it!)'));
  }
  // Password recovery: when ADMIN_PASSWORD in Render is set to a NEW value, apply it once to the Super Admin
  // (username "admin"). A password changed later in Profile stays until ADMIN_PASSWORD is changed again.
  const envPw = process.env.ADMIN_PASSWORD;
  if (envPw) {
    const fp = crypto.createHash('sha256').update('gz-admin-pw:' + envPw).digest('hex');
    const done = (await q(`SELECT v FROM settings WHERE k='admin_pw_applied'`)).rows[0];
    if (!done || done.v !== fp) {
      let sa = (await q(`SELECT id FROM users WHERE role=$1 ORDER BY (lower(username)='admin') DESC, id LIMIT 1`, [SUPER])).rows[0];
      if (!sa) sa = (await q(`SELECT id FROM users WHERE lower(username)='admin' LIMIT 1`)).rows[0];
      if (sa) {
        const clash = (await q(`SELECT 1 FROM users WHERE lower(username)='admin' AND id<>$1`, [sa.id])).rows.length;
        await q(`UPDATE users SET password_hash=$1, role=$2, permissions=$3, active=true${clash ? '' : `, username='admin'`} WHERE id=$4`, [hash(envPw), SUPER, ALL_KEYS, sa.id]);
        console.log('Super Admin password reset from ADMIN_PASSWORD → username: admin');
      }
      await q(`INSERT INTO settings(k,v) VALUES('admin_pw_applied',$1) ON CONFLICT (k) DO UPDATE SET v=$1`, [fp]);
    }
  }
}

// ---------- meta ----------
// technicians are shared by every brand; `busy` = brands where they have an open job right now
const techList = async () => {
  const r = (await q(`SELECT u.id,u.name, s.brand_id, b.name brand, s.ticket_no FROM users u
    LEFT JOIN services s ON (s.technician_id=u.id OR s.helper_id=u.id) AND s.status=ANY($1::text[])
    LEFT JOIN brands b ON b.id=s.brand_id WHERE u.role='Technician' AND u.active ORDER BY u.name, s.id`, [OPEN_ST])).rows;
  const m = new Map();
  for (const x of r) {
    const t = m.get(x.id) || { id: x.id, name: x.name, busy: [] }; m.set(x.id, t);
    if (x.brand_id && !t.busy.some(z => z.brand_id === x.brand_id)) t.busy.push({ brand_id: x.brand_id, brand: x.brand, ticket_no: x.ticket_no });
  }
  return [...m.values()];
};
app.get('/api/meta', wrap(async (req, res) => {
  const ag = await q(`SELECT id,name FROM users WHERE role IN ('${SUPER}','Admin','Sales') AND active ORDER BY name`);
  let it = { rows: [] }; try { it = await q('SELECT id,name FROM issue_types ORDER BY id'); } catch (e) { /* table missing: fall back to defaults */ }
  const ISSUE_TYPES = it.rows, JT = (await q('SELECT id,name FROM job_types ORDER BY id')).rows, brands = (await q('SELECT id,name FROM brands ORDER BY id')).rows;
  res.json({ SERVICE_TYPES: ISSUE_TYPES.length ? ISSUE_TYPES.map(r => r.name) : SERVICE_TYPES, ISSUE_TYPES, JOB_TYPES: JT.map(r => r.name), JOB_TYPE_ROWS: JT, brands, VISIT_TYPES, STATUSES, APPROVALS, BANKS, ROLES, PERMS, DEFAULTS, TECH_KEYS, LEAD_STAGES, LEAD_PRIORITIES, LEAD_SOURCES, LEAD_INTERESTS, LEAVE_TYPES, technicians: await techList(), agents: ag.rows });
}));

// issue types (for services) and job types (for jobs): add = Super Admin or "Add issue types & job types"; delete = Super Admin only
for (const [path, table, label] of [['/api/issue-types', 'issue_types', 'issue type'], ['/api/job-types', 'job_types', 'job type']]) {
  app.post(path, need('types'), wrap(async (req, res) => {
    const name = String((req.body || {}).name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!name) return res.status(400).json({ error: 'Enter the ' + label });
    if ((await q(`SELECT 1 FROM ${table} WHERE lower(name)=lower($1)`, [name])).rows.length) return res.status(409).json({ error: `That ${label} already exists` });
    await q(`INSERT INTO ${table}(name) VALUES($1)`, [name]); res.json({ ok: true });
  }));
  app.delete(path + '/:id', superOnly, wrap(async (req, res) => { await q(`DELETE FROM ${table} WHERE id=$1`, [req.params.id]); res.json({ ok: true }); }));
}

// brands: only the Super Admin adds / renames / deletes
app.post('/api/brands', superOnly, wrap(async (req, res) => {
  const name = String((req.body || {}).name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!name) return res.status(400).json({ error: 'Enter the brand name' });
  if ((await q('SELECT 1 FROM brands WHERE lower(name)=lower($1)', [name])).rows.length) return res.status(409).json({ error: 'That brand already exists' });
  await q('INSERT INTO brands(name) VALUES($1)', [name]); res.json({ ok: true });
}));
app.delete('/api/brands/:id', superOnly, wrap(async (req, res) => {
  const id = +req.params.id;
  const u = (await q('SELECT (SELECT COUNT(*) FROM services WHERE brand_id=$1)::int s, (SELECT COUNT(*) FROM users WHERE brand_id=$1)::int u', [id])).rows[0];
  if (u.s || u.u) return res.status(400).json({ error: `This brand still has ${u.s} ticket(s) and ${u.u} staff. Move or delete them first.` });
  if ((await q('SELECT COUNT(*)::int n FROM brands')).rows[0].n <= 1) return res.status(400).json({ error: 'Keep at least one brand' });
  await q('DELETE FROM brands WHERE id=$1', [id]); res.json({ ok: true });
}));

// typing a phone number: show customers / leads that already have it
app.get('/api/lookup', wrap(async (req, res) => {
  const dg = digits(req.query.phone), out = { customers: [], leads: [] };
  if (dg.length < 5) return res.json(out);
  if (can(req.user, 'customers') || can(req.user, 'service_create'))
    out.customers = (await q(`SELECT c.id,c.name,c.phone,c.address,(SELECT COUNT(*) FROM services s WHERE s.customer_id=c.id)::int tickets FROM customers c WHERE regexp_replace(COALESCE(c.phone,''),'[^0-9]','','g') LIKE '%'||$1||'%' ORDER BY c.name LIMIT 3`, [dg])).rows;
  if (can(req.user, 'leads'))
    out.leads = (await q(`SELECT id,name,phone,stage FROM leads WHERE regexp_replace(COALESCE(phone,''),'[^0-9]','','g') LIKE '%'||$1||'%' ORDER BY id DESC LIMIT 3`, [dg])).rows;
  res.json(out);
}));

// ---------- team ----------
// Super Admin manages everyone. Anybody else with "Team" can only manage Sales and Technician staff.
const brandFor = async (role, v) => {
  if (role === SUPER || role === 'Technician') return { id: null };
  const id = Number.isInteger(+v) && +v > 0 ? +v : null;
  if (id && !(await q('SELECT 1 FROM brands WHERE id=$1', [id])).rows.length) return { error: 'Brand not found' };
  if (role === 'Admin' && !id) return { error: 'Choose the brand this admin staff works for' };
  return { id };
};
const manages = (me, role) => isSuper(me) || !['Admin', SUPER].includes(role);
app.get('/api/users', need('team'), wrap(async (_, res) => res.json((await q('SELECT u.*, b.name brand FROM users u LEFT JOIN brands b ON b.id=u.brand_id ORDER BY u.active DESC, u.role, u.name')).rows.map(pub))));
app.post('/api/users', need('team'), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.email || !b.phone) return res.status(400).json({ error: 'Name, email and phone are required' });
  if (!ROLES.includes(b.role)) return res.status(400).json({ error: 'Choose a role' });
  if (!manages(req.user, b.role)) return res.status(403).json({ error: 'Only the Super Admin can add admin staff' });
  const br = await brandFor(b.role, b.brand_id); if (br.error) return res.status(400).json({ error: br.error });
  const base = (b.name.trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9]/g, '') || b.role.toLowerCase().replace(/\W/g, ''));
  let username;
  for (let i = 0; i < 20; i++) { username = base + crypto.randomInt(100, 999); if (!(await q('SELECT 1 FROM users WHERE username=$1', [username])).rows.length) break; }
  const password = randPw();
  const r = await q('INSERT INTO users(name,email,phone,role,username,password_hash,permissions,brand_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    [b.name.trim(), b.email.trim(), b.phone.trim(), b.role, username, hash(password), cleanPerms(b.role, b.permissions), br.id]);
  res.json({ user: pub(r.rows[0]), credentials: { username, password } });
}));
app.patch('/api/users/:id', need('team'), wrap(async (req, res) => {
  const b = req.body || {}, cur = (await q('SELECT * FROM users WHERE id=$1', [req.params.id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const role = ROLES.includes(b.role) ? b.role : cur.role;
  if (!manages(req.user, cur.role) || !manages(req.user, role)) return res.status(403).json({ error: 'Only the Super Admin can change admin staff' });
  if (cur.id === req.user.id && (b.active === false || role !== cur.role)) return res.status(400).json({ error: "You can't deactivate yourself or change your own role" });
  const br = await brandFor(role, b.brand_id !== undefined ? b.brand_id : cur.brand_id); if (br.error) return res.status(400).json({ error: br.error });
  await q('UPDATE users SET name=$1,email=$2,phone=$3,role=$4,permissions=$5,active=$6,brand_id=$7 WHERE id=$8',
    [b.name || cur.name, b.email ?? cur.email, b.phone ?? cur.phone, role, cleanPerms(role, b.permissions ?? cur.permissions), b.active ?? cur.active, br.id, cur.id]);
  res.json({ ok: true });
}));
app.post('/api/users/:id/reset', need('team'), wrap(async (req, res) => {
  const u = (await q('SELECT * FROM users WHERE id=$1', [req.params.id])).rows[0];
  if (!u) return res.status(404).json({ error: 'Not found' });
  if (!manages(req.user, u.role)) return res.status(403).json({ error: 'Only the Super Admin can reset admin passwords' });
  const password = randPw(); await q('UPDATE users SET password_hash=$1 WHERE id=$2', [hash(password), u.id]);
  res.json({ credentials: { username: u.username, password }, user: pub(u) });
}));
app.delete('/api/users/:id', superOnly, wrap(async (req, res) => {
  const id = +req.params.id; if (id === req.user.id) return res.status(400).json({ error: "You can't delete yourself" });
  const open = (await q(`SELECT COUNT(*)::int n FROM services WHERE (technician_id=$1 OR helper_id=$1) AND status=ANY($2::text[])`, [id, OPEN_ST])).rows[0].n;
  if (open) return res.status(400).json({ error: `This person still has ${open} open job(s). Reassign them first.` });
  await q('DELETE FROM attendance WHERE user_id=$1', [id]); await q('DELETE FROM leave_requests WHERE user_id=$1', [id]);
  await q('DELETE FROM notifications WHERE user_id=$1', [id]); await q('DELETE FROM push_subs WHERE user_id=$1', [id]);
  await q('DELETE FROM users WHERE id=$1', [id]); res.json({ ok: true });
}));

// ---------- services ----------
const SELECT = `SELECT s.*, c.name customer, c.phone, c.email, c.address, c.city, c.lat, c.lng, c.map_url, c.location_by, c.location_on, t.name technician, h.name helper,
  COALESCE(pp.given,0) given, br.name brand
  FROM services s LEFT JOIN customers c ON c.id=s.customer_id LEFT JOIN brands br ON br.id=s.brand_id
  LEFT JOIN (SELECT service_id, SUM(amount) given FROM payments WHERE approval<>'Rejected' GROUP BY service_id) pp ON pp.service_id=s.id
  LEFT JOIN users t ON t.id=s.technician_id LEFT JOIN users h ON h.id=s.helper_id`;
// technicians: only their own jobs (any brand). Staff tied to a brand: only that brand. Super Admin / staff with no brand: everything.
const scope = (u, p, w) => {
  if (isTech(u)) { p.push(u.id); w.push(`(s.technician_id=$${p.length} OR s.helper_id=$${p.length})`); }
  else if (u.brand_id) { p.push(u.brand_id); w.push(`s.brand_id=$${p.length}`); }
};
const brandOK = (u, s) => isTech(u) || !u.brand_id || s.brand_id === u.brand_id;
const shape = (s, u) => {
  if (!can(u, 'view_phone')) { delete s.phone; delete s.email; }
  if (!can(u, 'view_charges')) { delete s.charges_applied; delete s.discount; delete s.given; }
  return s;
};
const log = (id, by, changes) => changes ? q('INSERT INTO service_history(service_id,done_by,changes) VALUES($1,$2,$3)', [id, by || 'System', changes]) : null;
const pushTo = async (uid, title, body, sid, extra = {}) => {
  const subs = (await q('SELECT * FROM push_subs WHERE user_id=$1', [uid])).rows, payload = JSON.stringify({ title, body, sid, url: '/?job=' + (sid || ''), ...extra });
  await Promise.all(subs.map(s => webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 86400, urgency: 'high' })
    .catch(e => (e.statusCode === 404 || e.statusCode === 410) ? q('DELETE FROM push_subs WHERE id=$1', [s.id]) : console.error('push failed', e.statusCode || e.message))));
};
const notify = async (ids, title, body, sid) => {
  for (const id of [...new Set(ids)].filter(Boolean)) { await q('INSERT INTO notifications(user_id,title,body,service_id) VALUES($1,$2,$3,$4)', [id, title, body, sid]); pushTo(id, title, body, sid).catch(() => {}); }
};
// who hears about a job: the Super Admin(s) + admin staff of that job's brand (or admin staff with no brand)
const admins = async brandId => (await q(`SELECT id FROM users WHERE active AND (role=$1 OR (role='Admin' AND (brand_id IS NULL OR brand_id=$2)))`, [SUPER, brandId || 0])).rows.map(r => r.id);
const tm = () => new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
const money = v => Math.max(0, Number(v) || 0);
const svcAccess = need('services', 'dashboard');
const mine = async (req, res) => {           // loads a service the caller may touch
  const s = (await q(`${SELECT} WHERE s.id=$1`, [req.params.id])).rows[0];
  if (!s) { res.status(404).json({ error: 'Not found' }); return null; }
  if (isTech(req.user) && s.technician_id !== req.user.id && s.helper_id !== req.user.id) { res.status(403).json({ error: 'Not your job' }); return null; }
  if (!isTech(req.user) && !can(req.user, 'services')) { res.status(403).json({ error: 'Not allowed' }); return null; }
  if (!brandOK(req.user, s)) { res.status(403).json({ error: 'This ticket belongs to another brand' }); return null; }
  return s;
};

app.get('/api/customers', need('customers', 'service_create'), wrap(async (req, res) => {
  res.json((await q(`SELECT c.*, (SELECT COUNT(*)::int FROM services s WHERE s.customer_id=c.id) tickets FROM customers c
    WHERE c.name ILIKE $1 OR c.phone ILIKE $1 ORDER BY c.name LIMIT 100`, ['%' + (req.query.q || '') + '%'])).rows);
}));

app.get('/api/dashboard', need('dashboard'), wrap(async (req, res) => {
  const p = [], w = []; scope(req.user, p, w);
  if (!req.user.brand_id && +req.query.brand) { p.push(+req.query.brand); w.push(`s.brand_id=$${p.length}`); }
  const W = w.length ? 'WHERE ' + w.join(' AND ') : '', A = w.length ? ' AND ' + w.join(' AND ') : '';
  const one = async sql => (await q(sql, p)).rows[0];
  const k = await one(`SELECT COUNT(*)::int total,
    COUNT(*) FILTER (WHERE status='New Ticket')::int new_tickets,
    COUNT(*) FILTER (WHERE status='Work Not Started')::int assigned,
    COUNT(*) FILTER (WHERE status='On-Process')::int on_process,
    COUNT(*) FILTER (WHERE status='Work Pending')::int pending,
    COUNT(*) FILTER (WHERE status='Awaiting Payment')::int awaiting,
    COUNT(*) FILTER (WHERE status='Resolved' AND resolved_on>=date_trunc('month',now()))::int resolved_month,
    COUNT(*) FILTER (WHERE approval='Pending' AND status='Resolved')::int approvals_pending,
    COUNT(*) FILTER (WHERE kind='Job' AND status NOT IN ('Resolved','Cancelled'))::int open_jobs,
    COALESCE(SUM(charges_applied-discount) FILTER (WHERE status<>'Cancelled'),0) billed FROM services s ${W}`);
  const paid = await one(`SELECT COALESCE(SUM(y.amount),0) paid FROM payments y JOIN services s ON s.id=y.service_id WHERE y.approval<>'Rejected'${A}`);
  const pm = await one(`SELECT COALESCE(SUM(y.amount),0) paid FROM payments y JOIN services s ON s.id=y.service_id WHERE y.approval<>'Rejected' AND y.paid_on>=date_trunc('month',now())${A}`);
  const byType = (await q(`SELECT service_type name, COUNT(*)::int n FROM services s ${W} GROUP BY 1 ORDER BY n DESC`, p)).rows;
  const load = (await q(`SELECT u.name, COUNT(s.id)::int n, string_agg(DISTINCT b.name, ', ') brands FROM users u LEFT JOIN services s ON s.technician_id=u.id AND s.status IN ('Work Not Started','On-Process','Work Pending') LEFT JOIN brands b ON b.id=s.brand_id WHERE u.role='Technician' AND u.active GROUP BY u.id ORDER BY n DESC, u.name`)).rows;
  const recent = (await q(`${SELECT} ${W} ORDER BY s.submitted_on DESC LIMIT 5`, p)).rows.map(s => shape(s, req.user));
  const out = { ...k, byType, load, recent };
  if (can(req.user, 'view_charges')) Object.assign(out, { paid: paid.paid, paid_month: pm.paid, outstanding: Math.max(0, k.billed - paid.paid) }); else delete out.billed;
  res.json(out);
}));

app.get('/api/services/counts', wrap(async (req, res) => {
  const { type, tech, kind, brand, q: search } = req.query, p = [], w = []; scope(req.user, p, w);   // counts follow the same filters as the list
  const add = (c, v) => { p.push(v); w.push(c.replace('?', '$' + p.length)); };
  if (type) add('s.service_type=?', type);
  if (kind) add(`COALESCE(s.kind,'Service')=?`, kind);
  if (brand && !req.user.brand_id && !isTech(req.user)) add('s.brand_id=?', +brand);
  if (tech && !isTech(req.user)) add('s.technician_id=?', tech);
  if (search) { p.push('%' + search + '%'); const n = p.length; p.push(String(search).replace(/\D/g, '')); w.push(`(c.name ILIKE $${n} OR s.request_details ILIKE $${n} OR c.phone ILIKE $${n} OR s.ticket_no::text=$${n + 1})`); }
  const r = await q(`SELECT s.status, COUNT(*)::int n FROM services s LEFT JOIN customers c ON c.id=s.customer_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} GROUP BY s.status`, p);
  const out = { ALL: 0 }; r.rows.forEach(x => { out[x.status] = x.n; out.ALL += x.n; }); res.json(out);
}));

app.get('/api/services', wrap(async (req, res) => {
  if (!isTech(req.user) && !can(req.user, 'services')) return res.status(403).json({ error: 'Not allowed' });
  const { status, type, tech, approval, kind, brand, q: search } = req.query, w = [], p = [];
  scope(req.user, p, w);
  const add = (c, v) => { p.push(v); w.push(c.replace('?', '$' + p.length)); };
  if (status && status !== 'ALL') add('s.status=?', status);
  if (type) add('s.service_type=?', type);
  if (kind) add(`COALESCE(s.kind,'Service')=?`, kind);
  if (brand && !req.user.brand_id && !isTech(req.user)) add('s.brand_id=?', +brand);
  if (tech && !isTech(req.user)) add('s.technician_id=?', tech);
  if (approval) add('s.approval=?', approval);
  if (search) { p.push('%' + search + '%'); const n = p.length; p.push(search.replace(/\D/g, '')); w.push(`(c.name ILIKE $${n} OR s.request_details ILIKE $${n} OR c.phone ILIKE $${n} OR s.ticket_no::text=$${n + 1})`); }
  if (req.query.board) {   // pipeline view: every open ticket + the latest 15 resolved
    const base = w.length ? w.join(' AND ') + ' AND ' : '';
    const o = await q(`${SELECT} WHERE ${base}s.status NOT IN ('Resolved','Cancelled') ORDER BY s.submitted_on DESC LIMIT 400`, p);
    const d = await q(`${SELECT} WHERE ${base}s.status='Resolved' ORDER BY s.resolved_on DESC NULLS LAST LIMIT 15`, p);
    return res.json([...o.rows, ...d.rows].map(s => shape(s, req.user)));
  }
  const r = await q(`${SELECT} ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY s.submitted_on DESC LIMIT 200`, p);
  res.json(r.rows.map(s => shape(s, req.user)));
}));

app.get('/api/services/:id', wrap(async (req, res) => {
  const s = await mine(req, res); if (!s) return;
  const [pay, hist, ph] = await Promise.all([
    can(req.user, 'view_charges') ? q('SELECT * FROM payments WHERE service_id=$1 ORDER BY id DESC', [s.id]) : { rows: [] },
    q('SELECT * FROM service_history WHERE service_id=$1 ORDER BY id DESC', [s.id]),
    q('SELECT id,stage,caption,uploaded_by,created_at FROM service_photos WHERE service_id=$1 ORDER BY id', [s.id])]);
  let previous = [];
  try {   // this customer's earlier tickets with what was done and when
    previous = (await q(`SELECT s2.id,s2.ticket_no,s2.status,s2.service_type,s2.request_details,s2.submitted_on,s2.resolved_on,s2.completion_note,t.name technician FROM services s2 LEFT JOIN users t ON t.id=s2.technician_id WHERE s2.customer_id=$1 AND s2.id<>$2 ORDER BY s2.submitted_on DESC LIMIT 15`, [s.customer_id, s.id])).rows;
    if (previous.length) {
      const by = {}; (await q('SELECT service_id,done_by,done_on,changes FROM service_history WHERE service_id=ANY($1) ORDER BY id', [previous.map(p => p.id)])).rows.forEach(h => (by[h.service_id] = by[h.service_id] || []).push(h));
      previous.forEach(p => { p.history = (by[p.id] || []).slice(-12); });
    }
  } catch (e) { console.error('previous services failed', e.message); previous = []; }
  res.json({ ...shape(s, req.user), payments: pay.rows, history: hist.rows, photos: ph.rows, previous });
}));

app.post('/api/services', need('service_create'), wrap(async (req, res) => {
  const b = req.body; let cid = b.customer_id;
  const kind = b.kind === 'Job' ? 'Job' : 'Service';
  if (!String(b.service_type || '').trim()) return res.status(400).json({ error: kind === 'Job' ? 'Choose the job type' : 'Choose the issue type' });
  // staff tied to a brand always create for their own brand (e.g. Heaven); Super Admin picks the brand
  let brandId = req.user.brand_id || (Number.isInteger(+b.brand_id) && +b.brand_id > 0 ? +b.brand_id : null);
  if (brandId && !(await q('SELECT 1 FROM brands WHERE id=$1', [brandId])).rows.length) return res.status(400).json({ error: 'Brand not found' });
  if (!brandId) brandId = (await q(`SELECT id FROM brands ORDER BY (lower(name)='heaven') DESC, id LIMIT 1`)).rows[0].id;
  if (cid) { if (!(await q('SELECT 1 FROM customers WHERE id=$1', [cid])).rows.length) return res.status(400).json({ error: 'Customer not found' }); }
  if (!cid) {
    b.name = String(b.name || '').trim(); b.phone = String(b.phone || '').trim();
    if (!b.name) return res.status(400).json({ error: 'Customer name is required' });
    if (digits(b.phone).length < 7) return res.status(400).json({ error: 'Enter a valid phone number' });
    const m = /@(-?\d+\.\d+),(-?\d+\.\d+)|[?&](?:q|ll|query)=(-?\d+\.\d+),(-?\d+\.\d+)/.exec(b.map_url || '');
    cid = (await q('INSERT INTO customers(name,phone,email,address,map_url,lat,lng) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [b.name, b.phone, b.email, b.address, b.map_url || null, m ? +(m[1] || m[3]) : null, m ? +(m[2] || m[4]) : null])).rows[0].id;
  }
  const ticket = 100000 + crypto.randomInt(899999);
  const r = await q(`INSERT INTO services(ticket_no,customer_id,product,request_details,service_type,visit_type,charges_applied,kind,brand_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [ticket, cid, b.product, b.request_details, b.service_type || 'Other', b.visit_type || 'Onsite', b.charges_applied || 0, kind, brandId]);
  await log(r.rows[0].id, req.user.name, (kind === 'Job' ? 'Job' : 'Ticket') + ' created');
  res.json({ id: r.rows[0].id, ticket_no: ticket });
}));

app.patch('/api/services/:id', need('service_edit', 'service_assign'), wrap(async (req, res) => {
  const id = req.params.id, b = { ...req.body }, cur = (await q('SELECT * FROM services WHERE id=$1', [id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'Not found' });
  if (!brandOK(req.user, cur)) return res.status(403).json({ error: 'This ticket belongs to another brand' });
  // a technician busy on another brand's open job can't be taken by this brand until that job is finished
  for (const k of ['technician_id', 'helper_id']) {
    if (!can(req.user, 'service_assign') || !b[k] || String(b[k]) === String(cur[k] || '')) continue;
    const busy = (await q(`SELECT s.ticket_no, br.name brand, u.name FROM services s LEFT JOIN brands br ON br.id=s.brand_id JOIN users u ON u.id=$1
      WHERE (s.technician_id=$1 OR s.helper_id=$1) AND s.status=ANY($2::text[]) AND s.brand_id IS DISTINCT FROM $3 AND s.id<>$4 LIMIT 1`, [+b[k], OPEN_ST, cur.brand_id, cur.id])).rows[0];
    if (busy) return res.status(409).json({ error: `${busy.name} is already allocated to ${busy.brand || 'another brand'} (job #${busy.ticket_no}). They can be assigned again once that job is done.` });
  }
  const assignKeys = ['technician_id', 'helper_id'], canEdit = can(req.user, 'service_edit'), canAssign = can(req.user, 'service_assign');
  const fields = ['status', 'approval', 'service_type', 'visit_type', 'product', 'request_details', 'charges_applied', 'location', ...assignKeys];
  const sets = [], p = [], changes = [];
  const names = {};
  for (const r of (await q('SELECT id,name FROM users')).rows) names[r.id] = r.name;
  if (canAssign && 'technician_id' in b && String(b.technician_id || '') !== String(cur.technician_id || '')) {
    if (b.technician_id && cur.status === 'New Ticket' && (!b.status || b.status === 'New Ticket')) b.status = 'Work Not Started';
    if (!b.technician_id && cur.status === 'Work Not Started' && (!b.status || b.status === 'Work Not Started')) b.status = 'New Ticket';
    sets.push('assigned_on=now()');
  }
  if (canAssign && b.technician_id && cur.technician_id && String(b.technician_id) !== String(cur.technician_id) && ['On-Process', 'Work Pending'].includes(cur.status) && !b.status) b.status = 'Work Not Started';   // new person starts fresh
  if (b.status === 'Resolved' && cur.status !== 'Resolved' && !can(req.user, 'payments')) delete b.status;
  const fTech = canAssign && 'technician_id' in b ? (b.technician_id ? Number(b.technician_id) : null) : cur.technician_id;
  const fHelp = canAssign && 'helper_id' in b ? (b.helper_id ? Number(b.helper_id) : null) : cur.helper_id;
  const removed = [cur.technician_id, cur.helper_id].filter(x => x && x !== fTech && x !== fHelp);
  const newTech = canAssign && b.technician_id && String(b.technician_id) !== String(cur.technician_id) ? b.technician_id : null;
  const newHelp = canAssign && b.helper_id && String(b.helper_id) !== String(cur.helper_id) ? b.helper_id : null;
  for (const f of fields) {
    if (!(f in b)) continue;
    if (assignKeys.includes(f) ? !canAssign : !canEdit && !(f === 'status' && canAssign)) continue;
    if (String(b[f] ?? '') === String(cur[f] ?? '')) continue;
    p.push(b[f] === '' ? null : b[f]); sets.push(`${f}=$${p.length}`);
    changes.push(assignKeys.includes(f) ? `${f === 'technician_id' ? 'technician' : 'helper'}: ${names[cur[f]] || '-'} → ${names[b[f]] || '-'}` : `${f}: ${cur[f] ?? '-'} → ${b[f] || '-'}`);
  }
  if (sets.length) { p.push(id); await q(`UPDATE services SET ${sets.join(',')} WHERE id=$${p.length}`, p); await log(id, req.user.name, changes.join('; ')); }
  if (newTech || newHelp || removed.length) {
    const c = (await q('SELECT name FROM customers WHERE id=$1', [cur.customer_id])).rows[0];
    if (newTech || newHelp) await notify([newTech, newHelp], 'New job assigned', `#${cur.ticket_no} · ${c ? c.name : ''} — open My Jobs to start`, cur.id);
    if (removed.length) await notify(removed, 'Service reallocated', `#${cur.ticket_no} · ${c ? c.name : ''} — this service was allocated to another person`, null);
  }
  res.json({ ok: true });
}));

// ----- technician step-by-step flow -----
app.post('/api/services/:id/start', techOnly, wrap(async (req, res) => {
  const s = await mine(req, res); if (!s) return;
  if (!['New Ticket', 'Work Not Started', 'Work Pending'].includes(s.status)) return res.status(400).json({ error: 'This job cannot be started now' });
  await q(`UPDATE services SET status='On-Process', work_status='Started', work_started_on=COALESCE(work_started_on,now()), on_process_at=now() WHERE id=$1`, [s.id]);
  await log(s.id, req.user.name, 'Work started');
  await notify(await admins(s.brand_id), 'Work started', `${req.user.name} started #${s.ticket_no} (${s.customer}) at ${tm()}`, s.id); res.json({ ok: true });
}));
app.post('/api/services/:id/photos', techOnly, wrap(async (req, res) => {
  const s = await mine(req, res); if (!s) return;
  if (s.status !== 'On-Process') return res.status(400).json({ error: 'Start the work before adding photos' });
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(req.body.image || '');
  if (!m) return res.status(400).json({ error: 'Invalid image' });
  const buf = Buffer.from(m[2], 'base64'); if (buf.length > 3e6) return res.status(400).json({ error: 'Image too large' });
  const stage = ['Before', 'During', 'After', 'Report', 'Payment'].includes(req.body.stage) ? req.body.stage : 'During';
  await q('INSERT INTO service_photos(service_id,stage,caption,mime,data,uploaded_by) VALUES($1,$2,$3,$4,$5,$6)', [s.id, stage, req.body.caption || null, m[1], buf, req.user.name]);
  await log(s.id, req.user.name, `Photo uploaded (${stage})`); res.json({ ok: true });
}));
app.post('/api/services/:id/pending', techOnly, wrap(async (req, res) => {
  const s = await mine(req, res); if (!s) return;
  if (s.status !== 'On-Process') return res.status(400).json({ error: 'Job is not in progress' });
  const reason = String(req.body.reason || '').trim(), rec = money(req.body.received);
  if (!reason) return res.status(400).json({ error: 'Please give a reason' });
  await q(`UPDATE services SET status='Work Pending', work_status='Pending', pending_reason=$2, amount_received=amount_received+$3 WHERE id=$1`, [s.id, reason, rec]);
  await log(s.id, req.user.name, 'Marked pending: ' + reason + (rec ? ` · received ₹${rec}` : ''));
  await notify(await admins(s.brand_id), 'Work pending', `${req.user.name} marked #${s.ticket_no} pending: ${reason}${rec ? ` · collected ₹${rec}` : ''}`, s.id); res.json({ ok: true });
}));
app.post('/api/services/:id/done', techOnly, wrap(async (req, res) => {
  const s = await mine(req, res); if (!s) return;
  if (s.status !== 'On-Process') return res.status(400).json({ error: 'Job is not in progress' });
  if (REPORT_PHOTO_REQUIRED && !(await q(`SELECT 1 FROM service_photos WHERE service_id=$1 AND stage='Report' LIMIT 1`, [s.id])).rows.length)
    return res.status(400).json({ error: 'Add a photo of the report book before finishing' });
  // Free or Paid? Paid → Cash (amount) or Bank (amount + transfer screenshot)
  const b = req.body, billing = b.billing;
  if (!['Free', 'Paid'].includes(billing)) return res.status(400).json({ error: 'Choose Free service or Paid service' });
  let mode = null, amt = 0;
  if (billing === 'Paid') {
    mode = b.mode;
    if (!['Cash', 'Bank'].includes(mode)) return res.status(400).json({ error: 'Choose how the customer paid: Cash or Bank' });
    amt = money(b.amount);
    if (amt <= 0) return res.status(400).json({ error: mode === 'Cash' ? 'Enter the cash amount received' : 'Enter the amount transferred' });
    if (mode === 'Bank' && !(await q(`SELECT 1 FROM service_photos WHERE service_id=$1 AND stage='Payment' LIMIT 1`, [s.id])).rows.length)
      return res.status(400).json({ error: 'Upload the bank transfer screenshot for confirmation' });
  }
  const cash = mode === 'Cash' ? amt : 0, bank = mode === 'Bank' ? amt : 0;
  await q(`UPDATE services SET status='Awaiting Payment', work_status='Done', completion_note=$2, pending_reason=NULL, amount_received=amount_received+$3, billing_type=$4, pay_mode=$5, bank_amount=$6 WHERE id=$1`,
    [s.id, b.note || null, cash, billing, mode, bank]);
  const what = billing === 'Free' ? 'Free service' : mode === 'Cash' ? `Paid · Cash ₹${amt}` : `Paid · Bank ₹${amt} (screenshot attached)`;
  await log(s.id, req.user.name, 'Work done' + (b.note ? ': ' + b.note : '') + ' · ' + what);
  const adminMsg = billing === 'Free' ? `${req.user.name} finished #${s.ticket_no} as a FREE service. Confirm to close.`
    : mode === 'Cash' ? `${req.user.name} finished #${s.ticket_no}. Cash collected ₹${Number(s.amount_received) + cash} in total. Confirm once handed over.`
    : `${req.user.name} finished #${s.ticket_no}. Customer paid ₹${amt} by bank — check the screenshot and confirm.`;
  await notify(await admins(s.brand_id), 'Work done — payment pending', adminMsg, s.id); res.json({ ok: true });
}));
// technician taps Call / WhatsApp on a job they are assigned to (kept in the job history)
app.post('/api/services/:id/contact', techOnly, wrap(async (req, res) => {
  const s = await mine(req, res); if (!s) return;
  if (['Resolved', 'Cancelled'].includes(s.status)) return res.status(400).json({ error: 'This job is closed' });
  await log(s.id, req.user.name, (req.body.how === 'WhatsApp' ? 'WhatsApp' : 'Call') + ' to customer'); res.json({ ok: true });
}));
app.post('/api/services/:id/location', techOnly, wrap(async (req, res) => {
  const s = await mine(req, res); if (!s) return;
  const lat = Number(req.body.lat), lng = Number(req.body.lng);
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return res.status(400).json({ error: 'Invalid location' });
  await q('UPDATE customers SET lat=$1,lng=$2,map_url=$3,location_by=$4,location_on=now() WHERE id=$5', [lat, lng, `https://www.google.com/maps?q=${lat},${lng}`, req.user.name, s.customer_id]);
  await log(s.id, req.user.name, 'Customer location updated from site GPS'); res.json({ ok: true });
}));
app.post('/api/services/:id/settle', need('payments'), wrap(async (req, res) => {
  const s = (await q('SELECT * FROM services WHERE id=$1', [req.params.id])).rows[0];
  if (!s) return res.status(404).json({ error: 'Not found' });
  if (!brandOK(req.user, s)) return res.status(403).json({ error: 'This ticket belongs to another brand' });
  const cashDue = Math.max(0, Number(s.amount_received) - Number(s.received_settled)), bankDue = Math.max(0, Number(s.bank_amount || 0) - Number(s.bank_settled || 0)), close = s.status === 'Awaiting Payment';
  if (!close && cashDue <= 0 && bankDue <= 0) return res.status(400).json({ error: 'Nothing to settle' });
  const b = req.body || {}, cashBank = BANKS.includes(b.bank) ? b.bank : null, trBank = BANKS.includes(b.transfer_bank) ? b.transfer_bank : null;
  if (bankDue > 0 && !trBank) return res.status(400).json({ error: 'Choose the bank account that received the transfer' });
  if (cashDue > 0) await q(`INSERT INTO payments(service_id,amount,bank,note,approval) VALUES($1,$2,$3,'Cash handed over by technician','Approved')`, [s.id, cashDue, cashBank]);
  if (bankDue > 0) await q(`INSERT INTO payments(service_id,amount,bank,note,approval) VALUES($1,$2,$3,'Bank transfer · screenshot verified','Approved')`, [s.id, bankDue, trBank]);
  await q(`UPDATE services SET received_settled=amount_received, bank_settled=COALESCE(bank_amount,0)${close ? `, status='Resolved', resolved_on=now(), approval='Approved'` : ''} WHERE id=$1`, [s.id]);
  const parts = [cashDue > 0 && `cash ₹${cashDue} from technician`, bankDue > 0 && `bank ₹${bankDue} confirmed`].filter(Boolean).join(' + ');
  await log(s.id, req.user.name, (parts ? `Payment received: ${parts}` : 'Free service confirmed') + (close ? ' — work completed' : ''));
  await notify([s.technician_id, s.helper_id], close ? 'Job closed' : 'Payment received', `#${s.ticket_no}: admin confirmed ${parts || 'the job'}${close ? ' — work completed' : ''}`, s.id); res.json({ ok: true });
}));
app.get('/api/tech/dashboard', techOnly, wrap(async (req, res) => {
  const id = req.user.id;
  const k = (await q(`SELECT COUNT(*) FILTER (WHERE status IN ('New Ticket','Work Not Started'))::int todo, COUNT(*) FILTER (WHERE status='Work Pending')::int pending,
    COUNT(*) FILTER (WHERE status='On-Process')::int progress, COUNT(*) FILTER (WHERE status='Awaiting Payment')::int awaiting,
    COUNT(*) FILTER (WHERE status='Resolved')::int done_total,
    COUNT(*) FILTER (WHERE status='Resolved' AND resolved_on>=date_trunc('month',now()))::int done_month,
    COUNT(*) FILTER (WHERE status='Resolved' AND resolved_on>=date_trunc('day',now()))::int done_today
    FROM services WHERE technician_id=$1 OR helper_id=$1`, [id])).rows[0];
  const c = (await q(`SELECT COALESCE(SUM(amount_received-received_settled),0) hold, COALESCE(SUM(received_settled),0) handed FROM services WHERE technician_id=$1`, [id])).rows[0];
  const next = (await q(`${SELECT} WHERE (s.technician_id=$1 OR s.helper_id=$1) AND s.status IN ('New Ticket','Work Not Started','On-Process','Work Pending') ORDER BY (s.status='On-Process') DESC, s.assigned_on DESC NULLS LAST LIMIT 5`, [id])).rows.map(s => shape(s, req.user));
  res.json({ ...k, hold: c.hold, handed: c.handed, next });
}));
// Super Admin: delete old data (choose what). Team logins, brands, issue & job types stay.
const WIPE = {
  services: 'TRUNCATE services, customers, payments, service_history, service_photos RESTART IDENTITY CASCADE',
  leads: 'TRUNCATE leads, lead_activity RESTART IDENTITY CASCADE',
  todos: 'TRUNCATE todos RESTART IDENTITY',
  attendance: 'TRUNCATE attendance, leave_requests RESTART IDENTITY',
  notifications: 'TRUNCATE notifications RESTART IDENTITY',
  users: 'SELECT 1',   // staff logins: handled below
};
app.post('/api/admin/reset-data', superOnly, wrap(async (req, res) => {
  const b = req.body || {};
  if (b.confirm !== 'DELETE') return res.status(400).json({ error: 'Type DELETE to confirm' });
  const what = (Array.isArray(b.what) && b.what.length ? b.what : Object.keys(WIPE).filter(k => k !== 'users')).filter(k => WIPE[k]);
  if (!what.length) return res.status(400).json({ error: 'Choose what to delete' });
  for (const k of what) await q(WIPE[k]);
  if (what.includes('users')) {   // remove every login except the Super Admin(s); their data goes with them
    const gone = (await q(`SELECT id FROM users WHERE role<>$1`, [SUPER])).rows.map(r => r.id);
    if (gone.length) {
      for (const t of ['attendance', 'leave_requests', 'notifications', 'push_subs']) await q(`DELETE FROM ${t} WHERE user_id=ANY($1::int[])`, [gone]);
      await q(`DELETE FROM todos WHERE for_user=ANY($1::int[]) OR created_by=ANY($1::int[])`, [gone]);
      await q(`UPDATE services SET technician_id=NULL WHERE technician_id=ANY($1::int[])`, [gone]);
      await q(`UPDATE services SET helper_id=NULL WHERE helper_id=ANY($1::int[])`, [gone]);
      await q(`UPDATE leads SET assigned_to=NULL WHERE assigned_to=ANY($1::int[])`, [gone]);
      await q(`DELETE FROM users WHERE id=ANY($1::int[])`, [gone]);
    }
  }
  if (what.includes('attendance')) await q(`UPDATE settings SET v=to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') WHERE k='att_start'`);
  res.json({ ok: true, deleted: what });
}));
app.delete('/api/services/:id', superOnly, wrap(async (req, res) => {
  await q('DELETE FROM notifications WHERE service_id=$1', [req.params.id]);
  await q('DELETE FROM services WHERE id=$1', [req.params.id]); res.json({ ok: true });
}));
app.delete('/api/customers/:id', superOnly, wrap(async (req, res) => {
  const ids = (await q('SELECT id FROM services WHERE customer_id=$1', [req.params.id])).rows.map(r => r.id);
  if (ids.length) { await q('DELETE FROM notifications WHERE service_id=ANY($1::int[])', [ids]); await q('DELETE FROM services WHERE id=ANY($1::int[])', [ids]); }
  await q('UPDATE leads SET customer_id=NULL WHERE customer_id=$1', [req.params.id]);
  await q('DELETE FROM customers WHERE id=$1', [req.params.id]); res.json({ ok: true, tickets: ids.length });
}));
app.get('/api/push/key', (req, res) => res.json({ key: VAPID_PUB }));
app.post('/api/push/subscribe', wrap(async (req, res) => {
  const s = req.body || {}; if (!s.endpoint || !s.keys) return res.status(400).json({ error: 'Invalid subscription' });
  await q('INSERT INTO push_subs(user_id,endpoint,p256dh,auth) VALUES($1,$2,$3,$4) ON CONFLICT (endpoint) DO UPDATE SET user_id=$1,p256dh=$3,auth=$4', [req.user.id, s.endpoint, s.keys.p256dh, s.keys.auth]);
  res.json({ ok: true });
}));
app.post('/api/push/unsubscribe', wrap(async (req, res) => { await q('DELETE FROM push_subs WHERE endpoint=$1 AND user_id=$2', [(req.body || {}).endpoint, req.user.id]); res.json({ ok: true }); }));
app.get('/api/notifications', wrap(async (req, res) => {
  const items = (await q('SELECT * FROM notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 30', [req.user.id])).rows;
  const unread = (await q('SELECT COUNT(*)::int n FROM notifications WHERE user_id=$1 AND NOT read', [req.user.id])).rows[0].n;
  res.json({ unread, items });
}));
app.post('/api/notifications/read', wrap(async (req, res) => { await q('UPDATE notifications SET read=true WHERE user_id=$1', [req.user.id]); res.json({ ok: true }); }));
app.get('/api/photos/:id', wrap(async (req, res) => {
  const r = (await q(`SELECT p.mime,p.data,s.technician_id,s.helper_id,s.brand_id FROM service_photos p JOIN services s ON s.id=p.service_id WHERE p.id=$1`, [req.params.id])).rows[0];
  if (!r) return res.status(404).end();
  if (isTech(req.user) ? ![r.technician_id, r.helper_id].includes(req.user.id) : (!can(req.user, 'services') || !brandOK(req.user, r))) return res.status(403).end();
  res.set({ 'Content-Type': r.mime, 'Cache-Control': 'private, max-age=86400' }).send(r.data);
}));

const brandGuard = wrap(async (req, res, next) => {
  const s = (await q('SELECT brand_id FROM services WHERE id=$1', [req.params.id])).rows[0];
  if (!s) return res.status(404).json({ error: 'Not found' });
  if (!brandOK(req.user, s)) return res.status(403).json({ error: 'This ticket belongs to another brand' });
  next();
});
app.post('/api/services/:id/payments', need('payments'), brandGuard, wrap(async (req, res) => {
  const b = req.body;
  await q('INSERT INTO payments(service_id,amount,bank,paid_on,note) VALUES($1,$2,$3,COALESCE($4,CURRENT_DATE),$5)', [req.params.id, b.amount, b.bank, b.paid_on || null, b.note]);
  await log(req.params.id, req.user.name, `Payment ₹${b.amount} added (${b.bank || 'n/a'})`); res.json({ ok: true });
}));
app.post('/api/services/:id/discount', need('payments'), brandGuard, wrap(async (req, res) => {
  await q('UPDATE services SET discount=$1 WHERE id=$2', [req.body.discount || 0, req.params.id]);
  await log(req.params.id, req.user.name, `Discount set to ₹${req.body.discount}`); res.json({ ok: true });
}));

// ---------- to-do list + scheduled voice messages ----------
// Every item has a date + time (India time). On that day it shows in the To-do list,
// and at that time the person gets a reminder (bell + phone push).
const TZ = 'Asia/Kolkata';
const AUDIO_RE = /^data:(audio\/(?:webm|ogg|mp4|mpeg|aac|x-m4a|m4a|wav|x-wav))(?:;[^,]*)?;base64,(.+)$/;
async function initTodos() {
  try {
    await q(`
    CREATE TABLE IF NOT EXISTS todos (id SERIAL PRIMARY KEY, title TEXT, note TEXT, kind TEXT DEFAULT 'task', audio BYTEA, mime TEXT, duration INT DEFAULT 0,
      due_at TIMESTAMPTZ NOT NULL, for_user INT, created_by INT, done BOOLEAN DEFAULT false, done_at TIMESTAMPTZ, done_by TEXT, reminded BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT now());
    CREATE INDEX IF NOT EXISTS idx_todos_due ON todos(due_at);
    CREATE INDEX IF NOT EXISTS idx_todos_rem ON todos(reminded, done);
    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS todo_id INT;`);
  } catch (e) { console.error('todo schema failed:', e.message); }
}
const TSEL = `SELECT t.id,t.title,t.note,t.kind,t.mime,t.duration,t.due_at,to_char(t.due_at AT TIME ZONE '${TZ}','YYYY-MM-DD') due_date,to_char(t.due_at AT TIME ZONE '${TZ}','HH24:MI') due_time,
  t.for_user,t.created_by,t.done,t.done_at,t.done_by,t.reminded,t.created_at,fu.name for_name,cu.name by_name FROM todos t LEFT JOIN users fu ON fu.id=t.for_user LEFT JOIN users cu ON cu.id=t.created_by`;
const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const isTime = v => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));
// admin sees everything; everybody else sees what is for them or what they created
const tScope = (u, p) => { if (isSuper(u)) return 'true'; p.push(u.id); return `(t.for_user=$${p.length} OR t.created_by=$${p.length})`; };
const todayIST = async () => (await q(`SELECT to_char(now() AT TIME ZONE '${TZ}','YYYY-MM-DD') d`)).rows[0].d;
const loadTodo = async (req, res) => {
  const t = (await q(`${TSEL} WHERE t.id=$1`, [req.params.id])).rows[0];
  if (!t) { res.status(404).json({ error: 'Not found' }); return null; }
  if (!isSuper(req.user) && t.for_user !== req.user.id && t.created_by !== req.user.id) { res.status(403).json({ error: 'Not allowed' }); return null; }
  return t;
};

// one day: voice messages + tasks + lead follow-ups (+ overdue when looking at today)
app.get('/api/todos', wrap(async (req, res) => {
  const today = await todayIST(), date = isDate(req.query.date) ? req.query.date : today, isToday = date === today;
  const p = [date], w = tScope(req.user, p);
  const items = (await q(`${TSEL} WHERE ${w} AND (t.due_at AT TIME ZONE '${TZ}')::date=$1::date ORDER BY t.done, t.due_at, t.id`, p)).rows;
  let overdue = [];
  if (isToday) { const p2 = [date], w2 = tScope(req.user, p2); overdue = (await q(`${TSEL} WHERE ${w2} AND NOT t.done AND (t.due_at AT TIME ZONE '${TZ}')::date<$1::date ORDER BY t.due_at LIMIT 50`, p2)).rows; }
  let leads = [];
  if (can(req.user, 'leads')) {
    const lp = [date]; let lw = `l.stage IN ('New Enquiry','Contacted','Site Visit','Quotation','Negotiation') AND l.follow_up ${isToday ? '<=' : '='} $1::date`;
    if (!isBoss(req.user)) { lp.push(req.user.id); lw += ` AND (l.assigned_to=$2 OR l.assigned_to IS NULL)`; }
    leads = (await q(`${LSEL} WHERE ${lw} ORDER BY l.follow_up, l.priority='Hot' DESC, l.id DESC LIMIT 100`, lp)).rows;
  }
  let jobs = [];
  if (isTech(req.user) && isToday)
    jobs = (await q(`${SELECT} WHERE (s.technician_id=$1 OR s.helper_id=$1) AND s.status IN ('New Ticket','Work Not Started','On-Process','Work Pending') ORDER BY (s.status='On-Process') DESC, s.assigned_on DESC NULLS LAST LIMIT 20`, [req.user.id])).rows.map(s => shape(s, req.user));
  res.set('Cache-Control', 'no-store').json({ date, today, items, overdue, leads, jobs });
}));

// small dots on the date strip: how many open items each day has
app.get('/api/todos/days', wrap(async (req, res) => {
  const from = isDate(req.query.from) ? req.query.from : await todayIST(), to = isDate(req.query.to) ? req.query.to : from;
  const p = [from, to], w = tScope(req.user, p), out = {};
  (await q(`SELECT to_char(t.due_at AT TIME ZONE '${TZ}','YYYY-MM-DD') d, COUNT(*) FILTER (WHERE NOT t.done)::int n, COUNT(*) FILTER (WHERE t.kind='voice' AND NOT t.done)::int v
    FROM todos t WHERE ${w} AND (t.due_at AT TIME ZONE '${TZ}')::date BETWEEN $1::date AND $2::date GROUP BY 1`, p)).rows.forEach(r => { out[r.d] = { n: r.n, v: r.v, l: 0 }; });
  if (can(req.user, 'leads')) {
    const lp = [from, to]; let lw = '';
    if (!isBoss(req.user)) { lp.push(req.user.id); lw = ' AND (assigned_to=$3 OR assigned_to IS NULL)'; }
    (await q(`SELECT to_char(follow_up,'YYYY-MM-DD') d, COUNT(*)::int n FROM leads WHERE stage IN ('New Enquiry','Contacted','Site Visit','Quotation','Negotiation') AND follow_up BETWEEN $1::date AND $2::date${lw} GROUP BY 1`, lp)).rows
      .forEach(r => { (out[r.d] = out[r.d] || { n: 0, v: 0, l: 0 }).l = r.n; });
  }
  res.set('Cache-Control', 'no-store').json(out);
}));

app.get('/api/todos/:id', wrap(async (req, res) => { const t = await loadTodo(req, res); if (t) res.json(t); }));

app.get('/api/todos/:id/audio', wrap(async (req, res) => {
  const t = await loadTodo(req, res); if (!t) return;
  const r = (await q('SELECT audio, mime FROM todos WHERE id=$1', [t.id])).rows[0];
  if (!r || !r.audio) return res.status(404).end();
  res.set({ 'Content-Type': r.mime || 'audio/webm', 'Cache-Control': 'private, max-age=86400', 'Accept-Ranges': 'bytes' });
  const total = r.audio.length, m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m) {   // Safari/iPhone needs range requests to play audio
    const start = m[1] ? +m[1] : 0, end = m[2] ? Math.min(+m[2], total - 1) : total - 1;
    return res.status(206).set({ 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': end - start + 1 }).send(r.audio.subarray(start, end + 1));
  }
  res.send(r.audio);
}));

app.post('/api/todos', wrap(async (req, res) => {
  const b = req.body || {};
  if (!isDate(b.due_date)) return res.status(400).json({ error: 'Choose the date' });
  if (!isTime(b.due_time)) return res.status(400).json({ error: 'Choose the time' });
  let audio = null, mime = null;
  if (b.audio) {
    const m = AUDIO_RE.exec(b.audio);
    if (!m) return res.status(400).json({ error: 'Unsupported voice recording' });
    audio = Buffer.from(m[2], 'base64'); mime = m[1];
    if (audio.length > 6e6) return res.status(400).json({ error: 'Voice message is too long (max ~5 minutes)' });
  }
  const title = String(b.title || '').trim().slice(0, 200), note = String(b.note || '').trim().slice(0, 2000) || null;
  if (!audio && !title) return res.status(400).json({ error: 'Write the task or record a voice message' });
  let forUser = Number.isInteger(+b.for_user) && +b.for_user > 0 ? +b.for_user : req.user.id;
  if (forUser !== req.user.id && !isBoss(req.user)) forUser = req.user.id;   // only Super Admin / Admin staff can give work to others
  if (!(await q('SELECT 1 FROM users WHERE id=$1 AND active', [forUser])).rows.length) return res.status(400).json({ error: 'Person not found' });
  const r = await q(`INSERT INTO todos(title,note,kind,audio,mime,duration,due_at,for_user,created_by,reminded)
    VALUES($1,$2,$3,$4,$5,$6,($7::date + $8::time) AT TIME ZONE '${TZ}',$9,$10,(($7::date + $8::time) AT TIME ZONE '${TZ}') < now() - interval '1 minute') RETURNING id`,
    [title || null, note, audio ? 'voice' : 'task', audio, mime, Math.max(0, Math.min(3600, Math.round(+b.duration || 0))), b.due_date, b.due_time, forUser, req.user.id]);
  if (forUser !== req.user.id) notifyTodo([forUser], audio ? '🎙 New voice message' : '📝 New task', `${req.user.name} scheduled ${audio ? 'a voice message' : '“' + title + '”'} for ${b.due_date} ${b.due_time}`, r.rows[0].id).catch(() => {});
  res.json({ id: r.rows[0].id });
}));

app.patch('/api/todos/:id', wrap(async (req, res) => {
  const t = await loadTodo(req, res); if (!t) return;
  const b = req.body || {}, sets = [], p = [];
  const put = (sql, v) => { p.push(v); sets.push(sql.replace(/\?/g, '$' + p.length)); };
  if (b.done !== undefined) { put('done=?', !!b.done); sets.push(b.done ? 'done_at=now()' : 'done_at=NULL'); put('done_by=?', b.done ? req.user.name : null); }
  if (b.title !== undefined) put('title=?', String(b.title || '').trim().slice(0, 200) || null);
  if (b.note !== undefined) put('note=?', String(b.note || '').trim().slice(0, 2000) || null);
  if (b.due_date !== undefined || b.due_time !== undefined) {
    const d = b.due_date ?? t.due_date, tm2 = b.due_time ?? t.due_time;
    if (!isDate(d) || !isTime(tm2)) return res.status(400).json({ error: 'Choose a valid date and time' });
    p.push(d); const a = p.length; p.push(tm2); const c = p.length;
    sets.push(`due_at=($${a}::date + $${c}::time) AT TIME ZONE '${TZ}'`, `reminded=(($${a}::date + $${c}::time) AT TIME ZONE '${TZ}') < now() - interval '1 minute'`);
  }
  if (b.for_user !== undefined && isBoss(req.user) && Number.isInteger(+b.for_user) && +b.for_user > 0) put('for_user=?', +b.for_user);
  if (!sets.length) return res.json({ ok: true });
  p.push(t.id); await q(`UPDATE todos SET ${sets.join(',')} WHERE id=$${p.length}`, p);
  if (b.done && t.created_by && t.created_by !== req.user.id) notifyTodo([t.created_by], '✅ Task done', `${req.user.name} finished: ${t.title || 'voice message'}`, t.id).catch(() => {});
  res.json({ ok: true });
}));

app.delete('/api/todos/:id', superOnly, wrap(async (req, res) => {
  const t = await loadTodo(req, res); if (!t) return;
  await q('DELETE FROM todos WHERE id=$1', [t.id]); res.json({ ok: true });
}));

const notifyTodo = async (ids, title, body, todoId) => {
  for (const id of [...new Set(ids)].filter(Boolean)) {
    await q('INSERT INTO notifications(user_id,title,body,todo_id) VALUES($1,$2,$3,$4)', [id, title, body, todoId]);
    pushTo(id, title, body, null, { url: '/?todo=' + todoId, todo: todoId, tag: 'gz-todo-' + todoId }).catch(() => {});
  }
};
// reminder clock: every 30 s, anything whose time has come gets a reminder (once)
let remBusy = false;
async function remindDue() {
  if (remBusy) return; remBusy = true;
  try {
    const due = (await q(`UPDATE todos SET reminded=true WHERE id IN (SELECT id FROM todos WHERE NOT reminded AND NOT done AND due_at<=now() ORDER BY due_at LIMIT 50)
      RETURNING id,title,kind,duration,COALESCE(for_user,created_by) uid,to_char(due_at AT TIME ZONE '${TZ}','HH24:MI') hm`)).rows;
    for (const t of due) {
      const title = t.kind === 'voice' ? '🎙 Voice message reminder' : '⏰ To-do reminder';
      const body = (t.title || (t.kind === 'voice' ? `Voice message (${Math.floor(t.duration / 60)}:${String(t.duration % 60).padStart(2, '0')}) — tap to listen` : 'Task')) + ` · ${t.hm}`;
      await notifyTodo([t.uid], title, body, t.id);
    }
    if (due.length) VER = Math.max(VER + 1, Date.now());
  } catch (e) { console.error('reminders failed', e.message); } finally { remBusy = false; }
}

// ---------- attendance, leave & permission ----------
// Check in / out works only inside the office radius. Outside (or no GPS) → the person sends an
// "Attendance request" with the time + reason, and an approver marks it. Leave = full days, Permission = morning / evening.
// Approvers: Super Admin, every Admin staff, and anyone given "Team attendance".
const isMonth = v => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || ''));
const daysOf = m => { const [y, mo] = m.split('-').map(Number), n = new Date(Date.UTC(y, mo, 0)).getUTCDate(); return Array.from({ length: n }, (_, i) => `${m}-${String(i + 1).padStart(2, '0')}`); };
const wday = s => new Date(s + 'T00:00:00Z').getUTCDay();   // 0 = Sunday
const MARKS = ['Present', 'Half Day', 'Absent', 'Week Off', 'Holiday'];
const KINDS = ['Leave', 'Permission', 'Attendance'];
const canAtt = u => isBoss(u) || can(u, 'attendance');
const attNeed = (req, res, next) => canAtt(req.user) ? next() : res.status(403).json({ error: 'Not allowed' });
const attStart = async () => ((await q(`SELECT v FROM settings WHERE k='att_start'`)).rows[0] || {}).v || '2000-01-01';
const office = async () => { try { return { ...OFFICE_DEFAULT, ...JSON.parse(((await q(`SELECT v FROM settings WHERE k='office'`)).rows[0] || {}).v || '{}') }; } catch (e) { return OFFICE_DEFAULT; } };
const istHM = t => t ? new Date(t).toLocaleTimeString('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: true }) : null;
const ist24 = t => t ? new Date(t).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : null;
const metres = (a, b, c, d) => { const R = 6371000, r = x => x * Math.PI / 180, dl = r(c - a), dg = r(d - b), h = Math.sin(dl / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dg / 2) ** 2; return Math.round(2 * R * Math.asin(Math.sqrt(h))); };
const distTxt = m => m == null ? '' : m < 1000 ? m + ' m' : (m / 1000).toFixed(1) + ' km';
const approvers = async () => (await q(`SELECT id FROM users WHERE active AND (role=$1 OR role='Admin' OR 'attendance'=ANY(permissions))`, [SUPER])).rows.map(r => r.id);
const notifyLink = async (ids, title, body, link) => {
  for (const id of [...new Set(ids)].filter(Boolean)) {
    await q('INSERT INTO notifications(user_id,title,body,link) VALUES($1,$2,$3,$4)', [id, title, body, link]);
    pushTo(id, title, body, null, { url: '/?att=' + link, att: link, tag: 'gz-att-' + Date.now() }).catch(() => {});
  }
};
const hrs = (a, b) => a && b ? Math.max(0, (new Date(b) - new Date(a)) / 36e5) : 0;
// the coloured calendar of one person for one month
async function monthFor(u, m, today, start, off) {
  const days = daysOf(m), from = days[0], to = days[days.length - 1];
  const recs = {}; (await q(`SELECT *, to_char(day,'YYYY-MM-DD') d FROM attendance WHERE user_id=$1 AND day BETWEEN $2 AND $3`, [u.id, from, to])).rows.forEach(r => { recs[r.d] = r; });
  const reqs = (await q(`SELECT *, to_char(from_date,'YYYY-MM-DD') f, to_char(to_date,'YYYY-MM-DD') t FROM leave_requests WHERE user_id=$1 AND status IN ('Pending','Approved') AND from_date<=$3 AND to_date>=$2 ORDER BY id`, [u.id, from, to])).rows;
  const joined = u.created_at ? new Date(u.created_at).toLocaleDateString('en-CA', { timeZone: TZ }) : start, first = joined > start ? joined : start;
  const out = days.map(d => {
    const r = recs[d], sun = wday(d) === 0, on = reqs.filter(x => x.f <= d && x.t >= d);
    const lv = on.find(x => x.kind === 'Leave' && x.status === 'Approved'), pm = on.filter(x => x.kind === 'Permission' && x.status === 'Approved'), pend = on.find(x => x.status === 'Pending');
    let code = '';
    if (r && r.marked_by && !['Present'].includes(r.status)) code = { 'Half Day': 'half', Absent: 'absent', 'Week Off': 'off', Holiday: 'holiday' }[r.status] || 'present';
    else if (lv && !sun && !(r && r.check_in)) code = 'leave';
    else if (pm.length) code = pm.some(x => x.session === 'Morning') ? (pm.some(x => x.session === 'Evening') ? 'perm-both' : 'perm-m') : 'perm-e';
    else if (r) code = r.status === 'Half Day' ? 'half' : r.status === 'Absent' ? 'absent' : 'present';
    else if (sun) code = 'off';
    else if (d < today && d >= first) code = 'absent';
    else if (d === today) code = 'today';
    const inT = r && r.check_in, late = !!(inT && off.late && ist24(inT) > off.late && !pm.some(x => x.session === 'Morning'));
    return { d, sun, code, pending: !!pend, pend_kind: pend ? pend.kind : null, in: istHM(inT), out: istHM(r && r.check_out), in24: ist24(inT), out24: ist24(r && r.check_out),
      hours: +hrs(inT, r && r.check_out).toFixed(2), late, in_dist: r ? r.in_dist : null, out_dist: r ? r.out_dist : null,
      status: r ? r.status : null, note: r ? r.note : null, by: r ? r.marked_by : null,
      leave: lv ? (lv.leave_type || 'Leave') : null, perm: pm.map(x => ({ session: x.session, from: x.from_time, to: x.to_time })), counts: d >= first && d <= today };
  });
  const S = { present: 0, half: 0, absent: 0, leave: 0, perm_m: 0, perm_e: 0, off: 0, working: 0, late: 0, hours: 0 };
  for (const x of out) {
    if (!x.counts) continue;
    if (!x.sun && x.code !== 'holiday' && x.code !== 'off') S.working++;
    if (['present', 'perm-m', 'perm-e', 'perm-both'].includes(x.code) && (x.in || x.status === 'Present')) S.present++;
    if (x.code === 'half') S.half++;
    if (x.code === 'absent') S.absent++;
    if (x.code === 'leave') S.leave++;
    if (x.code === 'off' || x.code === 'holiday') S.off++;
    if (x.perm.some(p => p.session === 'Morning')) S.perm_m++;
    if (x.perm.some(p => p.session === 'Evening')) S.perm_e++;
    if (x.late) S.late++;
    S.hours += x.hours;
  }
  S.hours = +S.hours.toFixed(1);
  S.pending = reqs.filter(x => x.status === 'Pending').length;
  return { days: out, summary: S, requests: reqs.map(({ f, t, ...x }) => ({ ...x, from_date: f, to_date: t })) };
}

app.get('/api/attendance/today', wrap(async (req, res) => {
  const today = await todayIST(), off = await office();
  const r = (await q(`SELECT * FROM attendance WHERE user_id=$1 AND day=$2`, [req.user.id, today])).rows[0];
  const pend = (await q(`SELECT id, from_time, to_time FROM leave_requests WHERE user_id=$1 AND kind='Attendance' AND status='Pending' AND from_date=$2 LIMIT 1`, [req.user.id, today])).rows[0];
  res.set('Cache-Control', 'no-store').json({ today, now: new Date().toISOString(), check_in: r && r.check_in, check_out: r && r.check_out, in: istHM(r && r.check_in), out: istHM(r && r.check_out),
    status: r ? r.status : null, by: r ? r.marked_by : null, office: off, anywhere: isSuper(req.user), pending: pend || null });
}));
// is this phone at the office? (accuracy slack up to 100 m so weak indoor GPS still works)
const atOffice = async (u, b) => {
  const off = await office(), lat = Number(b.lat), lng = Number(b.lng), acc = Math.min(100, Math.max(0, Number(b.acc) || 0));
  const has = b.lat != null && b.lat !== '' && isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  const dist = has ? metres(off.lat, off.lng, lat, lng) : null;
  if (isSuper(u)) return { ok: true, lat: has ? lat : null, lng: has ? lng : null, dist };
  if (!has) return { ok: false, code: 'nogps', error: 'Location is off. Turn on GPS and allow location for this app, or send an attendance request.' };
  if (dist - acc > off.radius) return { ok: false, code: 'outside', dist, error: `You are ${distTxt(dist)} away from the office. Check in / out works only within ${off.radius} m of the office. Send an attendance request with the reason.` };
  return { ok: true, lat, lng, dist };
};
app.post('/api/attendance/check-in', wrap(async (req, res) => {
  const today = await todayIST(), g = await atOffice(req.user, req.body || {});
  if (!g.ok) return res.status(400).json({ error: g.error, code: g.code, distance: g.dist });
  const cur = (await q(`SELECT * FROM attendance WHERE user_id=$1 AND day=$2`, [req.user.id, today])).rows[0];
  if (cur && cur.check_in) return res.status(400).json({ error: 'You already checked in today at ' + istHM(cur.check_in) });
  await q(`INSERT INTO attendance(user_id,day,status,check_in,in_lat,in_lng,in_dist) VALUES($1,$2,'Present',now(),$3,$4,$5)
    ON CONFLICT (user_id,day) DO UPDATE SET check_in=now(), in_lat=$3, in_lng=$4, in_dist=$5, status=CASE WHEN attendance.status IN ('Absent','Week Off','Holiday') THEN 'Present' ELSE attendance.status END, updated_at=now()`, [req.user.id, today, g.lat, g.lng, g.dist]);
  res.json({ ok: true, distance: g.dist });
}));
app.post('/api/attendance/check-out', wrap(async (req, res) => {
  const today = await todayIST();
  const cur = (await q(`SELECT * FROM attendance WHERE user_id=$1 AND day=$2`, [req.user.id, today])).rows[0];
  if (!cur || !cur.check_in) return res.status(400).json({ error: 'Check in first' });
  if (cur.check_out) return res.status(400).json({ error: 'You already checked out at ' + istHM(cur.check_out) });
  const g = await atOffice(req.user, req.body || {});
  if (!g.ok) return res.status(400).json({ error: g.error, code: g.code, distance: g.dist });
  await q(`UPDATE attendance SET check_out=now(), out_lat=$2, out_lng=$3, out_dist=$4, updated_at=now() WHERE id=$1`, [cur.id, g.lat, g.lng, g.dist]); res.json({ ok: true, distance: g.dist });
}));
app.get('/api/attendance/office', wrap(async (req, res) => res.json(await office())));
app.post('/api/attendance/office', superOnly, wrap(async (req, res) => {
  const b = req.body || {}, cur = await office(); let lat = Number(b.lat), lng = Number(b.lng);
  if (b.map_url) {
    const u = String(b.map_url), m = /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/.exec(u) || /@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(u) || /[?&](?:q|ll|query|destination)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/.exec(u) || /^\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*$/.exec(u);
    if (!m) return res.status(400).json({ error: 'Could not read the location from that link. Open the link, copy the address-bar URL (it contains @lat,lng), or tap "Use my current location" at the office.' });
    lat = +m[1]; lng = +m[2];
  }
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return res.status(400).json({ error: 'Invalid location' });
  const radius = Math.max(30, Math.min(2000, Math.round(+b.radius || cur.radius)));
  const late = isTime(b.late) ? b.late : cur.late, name = String(b.name || cur.name).trim().slice(0, 120) || cur.name;
  await q(`INSERT INTO settings(k,v) VALUES('office',$1) ON CONFLICT (k) DO UPDATE SET v=$1`, [JSON.stringify({ name, lat, lng, radius, late })]);
  res.json({ ok: true });
}));
app.get('/api/attendance/month', wrap(async (req, res) => {
  const today = await todayIST(), m = isMonth(req.query.month) ? req.query.month : today.slice(0, 7);
  const uid = +req.query.user || req.user.id;
  if (uid !== req.user.id && !canAtt(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const u = (await q('SELECT id,name,role,created_at FROM users WHERE id=$1', [uid])).rows[0];
  if (!u) return res.status(404).json({ error: 'Not found' });
  res.set('Cache-Control', 'no-store').json({ user: { id: u.id, name: u.name, role: u.role }, month: m, today, ...(await monthFor(u, m, today, await attStart(), await office())) });
}));
app.get('/api/attendance/report', attNeed, wrap(async (req, res) => {
  const today = await todayIST(), m = isMonth(req.query.month) ? req.query.month : today.slice(0, 7), start = await attStart(), off = await office();
  const users = (await q(`SELECT u.id,u.name,u.role,u.created_at,b.name brand FROM users u LEFT JOIN brands b ON b.id=u.brand_id WHERE u.active AND u.role<>$1 ORDER BY u.role, u.name`, [SUPER])).rows;
  const rows = [];
  for (const u of users) {
    const x = await monthFor(u, m, today, start, off), td = x.days.find(d => d.d === today);
    rows.push({ id: u.id, name: u.name, role: u.role, brand: u.brand, ...x.summary, today: td ? { code: td.code, in: td.in, out: td.out, late: td.late } : null });
  }
  res.set('Cache-Control', 'no-store').json({ month: m, today, rows });
}));
// dashboard: who is on leave / permission today, who is in, what is waiting for approval
app.get('/api/attendance/board', attNeed, wrap(async (req, res) => {
  const today = await todayIST(), off = await office();
  const staff = (await q(`SELECT u.id,u.name,u.role,b.name brand FROM users u LEFT JOIN brands b ON b.id=u.brand_id WHERE u.active AND u.role<>$1 ORDER BY u.name`, [SUPER])).rows;
  const att = {}; (await q(`SELECT * FROM attendance WHERE day=$1`, [today])).rows.forEach(r => { att[r.user_id] = r; });
  const tr = (await q(`${LSELR} WHERE r.status='Approved' AND r.kind IN ('Leave','Permission') AND r.from_date<=$1 AND r.to_date>=$1 ORDER BY r.kind, r.session, u.name`, [today])).rows;
  const pending = (await q(`${LSELR} WHERE r.status='Pending' ORDER BY r.created_at LIMIT 20`)).rows;
  const leave = tr.filter(r => r.kind === 'Leave'), perm = tr.filter(r => r.kind === 'Permission'), away = new Set(leave.map(r => r.user_id));
  const sunday = wday(today) === 0;
  const inn = staff.filter(u => att[u.id] && att[u.id].check_in).map(u => ({ ...u, in: istHM(att[u.id].check_in), out: istHM(att[u.id].check_out), late: ist24(att[u.id].check_in) > off.late }));
  const notIn = sunday ? [] : staff.filter(u => !(att[u.id] && att[u.id].check_in) && !away.has(u.id) && !(att[u.id] && ['Week Off', 'Holiday', 'Absent'].includes(att[u.id].status)));
  res.set('Cache-Control', 'no-store').json({ today, total: staff.length, inn, notIn, leave, perm, pending, late: off.late });
}));
app.post('/api/attendance/mark', attNeed, wrap(async (req, res) => {
  const b = req.body || {}, uid = +b.user_id;
  if (!isDate(b.date)) return res.status(400).json({ error: 'Choose the date' });
  if (b.date > await todayIST()) return res.status(400).json({ error: 'You can’t mark a future date' });
  if (!(await q('SELECT 1 FROM users WHERE id=$1', [uid])).rows.length) return res.status(404).json({ error: 'Person not found' });
  if (!b.status && !b.in_time && !b.out_time) {   // clearing a day removes the record → Super Admin only
    if (!isSuper(req.user)) return res.status(403).json({ error: 'Only the Super Admin can clear a day' });
    await q('DELETE FROM attendance WHERE user_id=$1 AND day=$2', [uid, b.date]); return res.json({ ok: true });
  }
  const st = b.status || 'Present';
  if (!MARKS.includes(st)) return res.status(400).json({ error: 'Choose a status' });
  const it = isTime(b.in_time) ? b.in_time : null, ot = isTime(b.out_time) ? b.out_time : null;
  if (it && ot && ot <= it) return res.status(400).json({ error: 'Check-out time must be after check-in time' });
  const note = String(b.note || '').trim().slice(0, 300) || null;
  await setAtt(uid, b.date, st, it, ot, note, req.user.name);
  res.json({ ok: true });
}));
// write a day: times are India time on that date
async function setAtt(uid, date, status, inT, outT, note, by) {
  const ts = t => t ? `(($2::date + '${t}'::time) AT TIME ZONE '${TZ}')` : null;
  await q(`INSERT INTO attendance(user_id,day,status,note,marked_by,check_in,check_out) VALUES($1,$2,$3,$4,$5,${ts(inT) || 'NULL'},${ts(outT) || 'NULL'})
    ON CONFLICT (user_id,day) DO UPDATE SET status=$3, note=COALESCE($4,attendance.note), marked_by=$5, updated_at=now()
    ${inT ? `, check_in=${ts(inT)}` : ''}${outT ? `, check_out=${ts(outT)}` : ''}`, [uid, date, status, note, by]);
}

const LSELR = `SELECT r.*, to_char(r.from_date,'YYYY-MM-DD') from_date, to_char(r.to_date,'YYYY-MM-DD') to_date, u.name, u.role FROM leave_requests r JOIN users u ON u.id=r.user_id`;
const reqWhen = r => r.kind === 'Permission' ? `${r.session} permission on ${fdIN(r.from_date)}${r.from_time ? ` (${r.from_time}${r.to_time ? '–' + r.to_time : ''})` : ''}`
  : r.kind === 'Attendance' ? `attendance on ${fdIN(r.from_date)}: ${[r.from_time && 'in ' + r.from_time, r.to_time && 'out ' + r.to_time].filter(Boolean).join(', ')}`
  : `${r.leave_type || 'Leave'} ${fdIN(r.from_date)}${r.to_date !== r.from_date ? ' → ' + fdIN(r.to_date) : ''}`;
const fdIN = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', weekday: 'short' });
app.get('/api/leave', wrap(async (req, res) => {
  const all = req.query.all && canAtt(req.user), p = [], w = [];
  if (!all) { p.push(req.user.id); w.push(`r.user_id=$${p.length}`); }
  if (['Pending', 'Approved', 'Rejected', 'Cancelled'].includes(req.query.status)) { p.push(req.query.status); w.push(`r.status=$${p.length}`); }
  if (isMonth(req.query.month)) { p.push(req.query.month + '-01'); w.push(`r.to_date>=$${p.length}::date AND r.from_date<($${p.length}::date + interval '1 month')`); }
  res.set('Cache-Control', 'no-store').json((await q(`${LSELR} ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY (r.status='Pending') DESC, r.from_date DESC, r.id DESC LIMIT 300`, p)).rows);
}));
app.post('/api/leave', wrap(async (req, res) => {
  const b = req.body || {}, kind = KINDS.includes(b.kind) ? b.kind : 'Leave', reason = String(b.reason || '').trim().slice(0, 500), today = await todayIST();
  const from = b.from_date, to = kind === 'Leave' ? (b.to_date || b.from_date) : b.from_date;
  if (!isDate(from) || !isDate(to)) return res.status(400).json({ error: 'Choose the date' });
  if (to < from) return res.status(400).json({ error: 'The end date is before the start date' });
  if ((new Date(to) - new Date(from)) / 864e5 > 60) return res.status(400).json({ error: 'A leave can be at most 60 days. Apply in parts.' });
  if (!reason) return res.status(400).json({ error: 'Write the reason' });
  let session = null, ft = null, tt = null, lt = null, lat = null, lng = null, dist = null;
  if (kind === 'Permission') {
    session = ['Morning', 'Evening'].includes(b.session) ? b.session : null;
    if (!session) return res.status(400).json({ error: 'Choose Morning permission or Evening permission' });
    ft = isTime(b.from_time) ? b.from_time : null; tt = isTime(b.to_time) ? b.to_time : null;
    if (ft && tt && tt <= ft) return res.status(400).json({ error: 'The end time must be after the start time' });
  } else if (kind === 'Attendance') {
    if (from > today) return res.status(400).json({ error: 'An attendance request can only be for today or an earlier day' });
    ft = isTime(b.from_time) ? b.from_time : null; tt = isTime(b.to_time) ? b.to_time : null;
    if (!ft && !tt) return res.status(400).json({ error: 'Enter the check-in time, the check-out time, or both' });
    if (ft && tt && tt <= ft) return res.status(400).json({ error: 'Check-out time must be after check-in time' });
    const off = await office(); lat = isFinite(+b.lat) && b.lat != null ? +b.lat : null; lng = isFinite(+b.lng) && b.lng != null ? +b.lng : null;
    if (lat != null && lng != null) dist = metres(off.lat, off.lng, lat, lng);
  } else lt = LEAVE_TYPES.includes(b.leave_type) ? b.leave_type : 'Casual Leave';
  const clash = (await q(`SELECT kind, session, to_char(from_date,'DD Mon') f FROM leave_requests WHERE user_id=$1 AND status IN ('Pending','Approved') AND from_date<=$3 AND to_date>=$2
    AND (CASE WHEN $4='Attendance' THEN kind='Attendance' AND status='Pending' ELSE kind<>'Attendance' AND (kind='Leave' OR $4='Leave' OR session=$5) END) LIMIT 1`, [req.user.id, from, to, kind, session])).rows[0];
  if (clash) return res.status(409).json({ error: `You already have a ${clash.kind.toLowerCase()}${clash.session ? ' (' + clash.session + ')' : ''} request on ${clash.f}` });
  const r = await q(`INSERT INTO leave_requests(user_id,kind,leave_type,session,from_date,to_date,from_time,to_time,reason,lat,lng,distance) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [req.user.id, kind, lt, session, from, to, ft, tt, reason, lat, lng, dist]);
  const title = kind === 'Permission' ? '🕘 Permission request' : kind === 'Attendance' ? '📍 Attendance request' : '🌴 Leave request';
  await notifyLink((await approvers()).filter(id => id !== req.user.id), title, `${req.user.name}: ${reqWhen({ kind, session, from_date: from, to_date: to, from_time: ft, to_time: tt, leave_type: lt })}${dist != null ? ` (${distTxt(dist)} from office)` : ''} — ${reason}`, 'leave');
  res.json({ id: r.rows[0].id });
}));
app.post('/api/leave/:id/decide', attNeed, wrap(async (req, res) => {
  const b = req.body || {}, st = b.status;
  if (!['Approved', 'Rejected'].includes(st)) return res.status(400).json({ error: 'Approve or reject' });
  const r = (await q(`${LSELR} WHERE r.id=$1`, [req.params.id])).rows[0];
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (r.user_id === req.user.id && !isSuper(req.user)) return res.status(403).json({ error: 'Someone else has to approve your own request' });
  if (r.status === 'Cancelled') return res.status(400).json({ error: 'This request was cancelled' });
  const note = String(b.note || '').trim().slice(0, 300) || null;
  await q(`UPDATE leave_requests SET status=$2, decided_by=$3, decided_at=now(), admin_note=$4 WHERE id=$1`, [r.id, st, req.user.name, note]);
  if (st === 'Approved' && r.kind === 'Attendance') {   // approving marks the check-in / check-out time
    const cur = (await q(`SELECT status FROM attendance WHERE user_id=$1 AND day=$2`, [r.user_id, r.from_date])).rows[0];
    await setAtt(r.user_id, r.from_date, cur && cur.status === 'Half Day' ? 'Half Day' : 'Present', r.from_time, r.to_time, null, req.user.name + ' (request)');
  }
  await notifyLink([r.user_id], st === 'Approved' ? '✅ Request approved' : '❌ Request rejected', `Your ${reqWhen(r)} was ${st.toLowerCase()} by ${req.user.name}${note ? ' — ' + note : ''}`, 'att');
  res.json({ ok: true });
}));
app.post('/api/leave/:id/cancel', wrap(async (req, res) => {
  const r = (await q('SELECT * FROM leave_requests WHERE id=$1', [req.params.id])).rows[0];
  if (!r || r.user_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
  if (r.status !== 'Pending') return res.status(400).json({ error: 'Only a pending request can be cancelled' });
  await q(`UPDATE leave_requests SET status='Cancelled' WHERE id=$1`, [r.id]); res.json({ ok: true });
}));
app.delete('/api/leave/:id', superOnly, wrap(async (req, res) => { await q('DELETE FROM leave_requests WHERE id=$1', [req.params.id]); res.json({ ok: true }); }));

init().then(() => { setInterval(remindDue, 30000); remindDue(); }).then(() => app.listen(process.env.PORT || 3000, () => console.log('Rago CRM running')))
  .catch(e => { console.error('DB init failed', e.message); process.exit(1); });
