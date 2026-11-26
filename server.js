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
pool.on('connect', c => { c.query("SET TIME ZONE 'Asia/Kolkata'").catch(() => {}); });   // eslint-disable-line   // dates & 'this month' in India time
const q = (sql, p) => pool.query(sql, p);
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '24mb', verify: (req, res, buf) => { if (req.originalUrl.startsWith('/webhook/')) req.rawBody = buf; } }));
// ---------- protection: security headers, compact app code, no internal details in errors ----------
const fs = require('fs');
app.disable('x-powered-by');
const CSP = ["default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://*.tile.openstreetmap.org", "media-src 'self' data: blob:", "connect-src 'self'", "frame-src 'self' https://maps.google.com https://www.google.com",
  "worker-src 'self'", "manifest-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'self'"].join('; ');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'SAMEORIGIN'); res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(self), microphone=(self), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); res.setHeader('Content-Security-Policy', CSP);
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
// the app page is sent to browsers compacted: comments removed, inner names shortened (readable source stays only in your GitHub / server)
let APP_HTML = null, APP_ETAG = null;
const appFile = path.join(__dirname, 'public', 'index.html');
(async () => {
  try {
    const { minify } = require('terser'); let src = fs.readFileSync(appFile, 'utf8');
    const parts = src.split(/(<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>|<style[^>]*>[\s\S]*?<\/style>)/i);
    for (let i = 0; i < parts.length; i++) {
      const x = parts[i];
      if (/^<script/i.test(x)) { const open = x.match(/^<script[^>]*>/i)[0], body = x.slice(open.length, -9);
        const r = await minify(body, { compress: { passes: 2 }, mangle: { toplevel: false }, format: { comments: false } }); parts[i] = open + r.code + '</script>'; }
      else if (/^<style/i.test(x)) parts[i] = x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\n\s*/g, '').replace(/\s*([{};,])\s*/g, '$1');
      else parts[i] = x.replace(/<!--[\s\S]*?-->/g, '').replace(/>\s*\n\s*</g, '><');
    }
    APP_HTML = parts.join(''); APP_ETAG = '"' + crypto.createHash('sha1').update(APP_HTML).digest('base64url') + '"';
    console.log(`App page compacted ${Math.round(src.length / 1024)} KB → ${Math.round(APP_HTML.length / 1024)} KB`);
  } catch (e) { console.error('compact app page failed — serving the normal page', e.message); }
})();
app.get(['/', '/index.html'], (req, res) => {
  res.setHeader('Cache-Control', 'no-cache'); res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (!APP_HTML) return res.sendFile(appFile);
  res.setHeader('ETag', APP_ETAG); if (req.headers['if-none-match'] === APP_ETAG) return res.status(304).end();
  res.type('html').send(APP_HTML);
});
app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));
app.use(express.static(path.join(__dirname, 'public'), { index: false, dotfiles: 'deny' }));
// database / internal errors never reach the browser (they are written to the server log instead)
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(e => { console.error(e);
  const internal = e && (e.code && /^[0-9A-Z]{5}$/.test(e.code) || e.severity || e.routine || /ECONN|ETIMEDOUT|ENOTFOUND|syntax|relation|column|violates/i.test(e.message || ''));
  res.status(500).json({ error: internal ? 'Something went wrong. Please try again.' : e.message }); });

// ---------- master data ----------
const REPORT_PHOTO_REQUIRED = true;   // technician must attach a report-book photo before 'Work done'
const SERVICE_TYPES = ['Camera Issue', 'Automation Issue', 'Network / Wi-Fi Issue', 'Door Lock / Access Issue', 'Intercom Issue', 'Alarm / Sensor Issue', 'Power / Wiring Issue', 'Installation', 'Other'];
const VISIT_TYPES = ['Onsite', 'Offsite'];
const LEAD_STAGES = ['New Enquiry', 'Contacted', 'Site Visit', 'Quotation', 'Negotiation', 'Closed Won', 'Closed Lost'];
const LEAD_PRIORITIES = ['Hot', 'Warm', 'Cold'];
const LEAD_SOURCES_DEF = ['Call', 'WhatsApp', 'Walk-in', 'Website', 'Instagram', 'Referral', 'Other'];
const LEAD_SOURCES = [...LEAD_SOURCES_DEF], LEAD_INTERESTS = [];
const LEAD_INTERESTS_DEF = ['CCTV Cameras', 'Home Automation', 'Smart Lock / Access', 'Intercom', 'Alarm / Security', 'Networking / Wi-Fi', 'Other'];
LEAD_INTERESTS.push(...LEAD_INTERESTS_DEF);
const STATUSES = ['New Ticket', 'Work Not Started', 'On-Process', 'Work Pending', 'Billing', 'Awaiting Payment', 'Resolved', 'Cancelled'];
const APPROVALS = ['Pending', 'Approved', 'Rejected'];
const BANKS = ['HDFC BANK LTD - 50200080113661', 'HDFC BANK LTD - 50200090005267', 'SERVICE PETTY CASH', 'SALES PETTY CASH'];
// Super Admin = owner: everything, and the ONLY role that can delete anything.
// Admin staff / Sales staff / Technician staff: Super Admin ticks what each person can use.
const SUPER = 'Super Admin';
const ROLES = [SUPER, 'Admin', 'Sales Admin', 'Sales', 'Technician', 'Staff'];   // Staff = drivers, cleaners… attendance only
const PERMS = [
  { k: 'dashboard', l: 'Dashboard', g: 'Menus' }, { k: 'services', l: 'Services & jobs', g: 'Menus' },
  { k: 'customers', l: 'Customers', g: 'Menus' }, { k: 'team', l: 'Team', g: 'Menus' }, { k: 'leads', l: 'Leads', g: 'Menus' },
  { k: 'pay_overview', l: 'Service payments & overview (today’s customer payments, status counts)', g: 'Menus' },
  { k: 'service_create', l: 'Create services & jobs', g: 'Actions' }, { k: 'service_assign', l: 'Assign technician', g: 'Actions' },
  { k: 'service_edit', l: 'Edit status & approval', g: 'Actions' }, { k: 'payments', l: 'Add payments & discounts', g: 'Actions' },
  { k: 'view_charges', l: 'See charges', g: 'Actions' }, { k: 'view_phone', l: 'See customer phone', g: 'Actions' },
  { k: 'types', l: 'Add issue types & job types', g: 'Actions' },
  { k: 'customer_edit', l: 'Edit customer name, company & phone', g: 'Actions' },
  { k: 'billing', l: 'Billing — quotations, invoices, products, stock & payments', g: 'Actions' },
  { k: 'purchases', l: 'Purchases, vendors, expenses & profit reports', g: 'Actions' },
  { k: 'warranty', l: 'Warranty & service — material cases, W&S vendors and charges', g: 'Actions' },
  { k: 'lead_lists', l: 'Add lead sources & interests', g: 'Actions' },
  { k: 'leads_all', l: 'See all leads of the brand (not only their own)', g: 'Actions' },
  { k: 'att_team', l: 'See team attendance — who came, leave, absent, late', g: 'Attendance & pay' },
  { k: 'leave_approve', l: 'Approve leave / permission / attendance requests & mark attendance', g: 'Attendance & pay' },
  { k: 'payroll', l: 'Payroll — staff salaries, advances & salary download', g: 'Attendance & pay' },
  { k: 'chat', l: 'Team chat', g: 'Features' }, { k: 'projects', l: 'Projects', g: 'Features' },
  { k: 'voice_assign', l: 'Send voice messages & tasks to other staff', g: 'Features' },
  { k: 'whatsapp', l: 'WhatsApp — see and reply on the Sales & Service numbers', g: 'Features' },
  { k: 'field', l: 'Field visits — check in / out at customer sites with GPS, photos & km travelled', g: 'Features' },
  { k: 'field_team', l: 'See everyone’s field visits, routes & kilometres', g: 'Attendance & pay' },
  { k: 'calls', l: 'Call leads — phone calls longer than the set time come in as leads (Rago Calls Android app)', g: 'Features' },
];
const TECH_KEYS = ['view_phone', 'view_charges', 'chat', 'projects', 'voice_assign', 'whatsapp', 'field'], STAFF_KEYS = ['chat', 'field'];
const ALL_KEYS = PERMS.map(p => p.k);
const DEFAULTS = {
  Admin: ALL_KEYS.filter(k => !['team', 'payroll'].includes(k)),
  'Sales Admin': ['dashboard', 'customers', 'leads', 'leads_all', 'lead_lists', 'service_create', 'view_charges', 'view_phone', 'customer_edit', 'billing', 'chat', 'projects', 'voice_assign', 'whatsapp', 'field', 'field_team', 'att_team', 'calls'],
  Sales: ['dashboard', 'services', 'customers', 'leads', 'service_create', 'view_charges', 'view_phone', 'chat', 'projects', 'voice_assign', 'whatsapp', 'field', 'calls'],
  Technician: ['view_phone', 'chat', 'projects'],
  Staff: ['chat'],
};
// Super Admin can change each role's default features and add their own roles (stored in settings)
let ROLE_DEF = {}, CUSTOM_ROLES = [];
const roleDefaults = () => Object.fromEntries(Object.keys(DEFAULTS).map(r => [r, Array.isArray(ROLE_DEF[r]) ? ROLE_DEF[r] : DEFAULTS[r]]));
const roleKeys = role => role === 'Technician' ? TECH_KEYS : role === 'Staff' ? STAFF_KEYS : ALL_KEYS;
const cleanPerms = (role, list) => role === SUPER ? ALL_KEYS : (Array.isArray(list) ? list : roleDefaults()[role] || []).filter(k => (role === 'Technician' ? TECH_KEYS : role === 'Staff' ? STAFF_KEYS : ALL_KEYS).includes(k));
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
const approveNeed = (req, res, next) => can(req.user, 'leave_approve') ? next() : res.status(403).json({ error: 'You don’t have permission to approve or mark attendance' });
const payNeed = (req, res, next) => can(req.user, 'payroll') ? next() : res.status(403).json({ error: 'Not allowed' });
const superOnly = (req, res, next) => isSuper(req.user) ? next() : res.status(403).json({ error: 'Only the Super Admin can delete' });
const techOnly = (req, res, next) => (isTech(req.user) || isSuper(req.user)) ? next() : res.status(403).json({ error: 'Not allowed' });
const auth = wrap(async (req, res, next) => {
  if (req.path.startsWith('/calls/device/') && /^Bearer rgd_[A-Za-z0-9_-]{30,}$/.test(req.headers.authorization || '')) {   // Rago Calls phone app
    const th = crypto.createHash('sha256').update(req.headers.authorization.slice(7)).digest('hex');
    const u = (await q(`SELECT u.id,u.name,u.email,u.phone,u.role,u.job_role,u.username,u.permissions,u.active,u.brand_id, b.name brand_name, dv.id device_id FROM call_devices dv JOIN users u ON u.id=dv.user_id LEFT JOIN brands b ON b.id=u.brand_id WHERE dv.token_hash=$1 AND u.active AND dv.active`, [th])).rows[0];
    if (!u) return res.status(401).json({ error: 'This phone is signed out. Sign in again in the Rago Calls app.' });
    req.user = u; return next();
  }
  const d = unsign(cookies(req.headers.cookie).gz);
  const u = d && (await q('SELECT u.id,u.name,u.email,u.phone,u.role,u.job_role,u.username,u.permissions,u.active,u.brand_id,u.photo_v,u.created_at, b.name brand_name FROM users u LEFT JOIN brands b ON b.id=u.brand_id WHERE u.id=$1 AND u.active', [d.id])).rows[0];
  if (!u) return res.status(401).json({ error: 'Login required' });
  req.user = u; next();
});
const me = u => ({ id: u.id, name: u.name, role: u.role, username: u.username, brand_id: u.brand_id || null, brand: u.brand_name || null, photo_v: u.photo_v || 0, permissions: isSuper(u) ? ALL_KEYS : u.permissions });
const pub = u => { const { password_hash, photo, photo_mime, cal_token, ...r } = u; return r; };

const tries = {};
app.post('/api/login', wrap(async (req, res) => {
  const ip = req.ip, t = tries[ip] || { n: 0, at: Date.now() };
  if (Date.now() - t.at > 600000) { t.n = 0; t.at = Date.now(); }
  if (t.n >= 8) return res.status(429).json({ error: 'Too many attempts. Try again in 10 minutes.' });
  const { username, password } = req.body || {};
  const uk = 'u:' + String(username || '').trim().toLowerCase(), tu = tries[uk] || { n: 0, at: Date.now() };
  if (Date.now() - tu.at > 900000) { tu.n = 0; tu.at = Date.now(); }
  if (tu.n >= 10) return res.status(429).json({ error: 'This account is locked for 15 minutes after many wrong passwords.' });
  const u = (await q('SELECT * FROM users WHERE lower(username)=lower($1)', [String(username || '').trim()])).rows[0];
  if (!u || !verify(String(password || ''), u.password_hash)) { tries[ip] = { n: t.n + 1, at: t.at }; if (u) tries[uk] = { n: tu.n + 1, at: tu.at }; return res.status(401).json({ error: 'Wrong username or password' }); }
  if (!u.active) return res.status(403).json({ error: 'Your account has been disabled. Please contact the Super Admin.' });
  delete tries[ip]; delete tries[uk];
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
app.use('/api', (req, res, next) => (req.path === '/login' || req.path === '/logout' || req.path === '/calls/device-login') ? next() : auth(req, res, next));
app.get('/api/pulse', wrap(async (req, res) => {
  const r = (await q('SELECT COALESCE(MAX(id),0)::int last, COUNT(*) FILTER (WHERE NOT read)::int unread FROM notifications WHERE user_id=$1', [req.user.id])).rows[0];
  res.set('Cache-Control', 'no-store').json({ v: VER, last: r.last, unread: r.unread, chat: can(req.user, 'chat') ? await chatUnread(req.user.id).catch(() => 0) : 0, wa: can(req.user, 'whatsapp') ? await waUnread(req.user).catch(() => 0) : 0, wa_last: can(req.user, 'whatsapp') ? ((await q('SELECT COALESCE(MAX(id),0)::int n FROM wa_messages').catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n) : 0, chat_last: (await q('SELECT COALESCE(MAX(id),0)::int n FROM chat_messages')).rows[0].n });
}));
app.get('/api/me', (req, res) => res.json(me(req.user)));
app.post('/api/password', wrap(async (req, res) => {
  const { current, next } = req.body || {};
  const ph = ((await q('SELECT password_hash FROM users WHERE id=$1', [req.user.id])).rows[0] || {}).password_hash;
  if (!ph || !verify(String(current || ''), ph)) return res.status(400).json({ error: 'Current password is wrong' });
  if (!next || String(next).length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  await q('UPDATE users SET password_hash=$1 WHERE id=$2', [hash(String(next)), req.user.id]); res.json({ ok: true });
}));

// ---------- leads (Heaven Automation pipeline) ----------
const LSEL = `SELECT l.id,l.name,l.company,l.brand_id,(SELECT name FROM brands WHERE id=l.brand_id) brand,(SELECT COUNT(*)::int FROM lead_voice v WHERE v.lead_id=l.id) voices,l.phone,l.email,l.source,l.interest,l.address,l.priority,l.stage,l.assigned_to,l.value,to_char(l.follow_up,'YYYY-MM-DD') follow_up,l.last_contact,l.notes,l.lost_reason,l.customer_id,l.created_at,l.lat,l.lng,l.map_url,l.location_by,l.location_on,u.name agent,
  (SELECT json_build_object('id',fp.id,'user_id',fp.user_id,'user',fu.name,'date',to_char(fp.plan_date,'YYYY-MM-DD'),'status',fp.status) FROM fv_plans fp JOIN users fu ON fu.id=fp.user_id WHERE fp.lead_id=l.id ORDER BY fp.id DESC LIMIT 1) fv_plan
  FROM leads l LEFT JOIN users u ON u.id=l.assigned_to`;
const digits = v => String(v || '').replace(/\D/g, '');
const pickOf = (v, list, d) => list.includes(v) ? v : d;
const cleanLead = (b, cur = {}) => {
  const o = {}, t = k => { if (b[k] !== undefined) o[k] = String(b[k] ?? '').trim() || null; };
  ['name', 'company', 'phone', 'email', 'address', 'notes', 'lost_reason'].forEach(t);
  if (b.source !== undefined) o.source = b.source ? pickOf(b.source, LEAD_SOURCES, 'Other') : null;
  if (b.interest !== undefined) o.interest = b.interest ? pickOf(b.interest, LEAD_INTERESTS, 'Other') : null;
  if (b.priority !== undefined) o.priority = pickOf(b.priority, LEAD_PRIORITIES, cur.priority || 'Warm');
  if (b.stage !== undefined) o.stage = pickOf(b.stage, LEAD_STAGES, cur.stage || 'New Enquiry');
  if (b.assigned_to !== undefined) o.assigned_to = Number.isInteger(+b.assigned_to) && +b.assigned_to > 0 ? +b.assigned_to : null;
  if (b.value !== undefined) o.value = money(b.value);
  if (b.follow_up !== undefined) o.follow_up = /^\d{4}-\d{2}-\d{2}$/.test(b.follow_up) ? b.follow_up : null;
  return o;
};
const insLead = async (o, uid, brandId) => (await q(`INSERT INTO leads(name,phone,email,source,interest,address,priority,stage,assigned_to,value,follow_up,notes,created_by,company,brand_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
  [o.name, o.phone || null, o.email || null, o.source || null, o.interest || null, o.address || null, o.priority || 'Warm', o.stage || 'New Enquiry', o.assigned_to || null, o.value || 0, o.follow_up || null, o.notes || null, uid, o.company || null, brandId || null])).rows[0].id;
// Super Admin sees ALL leads and follow-ups. Everyone else (Admin staff, Sales…) sees only the leads
// allocated to them or created by them — and, if they belong to a brand, only within that brand.
const leadScope = (u, p) => {
  if (u.role === SUPER) return 'true';
  if ((u.permissions || []).includes('leads_all')) { if (!u.brand_id) return 'true'; p.push(u.brand_id); return `l.brand_id=$${p.length}`; }
  p.push(u.id); let w = `(l.assigned_to=$${p.length} OR l.created_by=$${p.length} OR EXISTS (SELECT 1 FROM fv_plans fp WHERE fp.lead_id=l.id AND fp.user_id=$${p.length} AND fp.status<>'cancelled'))`;
  if (u.brand_id) { p.push(u.brand_id); w += ` AND l.brand_id=$${p.length}`; }
  return w;
};
const leadBrand = async (u, v) => {
  if (u.brand_id) return u.brand_id;
  if (Number.isInteger(+v) && +v > 0 && (await q('SELECT 1 FROM brands WHERE id=$1', [+v])).rows.length) return +v;
  return (await q(`SELECT id FROM brands ORDER BY (lower(name)='heaven') DESC, id LIMIT 1`)).rows[0].id;
};
const leadOK = async (req, res, id) => {
  const p = [+id], sc = leadScope(req.user, p);
  const l = (await q(`SELECT l.* FROM leads l WHERE l.id=$1 AND ${sc}`, p)).rows[0];
  if (!l) { res.status(404).json({ error: 'Not found' }); return null; }
  return l;
};
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

app.get('/api/leads', need('leads'), wrap(async (req, res) => {
  const p = [], sc = leadScope(req.user, p);
  if (!req.user.brand_id && +req.query.brand) { p.push(+req.query.brand); }
  res.json((await q(`${LSEL} WHERE ${sc}${!req.user.brand_id && +req.query.brand ? ` AND l.brand_id=$${p.length}` : ''} ORDER BY l.last_contact DESC, l.id DESC LIMIT 3000`, p)).rows);
}));

app.post('/api/leads/import', need('leads'), wrap(async (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows.slice(0, 2000) : [];
  const bId = await leadBrand(req.user, req.body.brand_id);
  const have = new Set((await q(`SELECT regexp_replace(phone,'[^0-9]','','g') d FROM leads WHERE phone IS NOT NULL AND brand_id=$1`, [bId])).rows.map(r => r.d));
  let added = 0, skipped = 0;
  for (const r of rows) {
    const o = cleanLead(r); delete o.assigned_to;
    if (!o.name) { skipped++; continue; }
    const dg = digits(o.phone);
    if (dg.length >= 7) { if (have.has(dg)) { skipped++; continue; } have.add(dg); }
    await insLead(o, req.user.id, bId); added++;
  }
  res.json({ added, skipped });
}));

app.post('/api/leads/bulk', need('leads'), wrap(async (req, res) => {
  let ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger).slice(0, 500);
  { const p = [ids], sc = leadScope(req.user, p); ids = (await q(`SELECT l.id FROM leads l WHERE l.id=ANY($1::int[]) AND ${sc}`, p)).rows.map(r => r.id); }
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
  if (o.stage === 'Closed Won') for (const l of (await q('SELECT * FROM leads WHERE id=ANY($1::int[])', [ids])).rows) await leadCustomer(l, req.user.brand_id);
  if (o.assigned_to && o.assigned_to !== req.user.id) notify([o.assigned_to], 'Leads assigned', `${ids.length} lead(s) were assigned to you`, null).catch(() => {});
  res.json({ ok: true });
}));

app.post('/api/leads', need('leads'), wrap(async (req, res) => {
  const o = cleanLead(req.body);
  if (!o.name) return res.status(400).json({ error: 'Enter the lead name' });
  const dg = digits(o.phone), bId = await leadBrand(req.user, req.body.brand_id);
  if (dg.length >= 7) {
    const d = (await q(`SELECT name FROM leads WHERE regexp_replace(phone,'[^0-9]','','g')=$1 AND brand_id=$2 LIMIT 1`, [dg, bId])).rows[0];
    if (d) return res.status(409).json({ error: `A lead with this phone already exists (${d.name})` });
  }
  const lf = locFields(req.body, req.user);
  if (lf.error) return res.status(400).json({ error: lf.error });
  const id = await insLead(o, req.user.id, bId);
  if (Object.keys(lf).length) { const k = Object.keys(lf); await q(`UPDATE leads SET ${k.map((c, i) => `${c}=$${i + 1}`).join(',')} WHERE id=$${k.length + 1}`, [...k.map(c => lf[c]), id]); }
  await leadLog(id, req.user.name, 'Lead created');
  if (o.assigned_to && o.assigned_to !== req.user.id) notify([o.assigned_to], 'New lead assigned', `${o.name} was assigned to you`, null).catch(() => {});
  res.json({ id });
}));

app.get('/api/leads/:id', need('leads'), wrap(async (req, res) => {
  const p = [+req.params.id], sc = leadScope(req.user, p);
  const l = (await q(`${LSEL} WHERE l.id=$1 AND ${sc}`, p)).rows[0];
  if (!l) return res.status(404).json({ error: 'Not found' });
  l.voice = (await q('SELECT id, user_id, user_name, role, duration, created_at FROM lead_voice WHERE lead_id=$1 ORDER BY id', [l.id])).rows;
  l.project_id = ((await q('SELECT id FROM projects WHERE lead_id=$1', [l.id]).catch(() => ({ rows: [] }))).rows[0] || {}).id || null;
  l.activity = (await q('SELECT by_name, text, created_at FROM lead_activity WHERE lead_id=$1 ORDER BY id DESC LIMIT 100', [l.id])).rows;
  res.json(l);
}));

app.patch('/api/leads/:id', need('leads'), wrap(async (req, res) => {
  if (!await leadOK(req, res, req.params.id)) return;
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
  if (stageChanged && o.stage === 'Closed Won') { const c = await leadCustomer({ ...cur, ...o }, req.user.brand_id); ch.push(`Added to customers (${c.name})`); }
  if (ch.length) await leadLog(cur.id, req.user.name, ch.join(' · '));
  if ('assigned_to' in o && o.assigned_to && o.assigned_to !== cur.assigned_to && o.assigned_to !== req.user.id) notify([o.assigned_to], 'Lead assigned to you', cur.name, null).catch(() => {});
  res.json({ ok: true });
}));

app.post('/api/leads/:id/note', need('leads'), wrap(async (req, res) => {
  const t = String(req.body.text || '').trim().slice(0, 1000);
  if (!t) return res.status(400).json({ error: 'Write a note first' });
  if (!await leadOK(req, res, req.params.id)) return;
  const r = await q('UPDATE leads SET last_contact=now(), updated_at=now() WHERE id=$1 RETURNING id', [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
  await leadLog(r.rows[0].id, req.user.name, t); res.json({ ok: true });
}));

// a won lead becomes a service customer (same brand) — reused if the phone already exists
async function leadCustomer(l, brandFallback) {
  let c; if (l.customer_id) c = (await q('SELECT * FROM customers WHERE id=$1', [l.customer_id])).rows[0];
  const br = l.brand_id || brandFallback || null;
  if (!c && digits(l.phone).length >= 7) c = (await q(`SELECT * FROM customers WHERE regexp_replace(phone,'[^0-9]','','g')=$1 AND (brand_id IS NOT DISTINCT FROM $2 OR brand_id IS NULL) ORDER BY (brand_id IS NOT DISTINCT FROM $2) DESC LIMIT 1`, [digits(l.phone), br])).rows[0];
  if (!c) c = (await q('INSERT INTO customers(name,phone,email,address,brand_id,lat,lng,map_url,company) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [l.name, l.phone, l.email, l.address, br, l.lat ?? null, l.lng ?? null, l.map_url || null, l.company || null])).rows[0];
  else if (l.company && !c.company) await q('UPDATE customers SET company=$1 WHERE id=$2', [l.company, c.id]);
  else if (!c.brand_id && br) await q('UPDATE customers SET brand_id=$1 WHERE id=$2', [br, c.id]);
  if (l.customer_id !== c.id) await q('UPDATE leads SET customer_id=$1 WHERE id=$2', [c.id, l.id]);
  return c;
}
app.post('/api/leads/:id/convert', need('leads'), wrap(async (req, res) => {
  const l = await leadOK(req, res, req.params.id); if (!l) return;
  const c = await leadCustomer(l, req.user.brand_id);
  await q(`UPDATE leads SET customer_id=$1, stage='Closed Won', updated_at=now(), last_contact=now() WHERE id=$2`, [c.id, l.id]);
  await leadLog(l.id, req.user.name, l.customer_id ? 'Service requested' : 'Converted to customer · Closed Won');
  res.json({ customer: { id: c.id, name: c.name, phone: c.phone, address: c.address, tickets: 0 } });
}));

app.delete('/api/leads/:id', superOnly, wrap(async (req, res) => {
  await q('DELETE FROM chats WHERE lead_id=$1', [req.params.id]).catch(() => {});
  await q('UPDATE projects SET lead_id=NULL WHERE lead_id=$1', [req.params.id]).catch(() => {});
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
  ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS company BOOLEAN DEFAULT false;
  ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
  ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
  ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS distance INT;
  ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS customer_id INT;
  ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS place TEXT;
  ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS accuracy INT;
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS brand_id INT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS photo BYTEA;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_mime TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_v INT DEFAULT 0;
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS received_by TEXT;
  CREATE TABLE IF NOT EXISTS service_voice (id SERIAL PRIMARY KEY, service_id INT NOT NULL REFERENCES services(id) ON DELETE CASCADE, user_id INT, user_name TEXT, role TEXT,
    audio BYTEA NOT NULL, mime TEXT, duration INT DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now());
  CREATE INDEX IF NOT EXISTS idx_sv_service ON service_voice(service_id);
  CREATE INDEX IF NOT EXISTS idx_pay_date ON payments(paid_on);
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS company TEXT;
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS brand_id INT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS cal_token TEXT;
  CREATE TABLE IF NOT EXISTS lead_voice (id SERIAL PRIMARY KEY, lead_id INT NOT NULL REFERENCES leads(id) ON DELETE CASCADE, user_id INT, user_name TEXT, role TEXT,
    audio BYTEA NOT NULL, mime TEXT, duration INT DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now());
  CREATE INDEX IF NOT EXISTS idx_lv_lead ON lead_voice(lead_id);
  ALTER TABLE users ADD COLUMN IF NOT EXISTS salary NUMERIC(12,2) DEFAULT 0;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS join_date DATE;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS pay_brand_id INT;
  CREATE TABLE IF NOT EXISTS advances (id SERIAL PRIMARY KEY, user_id INT NOT NULL, kind TEXT NOT NULL DEFAULT 'Advance', amount NUMERIC(12,2) NOT NULL,
    given_on DATE NOT NULL DEFAULT CURRENT_DATE, deduct_month TEXT NOT NULL, note TEXT, given_by TEXT, given_by_id INT, created_at TIMESTAMPTZ DEFAULT now());
  CREATE INDEX IF NOT EXISTS idx_adv_user ON advances(user_id, deduct_month);
  ALTER TABLE services ADD COLUMN IF NOT EXISTS work_done_on TIMESTAMPTZ;
  CREATE INDEX IF NOT EXISTS idx_services_helper ON services(helper_id, status);`);
  await q(`UPDATE services SET work_done_on=COALESCE(resolved_on, on_process_at, assigned_on, submitted_on) WHERE work_done_on IS NULL AND status IN ('Awaiting Payment','Resolved')`);

  if (!(await q(`SELECT 1 FROM settings WHERE k='office'`)).rows.length)
    await q(`INSERT INTO settings(k,v) VALUES('office',$1)`, [JSON.stringify(OFFICE_DEFAULT)]);
  if (!(await q('SELECT 1 FROM brands LIMIT 1')).rows.length)
    for (const n of BRANDS) await q('INSERT INTO brands(name) VALUES($1) ON CONFLICT DO NOTHING', [n]);
  if (!(await q('SELECT 1 FROM job_types LIMIT 1')).rows.length)
    for (const n of JOB_TYPES) await q('INSERT INTO job_types(name) VALUES($1) ON CONFLICT DO NOTHING', [n]);
  const heaven = (await q(`SELECT id FROM brands ORDER BY (lower(name)='heaven') DESC, id LIMIT 1`)).rows[0].id;
  await q(`UPDATE services SET brand_id=$1 WHERE brand_id IS NULL`, [heaven]);
  await q(`UPDATE services SET kind='Service' WHERE kind IS NULL`);
  await q(`UPDATE leads SET brand_id=$1 WHERE brand_id IS NULL`, [heaven]);   // old leads were Heaven Automation's pipeline
  for (const l of (await q(`SELECT * FROM leads WHERE stage='Closed Won' AND customer_id IS NULL LIMIT 500`)).rows) await leadCustomer(l, heaven);   // won leads → customers
  // customers belong to the brand of their tickets (Heaven staff see Heaven customers; Super Admin sees all)
  await q(`UPDATE customers c SET brand_id=(SELECT s.brand_id FROM services s WHERE s.customer_id=c.id AND s.brand_id IS NOT NULL ORDER BY s.id DESC LIMIT 1) WHERE c.brand_id IS NULL`);
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
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS company TEXT;
  ALTER TABLE services ADD COLUMN IF NOT EXISTS created_by INT;
  ALTER TABLE services ADD COLUMN IF NOT EXISTS bill_items JSONB;
  ALTER TABLE services ADD COLUMN IF NOT EXISTS bill_note TEXT;
  ALTER TABLE services ADD COLUMN IF NOT EXISTS bill_total NUMERIC(12,2);
  ALTER TABLE services ADD COLUMN IF NOT EXISTS bill_state TEXT;
  ALTER TABLE services ADD COLUMN IF NOT EXISTS bill_no INT;
  ALTER TABLE services ADD COLUMN IF NOT EXISTS billed_at TIMESTAMPTZ;
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS mode TEXT;
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS actual NUMERIC(12,2);
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS disc NUMERIC(12,2);
  ALTER TABLE users ADD COLUMN IF NOT EXISTS att_rules JSONB;
  CREATE TABLE IF NOT EXISTS notes (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, day DATE NOT NULL, title TEXT, body TEXT,
    pinned BOOLEAN DEFAULT false, created_by INT, created_by_name TEXT, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
  CREATE INDEX IF NOT EXISTS idx_notes_user_day ON notes(user_id, day);
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
  const r = (await q(`SELECT u.id,u.name,u.photo_v, s.brand_id, b.name brand, s.ticket_no FROM users u
    LEFT JOIN services s ON (s.technician_id=u.id OR s.helper_id=u.id) AND s.status=ANY($1::text[])
    LEFT JOIN brands b ON b.id=s.brand_id WHERE u.role='Technician' AND u.active ORDER BY u.name, s.id`, [OPEN_ST])).rows;
  const m = new Map();
  for (const x of r) {
    const t = m.get(x.id) || { id: x.id, name: x.name, photo_v: x.photo_v, busy: [] }; m.set(x.id, t);
    if (x.brand_id && !t.busy.some(z => z.brand_id === x.brand_id)) t.busy.push({ brand_id: x.brand_id, brand: x.brand, ticket_no: x.ticket_no });
  }
  // who is away today: approved leave, week off, office holiday, permission time (shown as "not available" in allocation)
  try {
    const today = await todayIST(), now = (await q(`SELECT to_char(now() AT TIME ZONE '${TZ}','HH24:MI') t`)).rows[0].t, off = await office(), hol = (await officeHolidays(today, today))[today];
    const lv = (await q(`SELECT user_id, kind, session, from_time ft, to_time tt FROM leave_requests WHERE status='Approved' AND kind IN ('Leave','Permission') AND $1::date BETWEEN from_date AND COALESCE(to_date,from_date)`, [today])).rows;
    const ru = {}; (await q(`SELECT id, att_rules FROM users WHERE role='Technician' AND active`)).rows.forEach(u => { ru[u.id] = u; });
    for (const t of m.values()) {
      const L = lv.filter(x => x.user_id === t.id), leave = L.find(x => x.kind === 'Leave'), pm = L.filter(x => x.kind === 'Permission');
      const R = rulesOf(ru[t.id] || {}, off), wo = (await offDaysFor(t.id, R, today, today))(today);
      const win = pm.map(x => ({ f: x.ft || (x.session === 'Evening' ? m2hm(hm2m(R.out) - 120) : R.in), e: x.tt || (x.session === 'Morning' ? m2hm(hm2m(R.in) + 120) : R.out) }));
      const cur = win.find(w => w.f <= now && now < w.e);
      t.away = leave ? 'On leave today' : wo ? 'Week off today' : hol ? 'Holiday · ' + hol : cur ? `On permission till ${cur.e}` : null;
      t.note = !t.away && win.length ? 'Permission ' + win.map(w => `${w.f}–${w.e}`).join(', ') : null;
    }
  } catch (e) { console.error('away', e.message); }
  return [...m.values()];
};
app.get('/api/meta', wrap(async (req, res) => {
  const ag = await q(`SELECT id,name FROM users WHERE role IN ('${SUPER}','Admin','Sales Admin','Sales') AND active ORDER BY name`);
  let it = { rows: [] }; try { it = await q('SELECT id,name FROM issue_types ORDER BY id'); } catch (e) { /* table missing: fall back to defaults */ }
  const ISSUE_TYPES = it.rows, JT = (await q('SELECT id,name FROM job_types ORDER BY id')).rows, brands = (await q('SELECT id,name FROM brands ORDER BY id')).rows;
  res.json({ SERVICE_TYPES: ISSUE_TYPES.length ? ISSUE_TYPES.map(r => r.name) : SERVICE_TYPES, ISSUE_TYPES, JOB_TYPES: JT.map(r => r.name), JOB_TYPE_ROWS: JT, brands, VISIT_TYPES, STATUSES, APPROVALS, BANKS, ROLES, PERMS, DEFAULTS: roleDefaults(), CUSTOM_ROLES, TECH_KEYS, STAFF_KEYS, LEAD_STAGES, LEAD_PRIORITIES, LEAD_SOURCES, LEAD_INTERESTS, LEAVE_TYPES, technicians: await techList(), agents: ag.rows });
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
  { const p = [dg], sc = custScope(req.user, p);
    out.customers = (await q(`SELECT c.id,c.name,c.phone,c.address,(SELECT COUNT(*) FROM services s WHERE s.customer_id=c.id)::int tickets FROM customers c WHERE regexp_replace(COALESCE(c.phone,''),'[^0-9]','','g') LIKE '%'||$1||'%' AND ${sc} ORDER BY c.name LIMIT 3`, p)).rows; }
  if (can(req.user, 'leads'))
  { const lp = [dg], sc = leadScope(req.user, lp);
    out.leads = (await q(`SELECT l.id,l.name,l.company,l.phone,l.stage FROM leads l WHERE regexp_replace(COALESCE(l.phone,''),'[^0-9]','','g') LIKE '%'||$1||'%' AND ${sc} ORDER BY l.id DESC LIMIT 3`, lp)).rows; }
  res.json(out);
}));

// ---------- team ----------
// Super Admin manages everyone. Anybody else with "Team" can only manage Sales and Technician staff.
const brandFor = async (role, v) => {
  if (role === SUPER || role === 'Technician' || role === 'Staff') return { id: null };
  const id = Number.isInteger(+v) && +v > 0 ? +v : null;
  if (id && !(await q('SELECT 1 FROM brands WHERE id=$1', [id])).rows.length) return { error: 'Brand not found' };
  if (role === 'Admin' && !id) return { error: 'Choose the brand this admin staff works for' };
  return { id };
};
// per-person field visit ₹/km (kept with the other km settings)
const fvSetRate = async (uid, v) => { let c = {}; try { c = JSON.parse(((await q(`SELECT v FROM settings WHERE k='fv_cfg'`)).rows[0] || {}).v || '{}'); } catch (e) {}
  c.rates = c.rates && typeof c.rates === 'object' ? c.rates : {}; if (v === '' || v === null || !(+v >= 0)) delete c.rates[uid]; else c.rates[uid] = Math.min(1000, Math.round(+v * 100) / 100);
  await q(`INSERT INTO settings(k,v) VALUES('fv_cfg',$1) ON CONFLICT (k) DO UPDATE SET v=excluded.v`, [JSON.stringify(c)]); };
const fvRateAdd = (u, c) => x => isSuper(u) ? { ...x, fv_rate: c.rates[x.id] ?? null } : x;
const jobRole = (role, name) => { const c = name && CUSTOM_ROLES.find(x => x.name === name); return c && c.base === role ? c.name : null; };
const manages = (me, role) => isSuper(me) || !['Admin', SUPER].includes(role);
// salary, joining date and "salary paid by" brand — only the Super Admin can set them
const payFields = (me, b, cur) => {
  if (!isSuper(me)) return {};
  const o = {};
  if (b.salary !== undefined) o.salary = Math.max(0, money(b.salary));
  if (b.join_date !== undefined) o.join_date = isDate(b.join_date) ? b.join_date : null;
  if (b.pay_brand_id !== undefined) o.pay_brand_id = Number.isInteger(+b.pay_brand_id) && +b.pay_brand_id > 0 ? +b.pay_brand_id : null;
  if (b.att_rules && typeof b.att_rules === 'object') { const c = cleanRules(b.att_rules, cur && cur.att_rules); if (c.error) o.error = c.error; else o.att_rules = c.rules; }
  return o;
};
app.get('/api/users', need('team'), wrap(async (req, res) => res.json((await q(`SELECT u.id,u.name,u.email,u.phone,u.role,u.job_role,u.username,u.permissions,u.active,u.brand_id,u.photo_v,u.created_at,u.pay_brand_id,to_char(u.join_date,'YYYY-MM-DD') join_date,${isSuper(req.user) ? 'u.salary, u.att_rules' : 'NULL salary'}, COALESCE(b.name, pb.name) brand FROM users u LEFT JOIN brands b ON b.id=u.brand_id LEFT JOIN brands pb ON pb.id=u.pay_brand_id ORDER BY u.active DESC, u.role, u.name`)).rows.map(pub).map(fvRateAdd(req.user, await fvCfg())))));
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
  const pay = payFields(req.user, b, {});
  if (pay.error) return res.status(400).json({ error: pay.error });
  if (!isSuper(req.user) && ['Technician', 'Staff'].includes(b.role) && b.home_brand_id !== undefined) {
    const hb = Number.isInteger(+b.home_brand_id) && +b.home_brand_id > 0 ? +b.home_brand_id : null;
    if (req.user.brand_id && hb !== req.user.brand_id) return res.status(403).json({ error: 'You can only choose your own brand' });
    pay.pay_brand_id = hb;
  }
  const jr = jobRole(b.role, b.job_role);
  const r = await q('INSERT INTO users(name,email,phone,role,username,password_hash,permissions,brand_id,salary,join_date,pay_brand_id,att_rules,job_role) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *',
    [b.name.trim(), b.email.trim(), b.phone.trim(), b.role, username, hash(password), cleanPerms(b.role, Array.isArray(b.permissions) ? b.permissions : jr ? (CUSTOM_ROLES.find(x => x.name === jr) || {}).perms : undefined), br.id, pay.salary ?? 0, pay.join_date ?? null, pay.pay_brand_id ?? br.id, pay.att_rules ? JSON.stringify(pay.att_rules) : null, jr]);
  if (isSuper(req.user) && b.fv_rate !== undefined) await fvSetRate(r.rows[0].id, b.fv_rate);
  res.json({ user: pub(r.rows[0]), credentials: { username, password } });
}));
app.patch('/api/users/:id', need('team'), wrap(async (req, res) => {
  const b = req.body || {}, cur = (await q('SELECT * FROM users WHERE id=$1', [req.params.id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const role = ROLES.includes(b.role) ? b.role : cur.role;
  if (!manages(req.user, cur.role) || !manages(req.user, role)) return res.status(403).json({ error: 'Only the Super Admin can change admin staff' });
  if (cur.id === req.user.id && (b.active === false || role !== cur.role)) return res.status(400).json({ error: "You can't deactivate yourself or change your own role" });
  const br = await brandFor(role, b.brand_id !== undefined ? b.brand_id : cur.brand_id); if (br.error) return res.status(400).json({ error: br.error });
  const pay = payFields(req.user, b, cur);
  if (pay.error) return res.status(400).json({ error: pay.error });
  if (!isSuper(req.user) && ['Technician', 'Staff'].includes(role) && b.home_brand_id !== undefined) {   // admin staff may set the home brand of technicians / support staff
    const hb = Number.isInteger(+b.home_brand_id) && +b.home_brand_id > 0 ? +b.home_brand_id : null;
    if (req.user.brand_id && hb !== req.user.brand_id) return res.status(403).json({ error: 'You can only choose your own brand' });
    pay.pay_brand_id = hb;
  }
  await q('UPDATE users SET name=$1,email=$2,phone=$3,role=$4,permissions=$5,active=$6,brand_id=$7,salary=$8,join_date=$9,pay_brand_id=$10 WHERE id=$11',
    [b.name || cur.name, b.email ?? cur.email, b.phone ?? cur.phone, role, cleanPerms(role, b.permissions ?? cur.permissions), b.active ?? cur.active, br.id,
     pay.salary ?? cur.salary, pay.join_date !== undefined ? pay.join_date : cur.join_date, pay.pay_brand_id !== undefined ? pay.pay_brand_id : (cur.pay_brand_id ?? br.id), cur.id]);
  if (pay.att_rules) await q('UPDATE users SET att_rules=$2 WHERE id=$1', [cur.id, JSON.stringify(pay.att_rules)]);
  if (isSuper(req.user) && b.fv_rate !== undefined) await fvSetRate(cur.id, b.fv_rate);
  if (b.job_role !== undefined || role !== cur.role) await q('UPDATE users SET job_role=$2 WHERE id=$1', [cur.id, jobRole(role, b.job_role !== undefined ? b.job_role : cur.job_role)]);
  if ((b.active ?? cur.active) === false && cur.active) { await q('DELETE FROM push_subs WHERE user_id=$1', [cur.id]).catch(() => {}); }   // disabled → signed out everywhere (every request checks "active")
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
const SELECT = `SELECT s.*, (SELECT name FROM users WHERE id=s.created_by) created_by_name, (SELECT role FROM users WHERE id=s.created_by) created_by_role, c.name customer, c.company customer_company, c.phone, c.email, c.address, c.city, c.lat, c.lng, c.map_url, c.location_by, c.location_on, t.name technician, h.name helper,
  COALESCE(pp.given,0) given, br.name brand
  FROM services s LEFT JOIN customers c ON c.id=s.customer_id LEFT JOIN brands br ON br.id=s.brand_id
  LEFT JOIN (SELECT service_id, SUM(amount) given FROM payments WHERE approval<>'Rejected' GROUP BY service_id) pp ON pp.service_id=s.id
  LEFT JOIN users t ON t.id=s.technician_id LEFT JOIN users h ON h.id=s.helper_id`;
// technicians: only their own jobs (any brand). Staff tied to a brand: only that brand. Super Admin / staff with no brand: everything.
const scope = (u, p, w) => {
  if (isTech(u)) { p.push(u.id); w.push(`(s.technician_id=$${p.length} OR s.helper_id=$${p.length}) AND s.status<>'Billing'`); }   // billing is office work — hidden from technicians
  else if (u.brand_id) { p.push(u.brand_id); w.push(`s.brand_id=$${p.length}`); }
};
const brandOK = (u, s) => isTech(u) || !u.brand_id || s.brand_id === u.brand_id;
// which customers a person may see: Super Admin / no brand → all; brand staff → that brand's customers; technicians → customers of their jobs
const custScope = (u, p) => {
  if (isTech(u)) { p.push(u.id); return `EXISTS (SELECT 1 FROM services s2 WHERE s2.customer_id=c.id AND (s2.technician_id=$${p.length} OR s2.helper_id=$${p.length}))`; }
  if (u.brand_id) { p.push(u.brand_id); return `(c.brand_id=$${p.length} OR EXISTS (SELECT 1 FROM services s2 WHERE s2.customer_id=c.id AND s2.brand_id=$${p.length}))`; }
  return 'true';
};
const shape = (s, u) => {
  if (!can(u, 'view_phone')) { delete s.phone; delete s.email; }
  if (!can(u, 'view_charges')) { delete s.charges_applied; delete s.discount; delete s.given; }
  if (!can(u, 'billing')) { delete s.bill_items; delete s.bill_note; delete s.bill_total; }
  return s;
};
const log = (id, by, changes) => changes ? q('INSERT INTO service_history(service_id,done_by,changes) VALUES($1,$2,$3)', [id, by || 'System', changes]) : null;
const pushTo = async (uid, title, body, sid, extra = {}) => {
  const subs = (await q('SELECT * FROM push_subs WHERE user_id=$1', [uid])).rows, payload = JSON.stringify({ title, body, sid, url: '/?job=' + (sid || ''), ...extra });
  await Promise.all(subs.map(s => webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 86400, urgency: 'high' })
    .catch(e => (e.statusCode === 404 || e.statusCode === 410) ? q('DELETE FROM push_subs WHERE id=$1', [s.id]) : console.error('push failed', e.statusCode || e.message))));
};
const notify = async (ids, title, body, sid, link) => {
  for (const id of [...new Set(ids)].filter(Boolean)) { await q('INSERT INTO notifications(user_id,title,body,service_id,link) VALUES($1,$2,$3,$4,$5)', [id, title, body, sid || null, link || null]); pushTo(id, title, body, sid).catch(() => {}); }
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

app.patch('/api/customers/:id', need('customer_edit'), wrap(async (req, res) => {
  const p = [+req.params.id], sc = custScope(req.user, p);
  const c = (await q(`SELECT c.* FROM customers c WHERE c.id=$1 AND ${sc}`, p)).rows[0];
  if (!c) return res.status(404).json({ error: 'Customer not found' });
  const b = req.body || {}, set = [], val = [c.id], add = (k, v) => { val.push(v); set.push(`${k}=$${val.length}`); }, ch = [];
  if (b.name !== undefined) { const n = String(b.name || '').trim().slice(0, 120) || String(b.company ?? c.company ?? '').trim() || c.name; if (n !== c.name) { add('name', n); ch.push(`name ${c.name} → ${n}`); } }
  if (b.company !== undefined) { const n = String(b.company || '').trim().slice(0, 120) || null; if (n !== c.company) { add('company', n); ch.push(`company → ${n || '—'}`); } }
  if (b.phone !== undefined) { const n = String(b.phone || '').trim(); if (digits(n).length < 7) return res.status(400).json({ error: 'Enter a valid phone number' }); if (n !== c.phone) { add('phone', n); ch.push(`phone ${c.phone || '—'} → ${n}`); } }
  for (const k of ['email', 'address']) if (b[k] !== undefined) add(k, String(b[k] || '').trim().slice(0, 300) || null);
  if (b.gstin !== undefined) { const g = String(b.gstin || '').trim().toUpperCase() || null; if (g && !blGstOk(g)) return res.status(400).json({ error: 'GSTIN should look like 33ABCDE1234F1Z5' }); if (g !== c.gstin) { add('gstin', g); ch.push(`GSTIN → ${g || '—'}`); } }
  if (b.state !== undefined) add('state', blState(b.state) || null);
  for (const k of ['city', 'pincode']) if (b[k] !== undefined) add(k, String(b[k] || '').trim().slice(0, 60) || null);
  if (!set.length) return res.json({ ok: true });
  await q(`UPDATE customers SET ${set.join(',')} WHERE id=$1`, val);
  if (ch.length) for (const sv of (await q(`SELECT id FROM services WHERE customer_id=$1 AND status NOT IN ('Resolved','Cancelled')`, [c.id])).rows) await log(sv.id, req.user.name, 'Customer edited: ' + ch.join(', '));
  res.json({ ok: true });
}));
// everything about one customer: tickets, payments, money still to come, leads with the same phone
app.get('/api/customers/:id/full', need('customers', 'service_create'), wrap(async (req, res) => {
  const p = [+req.params.id], sc = custScope(req.user, p);
  const c = (await q(`SELECT c.*, b.name brand FROM customers c LEFT JOIN brands b ON b.id=c.brand_id WHERE c.id=$1 AND ${sc}`, p)).rows[0];
  if (!c) return res.status(404).json({ error: 'Customer not found' });
  const sp = [c.id], sw = []; scope(req.user, sp, sw);
  const svc = (await q(`${SELECT} WHERE s.customer_id=$1${sw.length ? ' AND ' + sw.join(' AND ') : ''} ORDER BY s.submitted_on DESC`, sp)).rows.map(s => shape(s, req.user));
  const ids = svc.map(s => s.id);
  const pays = ids.length ? (await q(`SELECT p.id, p.service_id, p.amount, p.bank, p.note, p.approval, p.received_by, p.mode, p.actual, p.disc, to_char(p.paid_on,'YYYY-MM-DD') paid_on, p.created_at, s.ticket_no FROM payments p JOIN services s ON s.id=p.service_id WHERE p.service_id=ANY($1) ORDER BY p.created_at DESC`, [ids])).rows : [];
  const paid = pays.filter(x => x.approval !== 'Rejected').reduce((t, x) => t + Number(x.amount), 0);
  const out = svc.filter(s => ['Billing', 'Awaiting Payment'].includes(s.status)).map(s => {
    const coll = Math.max(0, Number(s.amount_received || 0) - Number(s.received_settled || 0)) + Math.max(0, Number(s.bank_amount || 0) - Number(s.bank_settled || 0));
    const billDue = s.bill_state === 'Billed' && s.status === 'Awaiting Payment' ? Number(s.bill_total || s.charges_applied || 0) : 0;
    return { id: s.id, ticket_no: s.ticket_no, status: s.status, bill_no: s.bill_no, bill_state: s.bill_state, quote: s.status === 'Billing' ? Number(s.bill_total || 0) : 0, due: billDue, with_tech: coll };
  });
  let leads = [];
  if (can(req.user, 'leads')) { const lp = [digits(c.phone).slice(-10)], lw = leadScope(req.user, lp); if (lp[0].length >= 7) leads = (await q(`SELECT l.id, l.name, l.company, l.stage, l.value, l.created_at, l.follow_up FROM leads l WHERE right(regexp_replace(COALESCE(l.phone,''),'\D','','g'),10)=$1 AND ${lw} ORDER BY l.created_at DESC`, lp)).rows; }
  const discount = svc.reduce((t, s) => t + Number(s.discount || 0), 0);
  const docs = can(req.user, 'billing') ? (await q(`SELECT id, type, no, to_char(doc_date,'YYYY-MM-DD') doc_date, total, paid, credited, status FROM bl_docs WHERE customer_id=$1 AND type<>'purchase' ORDER BY doc_date DESC, id DESC LIMIT 100`, [c.id])).rows : [];
  const blDue = docs.filter(d => d.type === 'invoice' && ['Unpaid', 'Partial'].includes(d.status)).reduce((t, d) => t + Number(d.total) - Number(d.paid) - Number(d.credited), 0) + Number(c.opening_bal || 0);
  res.json({ customer: c, services: svc, payments: pays, outstanding: out, leads, docs, bl_due: Math.round(blDue * 100) / 100,
    totals: { tickets: svc.length, open: svc.filter(s => !['Resolved', 'Cancelled'].includes(s.status)).length, paid: Math.round(paid * 100) / 100, discount, due: out.reduce((t, o) => t + o.due + o.quote, 0), with_tech: out.reduce((t, o) => t + o.with_tech, 0) } });
}));
app.get('/api/customers', need('customers', 'service_create'), wrap(async (req, res) => {
  const p = ['%' + (req.query.q || '') + '%'], sc = custScope(req.user, p);
  res.json((await q(`SELECT c.*, b.name brand, (SELECT COUNT(*)::int FROM services s WHERE s.customer_id=c.id) tickets FROM customers c LEFT JOIN brands b ON b.id=c.brand_id
    WHERE (c.name ILIKE $1 OR c.phone ILIKE $1 OR c.company ILIKE $1) AND ${sc} ORDER BY c.name LIMIT 100`, p)).rows);
}));
// customer picker for attendance requests (everyone): technicians see customers of their jobs (open jobs first)
app.get('/api/customers/pick', wrap(async (req, res) => {
  const p = ['%' + String(req.query.q || '').trim() + '%'], sc = custScope(req.user, p);
  const tp = isTech(req.user) ? `(SELECT COUNT(*) FROM services s3 WHERE s3.customer_id=c.id AND s3.status=ANY('{${OPEN_ST.join(',')}}') AND (s3.technician_id=${+req.user.id} OR s3.helper_id=${+req.user.id}))` : '0';
  res.json((await q(`SELECT c.id, c.name, c.phone, c.address, c.city, ${tp}::int open FROM customers c
    WHERE (c.name ILIKE $1 OR c.phone ILIKE $1 OR c.address ILIKE $1) AND ${sc} ORDER BY open DESC, c.name LIMIT 40`, p)).rows);
}));

app.get('/api/dashboard', need('dashboard'), wrap(async (req, res) => {
  const p = [], w = []; scope(req.user, p, w);
  if (!req.user.brand_id && +req.query.brand) { p.push(+req.query.brand); w.push(`s.brand_id=$${p.length}`); }
  const W = w.length ? 'WHERE ' + w.join(' AND ') : '', A = w.length ? ' AND ' + w.join(' AND ') : '';
  const one = async sql => (await q(sql, p)).rows[0];
  const k = await one(`SELECT COUNT(*)::int total,
    COUNT(*) FILTER (WHERE status='New Ticket')::int new_tickets,
    COUNT(*) FILTER (WHERE technician_id IS NULL AND status NOT IN ('Resolved','Cancelled'))::int unassigned,
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
  const load = (await q(`SELECT u.id, u.name, u.photo_v, COUNT(s.id)::int n, string_agg(DISTINCT b.name, ', ') brands FROM users u LEFT JOIN services s ON s.technician_id=u.id AND s.status IN ('Work Not Started','On-Process','Work Pending') LEFT JOIN brands b ON b.id=s.brand_id WHERE u.role='Technician' AND u.active GROUP BY u.id ORDER BY n DESC, u.name`)).rows;
  const recent = (await q(`${SELECT} ${W} ORDER BY s.submitted_on DESC LIMIT 5`, p)).rows.map(s => shape(s, req.user));
  const out = { ...k, byType, load, recent };
  if (can(req.user, 'view_charges')) Object.assign(out, { paid: paid.paid, paid_month: pm.paid, outstanding: Math.max(0, k.billed - paid.paid) }); else delete out.billed;
  res.json(out);
}));

// service engineers: who is free (no open job), who is busy and on what, who is away today
app.get('/api/services/engineers', need('service_assign', 'service_create', 'service_edit'), wrap(async (req, res) => {
  if (isTech(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const techs = await techList(), today = await todayIST(), mb = req.user.brand_id && !isSuper(req.user) ? req.user.brand_id : null;
  const info = {}; (await q(`SELECT id, phone FROM users WHERE role='Technician' AND active`)).rows.forEach(u => { info[u.id] = u; });
  const att = {}; (await q(`SELECT user_id, to_char(check_in AT TIME ZONE '${TZ}','HH24:MI') cin, to_char(check_out AT TIME ZONE '${TZ}','HH24:MI') cout, status FROM attendance WHERE day=$1`, [today])).rows.forEach(a => { att[a.user_id] = a; });
  const jobs = (await q(`SELECT s.id, s.ticket_no, s.status, s.brand_id, b.name brand, s.technician_id, s.helper_id, s.service_type, c.name customer, c.city
    FROM services s LEFT JOIN customers c ON c.id=s.customer_id LEFT JOIN brands b ON b.id=s.brand_id WHERE s.status=ANY($1::text[]) AND (s.technician_id IS NOT NULL OR s.helper_id IS NOT NULL) ORDER BY s.id`, [OPEN_ST])).rows;
  const last = {}; (await q(`SELECT technician_id id, MAX(COALESCE(work_done_on, resolved_on)) t FROM services WHERE technician_id IS NOT NULL AND status IN ('Resolved','Awaiting Payment','Billing') GROUP BY 1`)).rows.forEach(r => { last[r.id] = r.t; });
  const out = techs.map(t => {
    const J = jobs.filter(j => j.technician_id === t.id || j.helper_id === t.id).map(j => {
      const own = !mb || j.brand_id === mb;
      return { id: own ? j.id : null, ticket_no: j.ticket_no, status: j.status, brand: j.brand, helper: j.helper_id === t.id, customer: own ? j.customer : null, city: own ? j.city : null, service_type: own ? j.service_type : null };
    });
    const a = att[t.id];
    return { id: t.id, name: t.name, photo_v: t.photo_v, phone: can(req.user, 'view_phone') ? (info[t.id] || {}).phone : undefined, away: t.away, note: t.note, jobs: J,
      state: t.away ? 'away' : J.length ? 'busy' : 'free', checked_in: a && a.cin || null, checked_out: a && a.cout || null, att: a ? a.status : null, last_done: last[t.id] || null };
  });
  const rank = x => (x.state === 'free' ? 0 : x.state === 'busy' ? 1 : 2) * 10 + (x.checked_in && !x.checked_out ? 0 : 1);
  out.sort((x, y) => rank(x) - rank(y) || x.jobs.length - y.jobs.length || x.name.localeCompare(y.name));
  res.json({ items: out, free: out.filter(x => x.state === 'free').length, busy: out.filter(x => x.state === 'busy').length, away: out.filter(x => x.state === 'away').length });
}));
app.get('/api/services/counts', wrap(async (req, res) => {
  const { type, tech, kind, brand, q: search } = req.query, p = [], w = []; scope(req.user, p, w);   // counts follow the same filters as the list
  const add = (c, v) => { p.push(v); w.push(c.replace('?', '$' + p.length)); };
  if (type) add('s.service_type=?', type);
  if (kind) add(`COALESCE(s.kind,'Service')=?`, kind);
  if (brand && !req.user.brand_id && !isTech(req.user)) add('s.brand_id=?', +brand);
  if (tech && !isTech(req.user)) add('s.technician_id=?', tech);
  if (search) { p.push('%' + search + '%'); const n = p.length; p.push(String(search).replace(/\D/g, '')); w.push(`(c.name ILIKE $${n} OR s.request_details ILIKE $${n} OR c.phone ILIKE $${n} OR s.ticket_no::text=$${n + 1})`); }
  if (/^\d{4}-\d{2}$/.test(req.query.month || '')) { p.push(req.query.month); w.push(`(to_char(s.submitted_on AT TIME ZONE 'Asia/Kolkata','YYYY-MM')=$${p.length} OR (s.status NOT IN ('Resolved','Cancelled') AND to_char(s.submitted_on AT TIME ZONE 'Asia/Kolkata','YYYY-MM')<$${p.length}))`); }
  const r = await q(`SELECT s.status, COUNT(*)::int n FROM services s LEFT JOIN customers c ON c.id=s.customer_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} GROUP BY s.status`, p);
  const out = { ALL: 0 }; r.rows.forEach(x => { out[x.status] = x.n; out.ALL += x.n; });
  out.UNASSIGNED = (await q(`SELECT COUNT(*)::int n FROM services s LEFT JOIN customers c ON c.id=s.customer_id WHERE s.technician_id IS NULL AND s.status NOT IN ('Resolved','Cancelled')${w.length ? ' AND ' + w.join(' AND ') : ''}`, p)).rows[0].n;
  res.json(out);
}));

app.get('/api/services', wrap(async (req, res) => {
  if (!isTech(req.user) && !can(req.user, 'services')) return res.status(403).json({ error: 'Not allowed' });
  const { status, type, tech, approval, kind, brand, q: search } = req.query, w = [], p = [];
  scope(req.user, p, w);
  const add = (c, v) => { p.push(v); w.push(c.replace('?', '$' + p.length)); };
  if (status === 'UNASSIGNED') w.push(`s.technician_id IS NULL AND s.status NOT IN ('Resolved','Cancelled')`);
  else if (status && status !== 'ALL') add('s.status=?', status);
  if (type) add('s.service_type=?', type);
  if (kind) add(`COALESCE(s.kind,'Service')=?`, kind);
  if (brand && !req.user.brand_id && !isTech(req.user)) add('s.brand_id=?', +brand);
  if (tech && !isTech(req.user)) add('s.technician_id=?', tech);
  if (approval) add('s.approval=?', approval);
  if (search) { p.push('%' + search + '%'); const n = p.length; p.push(search.replace(/\D/g, '')); w.push(`(c.name ILIKE $${n} OR s.request_details ILIKE $${n} OR c.phone ILIKE $${n} OR s.ticket_no::text=$${n + 1})`); }
  if (/^\d{4}-\d{2}$/.test(req.query.month || '')) { p.push(req.query.month); w.push(`(to_char(s.submitted_on AT TIME ZONE 'Asia/Kolkata','YYYY-MM')=$${p.length} OR (s.status NOT IN ('Resolved','Cancelled') AND to_char(s.submitted_on AT TIME ZONE 'Asia/Kolkata','YYYY-MM')<$${p.length}))`); }
  if (req.query.billing) w.push(`(s.status='Billing' OR (s.bill_state='Billed' AND s.status='Awaiting Payment'))`);
  if (req.query.board) {   // pipeline view: every open ticket + the latest 15 resolved
    const base = w.length ? w.join(' AND ') + ' AND ' : '';
    const o = await q(`${SELECT} WHERE ${base}s.status NOT IN ('Resolved','Cancelled') ORDER BY s.submitted_on DESC LIMIT 400`, p);
    const d = await q(`${SELECT} WHERE ${base}s.status='Resolved' ORDER BY s.resolved_on DESC NULLS LAST LIMIT 15`, p);
    return res.json([...o.rows, ...d.rows].map(s => shape(s, req.user)));
  }
  const r = await q(`${SELECT} ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY s.submitted_on DESC LIMIT 500`, p);
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
  const voices = (await q(`SELECT id, user_id, user_name, role, duration, created_at FROM service_voice WHERE service_id=$1 ORDER BY id`, [s.id])).rows;
  res.json({ ...shape(s, req.user), payments: pay.rows, history: hist.rows, photos: ph.rows, previous, voices });
}));

app.post('/api/services', need('service_create'), wrap(async (req, res) => {
  const b = req.body; let cid = b.customer_id;
  const kind = b.kind === 'Job' ? 'Job' : 'Service';
  if (!String(b.service_type || '').trim()) return res.status(400).json({ error: kind === 'Job' ? 'Choose the job type' : 'Choose the issue type' });
  // staff tied to a brand always create for their own brand (e.g. Heaven); Super Admin picks the brand
  let brandId = req.user.brand_id || (Number.isInteger(+b.brand_id) && +b.brand_id > 0 ? +b.brand_id : null);
  if (brandId && !(await q('SELECT 1 FROM brands WHERE id=$1', [brandId])).rows.length) return res.status(400).json({ error: 'Brand not found' });
  if (!brandId) brandId = (await q(`SELECT id FROM brands ORDER BY (lower(name)='heaven') DESC, id LIMIT 1`)).rows[0].id;
  if (cid) {
    const cp = [+cid], csc = custScope(req.user, cp);
    if (!(await q(`SELECT 1 FROM customers c WHERE c.id=$1 AND ${csc}`, cp)).rows.length) return res.status(400).json({ error: 'Customer not found' });
    await q('UPDATE customers SET brand_id=COALESCE(brand_id,$2) WHERE id=$1', [+cid, brandId]);
    if (b.company !== undefined && String(b.company || '').trim()) await q('UPDATE customers SET company=$2 WHERE id=$1', [+cid, String(b.company).trim().slice(0, 120)]);
  }
  if (!cid) {
    b.name = String(b.name || '').trim(); b.phone = String(b.phone || '').trim();
    if (!b.name) b.name = String(b.company || '').trim() || `Customer ${digits(b.phone).slice(-4)}`;   // name and company are optional
    if (digits(b.phone).length < 7) return res.status(400).json({ error: 'Enter a valid phone number' });
    const m = /@(-?\d+\.\d+),(-?\d+\.\d+)|[?&](?:q|ll|query)=(-?\d+\.\d+),(-?\d+\.\d+)/.exec(b.map_url || '');
    cid = (await q('INSERT INTO customers(name,phone,email,address,map_url,lat,lng,brand_id,company) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
      [b.name, b.phone, b.email, b.address, b.map_url || null, m ? +(m[1] || m[3]) : null, m ? +(m[2] || m[4]) : null, brandId, String(b.company || '').trim().slice(0, 120) || null])).rows[0].id;
  }
  const ticket = 100000 + crypto.randomInt(899999);
  const r = await q(`INSERT INTO services(ticket_no,customer_id,product,request_details,service_type,visit_type,charges_applied,kind,brand_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [ticket, cid, b.product, b.request_details, b.service_type || 'Other', b.visit_type || 'Onsite', b.charges_applied || 0, kind, brandId]);
  await log(r.rows[0].id, req.user.name, (kind === 'Job' ? 'Job' : 'Ticket') + ' created');
  await q('UPDATE services SET created_by=$2 WHERE id=$1', [r.rows[0].id, req.user.id]);
  if (isSuper(req.user)) {   // MD created it → tell that brand's admin staff, so they see and handle it
    const adm = (await q(`SELECT id FROM users WHERE active AND role='Admin' AND (brand_id IS NULL OR brand_id=$1)`, [brandId])).rows.map(x => x.id);
    const cn = ((await q('SELECT name FROM customers WHERE id=$1', [cid])).rows[0] || {}).name || '', bn = ((await q('SELECT name FROM brands WHERE id=$1', [brandId])).rows[0] || {}).name || '';
    if (adm.length) await notify(adm, `👔 MD created a ${kind === 'Job' ? 'job' : 'service'}`, `#${ticket} · ${cn}${bn ? ' · ' + bn : ''} · ${b.service_type || 'Other'}`, r.rows[0].id);
  }
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
    if (busy && !b.force) return res.status(409).json({ busy: true, error: `${busy.name} is already allocated to ${busy.brand || 'another brand'} (job #${busy.ticket_no}). Do you still want to allocate?` });
    if (busy) b._busyNote = (b._busyNote || []).concat(`${busy.name} is also on ${busy.brand || 'another brand'} job #${busy.ticket_no}`);
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
  if (['Awaiting Payment', 'Resolved'].includes(b.status) && !['Awaiting Payment', 'Resolved'].includes(cur.status)) sets.push('work_done_on=COALESCE(work_done_on,now())');
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
  if (sets.length) { p.push(id); await q(`UPDATE services SET ${sets.join(',')} WHERE id=$${p.length}`, p); await log(id, req.user.name, changes.join('; ') + (b._busyNote ? ' (allocated anyway: ' + b._busyNote.join('; ') + ')' : '')); }
  if (newTech || newHelp || removed.length) {
    const c = (await q('SELECT name FROM customers WHERE id=$1', [cur.customer_id])).rows[0], br = (await q('SELECT name FROM brands WHERE id=$1', [cur.brand_id])).rows[0];
    const tn = names[fTech] || '—', hn = fHelp ? names[fHelp] : null, where = `#${cur.ticket_no} · ${c ? c.name : ''}${br ? ' · ' + br.name : ''}`;
    if (newTech) await notify([newTech], 'New job assigned', `${where}${hn ? ' — helper: ' + hn : ''} — open My Jobs to start`, cur.id);
    if (newHelp) await notify([newHelp], 'You are the helper on a job', `${where} — technician: ${tn}. Open My Jobs to see the work.`, cur.id);
    if (!newTech && newHelp && fTech) await notify([fTech], 'Helper added', `${hn} will help you on #${cur.ticket_no}`, cur.id);
    if (removed.length) await notify(removed, 'Service reallocated', `#${cur.ticket_no} · ${c ? c.name : ''} — this service was allocated to another person`, null);
    if (isSuper(req.user) && (newTech || newHelp)) {   // MD allocated → the brand's admin staff should know
      const adm = (await q(`SELECT id FROM users WHERE active AND role='Admin' AND (brand_id IS NULL OR brand_id=$1)`, [cur.brand_id])).rows.map(x => x.id);
      if (adm.length) await notify(adm, '👔 MD allocated a service', `${where} → ${tn}${hn ? ' + helper ' + hn : ''}`, cur.id);
    }
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
  if (!['Free', 'Paid', 'Billing'].includes(billing)) return res.status(400).json({ error: 'Choose Free service, Paid service or Billing' });
  if (billing === 'Billing') {   // office prepares a quotation / bill — the job leaves the technician's list
    await q(`UPDATE services SET status='Billing', work_status='Done', work_done_on=now(), completion_note=$2, pending_reason=NULL, billing_type='Billing', bill_state=COALESCE(bill_state,'Quotation') WHERE id=$1`, [s.id, b.note || null]);
    await log(s.id, req.user.name, 'Work done' + (b.note ? ': ' + b.note : '') + ' · sent for billing');
    const billers = (await q(`SELECT id FROM users WHERE active AND (role=$1 OR ('billing'=ANY(permissions) AND (brand_id IS NULL OR brand_id=$2)))`, [SUPER, s.brand_id])).rows.map(x => x.id);
    await notify(billers, '🧾 Ready for billing', `${req.user.name} finished #${s.ticket_no} — prepare the quotation / bill`, s.id);
    return res.json({ ok: true });
  }
  let mode = null, amt = 0;
  if (billing === 'Paid') {
    mode = b.mode;
    if (!['Cash', 'Bank'].includes(mode)) return res.status(400).json({ error: 'Choose how the customer paid: Cash or Bank' });
    amt = money(b.amount);
    if (amt <= 0) return res.status(400).json({ error: mode === 'Cash' ? 'Enter the cash amount received' : 'Enter the amount transferred' });
  }
  const cash = mode === 'Cash' ? amt : 0, bank = mode === 'Bank' ? amt : 0;
  await q(`UPDATE services SET status='Awaiting Payment', work_status='Done', work_done_on=now(), completion_note=$2, pending_reason=NULL, amount_received=amount_received+$3, billing_type=$4, pay_mode=$5, bank_amount=$6 WHERE id=$1`,
    [s.id, b.note || null, cash, billing, mode, bank]);
  const shot = mode === 'Bank' && (await q(`SELECT 1 FROM service_photos WHERE service_id=$1 AND stage='Payment' LIMIT 1`, [s.id])).rows.length > 0;
  const what = billing === 'Free' ? 'Free service' : mode === 'Cash' ? `Paid · Cash ₹${amt}` : `Paid · Bank ₹${amt}${shot ? ' (screenshot attached)' : ' (no screenshot)'}`;
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
const billSvc = async (req, res) => {
  const s = (await q('SELECT * FROM services WHERE id=$1', [req.params.id])).rows[0];
  if (!s) { res.status(404).json({ error: 'Not found' }); return null; }
  if (!brandOK(req.user, s)) { res.status(403).json({ error: 'This ticket belongs to another brand' }); return null; }
  return s;
};
const billLines = items => (Array.isArray(items) ? items : []).slice(0, 60).map(i => ({ d: String(i.d || '').trim().slice(0, 200), q: Math.max(0, +i.q || 0), r: Math.max(0, Math.round((+i.r || 0) * 100) / 100) })).filter(i => i.d || i.r);
// quotation: free notes + lines (description, qty, rate) — saved as many times as needed
app.put('/api/services/:id/bill', need('billing'), wrap(async (req, res) => {
  const s = await billSvc(req, res); if (!s) return;
  if (s.bill_state === 'Billed' && s.status !== 'Billing') return res.status(400).json({ error: 'Already billed' });
  const items = billLines((req.body || {}).items), total = Math.round(items.reduce((t, i) => t + i.q * i.r, 0) * 100) / 100;
  await q(`UPDATE services SET bill_items=$2, bill_note=$3, bill_total=$4, bill_state=COALESCE(NULLIF(bill_state,''),'Quotation') WHERE id=$1`, [s.id, JSON.stringify(items), String((req.body || {}).note || '').slice(0, 4000) || null, total]);
  await log(s.id, req.user.name, `Quotation saved · ₹${total}`); res.json({ ok: true, total });
}));
// quotation → bill: amount becomes due, ticket moves to Payment
app.post('/api/services/:id/bill/convert', need('billing'), wrap(async (req, res) => {
  const s = await billSvc(req, res); if (!s) return;
  if (!(+s.bill_total > 0)) return res.status(400).json({ error: 'Add the quotation lines first' });
  if (s.bill_state === 'Billed') return res.status(400).json({ error: 'Already billed' });
  const no = (await q(`SELECT COALESCE(MAX(bill_no),1000)+1 n FROM services`)).rows[0].n;
  await q(`UPDATE services SET bill_state='Billed', bill_no=$2, billed_at=now(), charges_applied=bill_total, status='Awaiting Payment', work_done_on=COALESCE(work_done_on,now()) WHERE id=$1`, [s.id, no]);
  await log(s.id, req.user.name, `Bill #${no} created · ₹${s.bill_total} — waiting for the customer’s payment`); res.json({ ok: true, bill_no: no });
}));
app.post('/api/services/:id/settle', need('payments'), wrap(async (req, res) => {
  const s = (await q('SELECT * FROM services WHERE id=$1', [req.params.id])).rows[0];
  if (!s) return res.status(404).json({ error: 'Not found' });
  if (!brandOK(req.user, s)) return res.status(403).json({ error: 'This ticket belongs to another brand' });
  const cashDue = Math.max(0, Number(s.amount_received) - Number(s.received_settled)), bankDue = Math.max(0, Number(s.bank_amount || 0) - Number(s.bank_settled || 0)), close = s.status === 'Awaiting Payment';
  if (!close && cashDue <= 0 && bankDue <= 0) return res.status(400).json({ error: 'Nothing to settle' });
  const b = req.body || {}, cashBank = BANKS.includes(b.bank) ? b.bank : null, trBank = BANKS.includes(b.transfer_bank) ? b.transfer_bank : null;
  // discount: actual amount − discount = final amount (shown to the customer)
  const disc = b.discount_on ? money(b.discount) : 0, actual = b.discount_on ? money(b.actual) : null;
  if (b.discount_on && (actual <= 0 || disc > actual)) return res.status(400).json({ error: 'Enter the actual amount and a discount that is not more than it' });
  // a bill made in the office: the customer pays the office directly
  if (s.bill_state === 'Billed' && cashDue <= 0 && bankDue <= 0 && close) {
    const due = Number(s.bill_total) || 0, act = actual ?? due, fin = Math.round((act - disc) * 100) / 100, mode = ['Cash', 'Bank', 'UPI'].includes(b.mode) ? b.mode : null;
    if (!mode) return res.status(400).json({ error: 'Choose how the customer paid: Cash, Bank or UPI' });
    const acc = BANKS.includes(b.account) ? b.account : null;
    if (mode !== 'Cash' && !acc) return res.status(400).json({ error: 'Choose the account that received the money' });
    await q(`INSERT INTO payments(service_id,amount,bank,note,approval,received_by,mode,actual,disc) VALUES($1,$2,$3,$4,'Approved',$5,$6,$7,$8)`, [s.id, fin, acc || cashBank, `Bill #${s.bill_no}${disc ? ` · discount ₹${disc}` : ''}`, req.user.name, mode, act, disc]);
    await q(`UPDATE services SET charges_applied=$2, discount=COALESCE(discount,0)+$3, status='Resolved', resolved_on=now(), approval='Approved' WHERE id=$1`, [s.id, act, disc]);
    await log(s.id, req.user.name, `Payment received · ${mode} ₹${fin}${disc ? ` (actual ₹${act} − discount ₹${disc})` : ''} — bill #${s.bill_no} closed`);
    await blTicketPaid(s.id, fin, mode, acc, req.user.name);
    await notify([s.technician_id, s.helper_id], 'Job closed', `#${s.ticket_no}: customer paid the bill — work completed`, s.id);
    return res.json({ ok: true });
  }
  if (disc || actual) await q(`UPDATE services SET charges_applied=$2, discount=COALESCE(discount,0)+$3 WHERE id=$1`, [s.id, actual ?? (cashDue + bankDue + disc), disc]);
  if (bankDue > 0 && !trBank) return res.status(400).json({ error: 'Choose the bank account that received the transfer' });
  if (cashDue > 0) await q(`INSERT INTO payments(service_id,amount,bank,note,approval) VALUES($1,$2,$3,'Cash handed over by technician','Approved')`, [s.id, cashDue, cashBank]);
  if (bankDue > 0) await q(`INSERT INTO payments(service_id,amount,bank,note,approval) VALUES($1,$2,$3,'Bank transfer · screenshot verified','Approved')`, [s.id, bankDue, trBank]);
  if (cashDue > 0 || bankDue > 0) await q(`UPDATE payments SET received_by=$2, mode=COALESCE(mode, CASE WHEN note LIKE 'Cash%' THEN 'Cash' ELSE 'Bank' END) WHERE service_id=$1 AND received_by IS NULL`, [s.id, req.user.name]);
  if (disc) await q(`UPDATE payments SET actual=$2, disc=$3, note=note||$4 WHERE id=(SELECT MAX(id) FROM payments WHERE service_id=$1)`, [s.id, actual, disc, ` · discount ₹${disc}`]);
  await q(`UPDATE services SET received_settled=amount_received, bank_settled=COALESCE(bank_amount,0)${close ? `, status='Resolved', resolved_on=now(), work_done_on=COALESCE(work_done_on,now()), approval='Approved'` : ''} WHERE id=$1`, [s.id]);
  const parts = [cashDue > 0 && `cash ₹${cashDue} from technician`, bankDue > 0 && `bank ₹${bankDue} confirmed`].filter(Boolean).join(' + ');
  await log(s.id, req.user.name, (parts ? `Payment received: ${parts}` : 'Free service confirmed') + (disc ? ` · actual ₹${actual} − discount ₹${disc}` : '') + (close ? ' — work completed' : ''));
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
  const crew = (await q(`SELECT ${CREW_COLS} FROM services s WHERE (s.technician_id=$1 OR s.helper_id=$1)`, [id, (await todayIST()).slice(0, 7)])).rows[0];
  k.crew = crew;
  const next = (await q(`${SELECT} WHERE (s.technician_id=$1 OR s.helper_id=$1) AND s.status IN ('New Ticket','Work Not Started','On-Process','Work Pending') ORDER BY (s.status='On-Process') DESC, s.assigned_on DESC NULLS LAST LIMIT 5`, [id])).rows.map(s => shape(s, req.user));
  res.json({ ...k, hold: c.hold, handed: c.handed, next });
}));
// Super Admin: delete old data (choose what). Team logins, brands, issue & job types stay.
const WIPE = {
  // numbers restart from 1, so links from other places to the deleted rows are cleared first (else they would point at new, unrelated rows)
  services: 'UPDATE wa_threads SET customer_id=NULL; UPDATE bl_docs SET customer_id=NULL; UPDATE fv_visits SET customer_id=NULL; UPDATE leads SET customer_id=NULL; TRUNCATE services, customers, payments, service_history, service_photos RESTART IDENTITY CASCADE',
  leads: 'UPDATE wa_threads SET lead_id=NULL; UPDATE bl_docs SET lead_id=NULL; UPDATE fv_visits SET lead_id=NULL; DELETE FROM chats WHERE lead_id IS NOT NULL; TRUNCATE leads, lead_activity RESTART IDENTITY CASCADE',
  todos: 'TRUNCATE todos RESTART IDENTITY',
  attendance: 'TRUNCATE attendance, leave_requests RESTART IDENTITY',
  notifications: 'TRUNCATE notifications RESTART IDENTITY',
  notes: 'TRUNCATE notes RESTART IDENTITY',
  whatsapp: 'TRUNCATE wa_threads, wa_messages, wa_reads RESTART IDENTITY',
  warranty: 'TRUNCATE wc_cases, wc_media, wc_payments, wc_vendors RESTART IDENTITY CASCADE',
  billing: 'TRUNCATE bl_docs, bl_payments, bl_stock, bl_expenses, bl_products, bl_vendors RESTART IDENTITY CASCADE',
  projects: `DELETE FROM chats WHERE project_id IS NOT NULL; TRUNCATE projects, project_tasks RESTART IDENTITY`,
  chat: `DELETE FROM chats WHERE kind NOT IN ('all','project'); TRUNCATE chat_messages RESTART IDENTITY; UPDATE chat_members SET last_read=0`,
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
  await q('INSERT INTO payments(service_id,amount,bank,paid_on,note,received_by) VALUES($1,$2,$3,COALESCE($4,CURRENT_DATE),$5,$6)', [req.params.id, b.amount, b.bank, b.paid_on || null, b.note, req.user.name]);
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
    lw += ' AND ' + leadScope(req.user, lp);
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
    const lp = [from, to], lw = ' AND ' + leadScope(req.user, lp);
    (await q(`SELECT to_char(l.follow_up,'YYYY-MM-DD') d, COUNT(*)::int n FROM leads l WHERE l.stage IN ('New Enquiry','Contacted','Site Visit','Quotation','Negotiation') AND l.follow_up BETWEEN $1::date AND $2::date${lw} GROUP BY 1`, lp)).rows
      .forEach(r => { (out[r.d] = out[r.d] || { n: 0, v: 0, l: 0 }).l = r.n; });
  }
  (await q(`SELECT to_char(day,'YYYY-MM-DD') d, COUNT(*)::int n FROM notes WHERE user_id=$1 AND day BETWEEN $2::date AND $3::date GROUP BY 1`, [req.user.id, from, to])).rows
    .forEach(r => { (out[r.d] = out[r.d] || { n: 0, v: 0, l: 0 }).nt = r.n; });
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
  if (forUser !== req.user.id && !can(req.user, 'voice_assign')) forUser = req.user.id;   // only people allowed to send work to others
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
  if (b.for_user !== undefined && can(req.user, 'voice_assign') && Number.isInteger(+b.for_user) && +b.for_user > 0) put('for_user=?', +b.for_user);
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

// ---------- technician & helper counts ----------
// $1 = technician id, $2 = 'YYYY-MM'.  "finished" = work done (Awaiting Payment or Resolved).
const DONE = `s.status IN ('Billing','Awaiting Payment','Resolved')`, INM = c => `to_char(${c} AT TIME ZONE 'Asia/Kolkata','YYYY-MM')=$2`, OPEN = `s.status IN ('New Ticket','Work Not Started','On-Process','Work Pending')`;
const CREW_COLS = `COUNT(*) FILTER (WHERE s.technician_id=$1 AND ${INM('COALESCE(s.assigned_on,s.submitted_on)')})::int tech_assigned,
  COUNT(*) FILTER (WHERE s.technician_id=$1 AND ${DONE} AND ${INM('s.work_done_on')})::int tech_done,
  COUNT(*) FILTER (WHERE s.helper_id=$1 AND ${INM('COALESCE(s.assigned_on,s.submitted_on)')})::int helper_assigned,
  COUNT(*) FILTER (WHERE s.helper_id=$1 AND ${DONE} AND ${INM('s.work_done_on')})::int helper_done,
  COUNT(*) FILTER (WHERE s.technician_id=$1 AND ${OPEN})::int tech_open, COUNT(*) FILTER (WHERE s.helper_id=$1 AND ${OPEN})::int helper_open,
  COUNT(*) FILTER (WHERE s.technician_id=$1 AND ${DONE})::int tech_done_total, COUNT(*) FILTER (WHERE s.helper_id=$1 AND ${DONE})::int helper_done_total`;
app.get('/api/crew/stats', wrap(async (req, res) => {
  if (!(isBoss(req.user) || can(req.user, 'dashboard') || can(req.user, 'service_assign'))) return res.status(403).json({ error: 'Not allowed' });
  const m = isMonth(req.query.month) ? req.query.month : (await todayIST()).slice(0, 7);
  const bid = req.user.brand_id || (+req.query.brand || null);
  const techs = (await q(`SELECT id,name,photo_v FROM users WHERE role='Technician' AND active ORDER BY name`)).rows, out = [];
  for (const t of techs) {
    const p = [t.id, m]; let w = '(s.technician_id=$1 OR s.helper_id=$1)';
    if (bid) { p.push(bid); w += ` AND s.brand_id=$3`; }
    const c = (await q(`SELECT ${CREW_COLS} FROM services s WHERE ${w}`, p)).rows[0];
    const last = (await q(`SELECT s.ticket_no, s.status, c.name customer, CASE WHEN s.helper_id=$1 THEN 'helper' ELSE 'technician' END as_role, tt.name technician, hh.name helper, br.name brand
      FROM services s LEFT JOIN customers c ON c.id=s.customer_id LEFT JOIN users tt ON tt.id=s.technician_id LEFT JOIN users hh ON hh.id=s.helper_id LEFT JOIN brands br ON br.id=s.brand_id
      WHERE ${w.replace('$3', '$2')} AND ${OPEN} ORDER BY s.assigned_on DESC NULLS LAST LIMIT 5`, bid ? [t.id, bid] : [t.id])).rows;
    out.push({ ...t, ...c, open_jobs: last });
  }
  res.set('Cache-Control', 'no-store').json({ month: m, rows: out });
}));

// ---------- add extra work to an existing service / job ----------
app.post('/api/services/:id/extra', need('service_edit', 'service_create'), wrap(async (req, res) => {
  const cur = (await q('SELECT * FROM services WHERE id=$1', [req.params.id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'Not found' });
  if (!brandOK(req.user, cur)) return res.status(403).json({ error: 'This ticket belongs to another brand' });
  const b = req.body || {}, text = String(b.text || '').trim().slice(0, 1500), charge = can(req.user, 'view_charges') ? Math.max(0, money(b.charge)) : 0;
  if (!text) return res.status(400).json({ error: 'Describe the extra work' });
  if (cur.status === 'Cancelled') return res.status(400).json({ error: 'This ticket was cancelled' });
  const when = new Date().toLocaleString('en-IN', { timeZone: TZ, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
  const add = `➕ Extra work (${when}, ${req.user.name}): ${text}${charge ? ` — ₹${charge}` : ''}`;
  let st = cur.status; const reopen = b.reopen !== false && ['Resolved', 'Awaiting Payment'].includes(cur.status);
  if (reopen) st = cur.technician_id ? 'Work Not Started' : 'New Ticket';
  await q(`UPDATE services SET request_details=TRIM(BOTH E'\\n' FROM COALESCE(request_details,'') || E'\\n\\n' || $1), charges_applied=charges_applied+$2, status=$3${reopen ? `, approval='Pending', work_status=NULL, resolved_on=NULL` : ''} WHERE id=$4`, [add, charge, st, cur.id]);
  await log(cur.id, req.user.name, add + (reopen ? ` · reopened (${cur.status} → ${st})` : ''));
  await notify([cur.technician_id, cur.helper_id].filter(x => x && x !== req.user.id), '➕ Extra work added', `#${cur.ticket_no}: ${text}`, cur.id);
  res.json({ ok: true, status: st });
}));

// ---------- voice messages on leads ----------
app.post('/api/leads/:id/voice', need('leads'), wrap(async (req, res) => {   // voice note on a lead goes into the lead discussion
  const l = await leadOK(req, res, req.params.id); if (!l) return;
  const c = await leadChat(l), r = await chatPost(req.user, c, { audio: (req.body || {}).audio, duration: (req.body || {}).duration });
  res.status(r.error ? 400 : 200).json(r);
}));
app.get('/api/lead-voice/:id', need('leads'), wrap(async (req, res) => {
  const v = (await q('SELECT lead_id, audio, mime FROM lead_voice WHERE id=$1', [req.params.id])).rows[0];
  if (!v) return res.status(404).end();
  const p = [v.lead_id], sc = leadScope(req.user, p);
  if (!(await q(`SELECT 1 FROM leads l WHERE l.id=$1 AND ${sc}`, p)).rows.length) return res.status(404).end();
  const buf = v.audio, total = buf.length, range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  res.set({ 'Content-Type': v.mime || 'audio/webm', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=86400' });
  if (range) { const st = range[1] ? +range[1] : 0, en = range[2] ? Math.min(+range[2], total - 1) : total - 1; res.status(206).set('Content-Range', `bytes ${st}-${en}/${total}`).send(buf.subarray(st, en + 1)); }
  else res.send(buf);
}));
app.delete('/api/lead-voice/:id', superOnly, wrap(async (req, res) => { await q('DELETE FROM lead_voice WHERE id=$1', [req.params.id]); res.json({ ok: true }); }));

// ---------- speak a reminder: "tomorrow 10 am call Kumar" → a to-do ----------
// Used by the in-app 🗣 button, Siri Shortcuts and Google Assistant (via the personal link).
const WD = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function parseReminder(raw, today, nowHM) {
  let t = ' ' + String(raw || '').toLowerCase().replace(/[,.!?]/g, ' ').replace(/\s+/g, ' ') + ' ';
  const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  let date = null, time = null; const cuts = [], cut = re => { cuts.push(String(re).trim()); t = t.replace(re, ' '); };
  let m;
  if ((m = / in (\d{1,3}) (minute|minutes|min|mins|hour|hours|hr|hrs) /.exec(t))) {
    const mins = /h/.test(m[2]) ? +m[1] * 60 : +m[1], [h, mi] = nowHM.split(':').map(Number), tot = h * 60 + mi + mins;
    date = addDays(today, Math.floor(tot / 1440)); time = `${String(Math.floor(tot % 1440 / 60)).padStart(2, '0')}:${String(tot % 60).padStart(2, '0')}`; cut(m[0]);
  }
  if (!date && (m = / (day after tomorrow|day after tommorow|day after tmrw|overmorrow) /.exec(t))) { date = addDays(today, 2); cut(m[0]); }
  if (!date && (m = / (tomorrow|tommorow|tomorow|tommorrow|tmrw|tmr|nalaiku|naalai|kal) /.exec(t))) { date = addDays(today, 1); cut(m[0]); }
  if (!date && (m = / (today|tonight|this evening|this morning|this afternoon|inniki|aaj) /.exec(t))) { date = today; if (/tonight/.test(m[1])) time = '20:00'; if (/evening/.test(m[1])) time = '18:00'; if (/morning/.test(m[1])) time = '10:00'; if (/afternoon/.test(m[1])) time = '14:00'; cut(m[0]); }
  if (!date && (m = / in (\d{1,2}) days? /.exec(t))) { date = addDays(today, +m[1]); cut(m[0]); }
  if (!date && (m = / next week /.exec(t))) { date = addDays(today, 7); cut(m[0]); }
  if (!date && (m = new RegExp(` (?:on |this |next |coming )?(${WD.join('|')}) `).exec(t))) {
    const want = WD.indexOf(m[1]), cur = new Date(today + 'T12:00:00Z').getUTCDay(); let n = (want - cur + 7) % 7; if (n === 0 || / next /.test(m[0])) n = n || 7; date = addDays(today, n); cut(m[0]);
  }
  if (!date && (m = new RegExp(` (?:on )?(\\d{1,2})(?:st|nd|rd|th)? (?:of )?(${MON.join('|')})[a-z]* `).exec(t) || new RegExp(` (?:on )?(${MON.join('|')})[a-z]* (\\d{1,2})(?:st|nd|rd|th)? `).exec(t))) {
    const isNumFirst = /^\d/.test(m[1]), day = +(isNumFirst ? m[1] : m[2]), mon = MON.indexOf((isNumFirst ? m[2] : m[1]).slice(0, 3));
    let y = +today.slice(0, 4), d = `${y}-${String(mon + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`; if (d < today) d = `${y + 1}${d.slice(4)}`; date = d; cut(m[0]);
  }
  if (!date && (m = / (?:on )?(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))? /.exec(t))) {
    let y = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : +today.slice(0, 4), d = `${y}-${String(+m[2]).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`; if (!m[3] && d < today) d = `${y + 1}${d.slice(4)}`; date = d; cut(m[0]);
  }
  if (!date && (m = / (?:on )?the (\d{1,2})(?:st|nd|rd|th) /.exec(t))) { let d = `${today.slice(0, 8)}${String(+m[1]).padStart(2, '0')}`; if (d < today) { const x = new Date(today.slice(0, 8) + '01T12:00:00Z'); x.setUTCMonth(x.getUTCMonth() + 1); d = x.toISOString().slice(0, 8) + String(+m[1]).padStart(2, '0'); } date = d; cut(m[0]); }
  if (!time && (m = / (?:at |by |around )?(\d{1,2})(?:[:.](\d{2}))? ?(am|pm|a m|p m|o'?clock|mani)? /.exec(t)) && (m[3] || m[2] || / (at|by|around) /.test(m[0]))) {
    let h = +m[1], mi = +(m[2] || 0); const ap = (m[3] || '').replace(' ', '');
    if (h <= 24 && mi < 60) { if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0; if (!ap.match(/am|pm/) && h >= 1 && h <= 7) h += 12; time = `${String(h % 24).padStart(2, '0')}:${String(mi).padStart(2, '0')}`; cut(m[0]); }
  }
  if (!time && (m = / (?:in the )?(morning|afternoon|evening|night|noon|lunch) /.exec(t))) { time = { morning: '10:00', afternoon: '14:00', evening: '18:00', night: '20:00', noon: '12:00', lunch: '13:00' }[m[1]]; cut(m[0]); }
  if (!date) date = time && time <= nowHM ? addDays(today, 1) : today;
  if (!time) { if (date === today) { const [h] = nowHM.split(':').map(Number); time = `${String(Math.min(23, h + 1)).padStart(2, '0')}:00`; } else time = '10:00'; }
  // keep the person's own capitals (names like Kumar): remove the date/time words from the original text
  let o = ' ' + String(raw || '').replace(/[,.!?]/g, ' ').replace(/\s+/g, ' ') + ' ';
  for (const c of cuts) { const re = new RegExp(' ' + c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+') + ' ', 'i'); o = o.replace(re, ' '); }
  t = o;
  t = t.replace(/ (hey siri|ok google|okay google|hey google|rago crm|rago) /gi, ' ').replace(/^ *(please )?(set (a |an )?)?(remind(er)?s?( me)?( to| about| for| that)?|add (a )?(reminder|task|todo|to-do)( to| for)?|create (a )?(reminder|task)( to| for)?|note( that)?) /i, ' ')
    .replace(/ (set|a|an) (reminder|alarm) (for|to)? /gi, ' ').replace(/^ *(to|for|about) /i, ' ').replace(/\s+/g, ' ').trim();
  const title = t ? t[0].toUpperCase() + t.slice(1) : 'Reminder';
  return { title: title.slice(0, 200), due_date: date, due_time: time };
}
const nowHMIST = () => new Date().toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const prettyWhen = (d, t) => `${new Date(d + 'T12:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })} at ${(() => { const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`; })()}`;
app.post('/api/reminders/parse', wrap(async (req, res) => res.json(parseReminder((req.body || {}).text, await todayIST(), nowHMIST()))));
const tokenUser = async tok => /^[a-f0-9]{40}$/.test(String(tok || '')) ? (await q('SELECT id,name,role,brand_id,permissions FROM users WHERE cal_token=$1 AND active', [tok])).rows[0] : null;
app.get('/api/me/links', wrap(async (req, res) => {
  let tok = ((await q('SELECT cal_token FROM users WHERE id=$1', [req.user.id])).rows[0] || {}).cal_token;
  if (!tok || req.query.reset) { tok = crypto.randomBytes(20).toString('hex'); await q('UPDATE users SET cal_token=$1 WHERE id=$2', [tok, req.user.id]); }
  res.set('Cache-Control', 'no-store').json({ token: tok });
}));
// Siri Shortcut / Google Assistant: GET or POST /hook/<personal-key>/remind?text=…  → speaks back the confirmation
app.all('/hook/:tok/remind', express.urlencoded({ extended: false }), wrap(async (req, res) => {
  const u = await tokenUser(req.params.tok); if (!u) return res.status(404).type('text').send('Link not valid. Copy it again from Rago CRM → Profile.');
  const text = String((req.body && req.body.text) || req.query.text || '').trim();
  if (!text) return res.type('text').send('Say what to remind you about, for example: tomorrow 10 am call Kumar.');
  const r = parseReminder(text, await todayIST(), nowHMIST());
  await q(`INSERT INTO todos(title,kind,due_at,for_user,created_by) VALUES($1,'task',($2::date + $3::time) AT TIME ZONE '${TZ}',$4,$4)`, [r.title, r.due_date, r.due_time, u.id]);
  res.type('text').send(`Reminder set in Rago CRM: ${r.title} — ${prettyWhen(r.due_date, r.due_time)}.`);
}));
// Google Calendar (or any calendar app): subscribe to /cal/<personal-key>.ics — reminders, lead follow-ups and open jobs
const icsEsc = v => String(v || '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsTs = d => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
app.get('/cal/:tok.ics', wrap(async (req, res) => {
  const u = await tokenUser(req.params.tok); if (!u) return res.status(404).send('Not found');
  const host = `${req.protocol}://${req.get('host')}`, ev = [], stamp = icsTs(new Date());
  const todos = (await q(`SELECT id,title,note,kind,due_at,done FROM todos WHERE for_user=$1 AND due_at > now() - interval '30 days' ORDER BY due_at LIMIT 500`, [u.id])).rows;
  for (const t of todos) ev.push(['BEGIN:VEVENT', `UID:todo-${t.id}@rago-crm`, `DTSTAMP:${stamp}`, `DTSTART:${icsTs(t.due_at)}`, `DTEND:${icsTs(new Date(t.due_at).getTime() + 15 * 60000)}`,
    `SUMMARY:${icsEsc((t.done ? '✓ ' : '⏰ ') + (t.title || (t.kind === 'voice' ? 'Voice message' : 'Reminder')))}`, `DESCRIPTION:${icsEsc((t.note || '') + '\nOpen: ' + host + '/?todo=' + t.id)}`, `URL:${host}/?todo=${t.id}`,
    ...(t.done ? [] : ['BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-PT0M', 'END:VALARM']), 'END:VEVENT'].join('\r\n'));
  const perms = u.role === SUPER ? ALL_KEYS : (u.permissions || []);
  if (perms.includes('leads')) {
    const lp = [], w = [`l.follow_up IS NOT NULL`, `l.follow_up >= CURRENT_DATE - 30`, `l.stage IN ('New Enquiry','Contacted','Site Visit','Quotation','Negotiation')`];
    w.push(leadScope(u, lp));
    for (const l of (await q(`SELECT l.id,l.name,l.company,l.phone,l.stage,to_char(l.follow_up,'YYYYMMDD') d FROM leads l WHERE ${w.join(' AND ')} LIMIT 500`, lp)).rows) {
      const nd = new Date(Date.UTC(+l.d.slice(0, 4), +l.d.slice(4, 6) - 1, +l.d.slice(6) + 1)).toISOString().slice(0, 10).replace(/-/g, '');
      ev.push(['BEGIN:VEVENT', `UID:lead-${l.id}-${l.d}@rago-crm`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${l.d}`, `DTEND;VALUE=DATE:${nd}`,
        `SUMMARY:${icsEsc(`📞 Follow up: ${l.name}${l.company ? ' (' + l.company + ')' : ''}`)}`, `DESCRIPTION:${icsEsc(`${l.phone || ''} · ${l.stage}`)}`, 'END:VEVENT'].join('\r\n'));
    }
  }
  if (u.role === 'Technician') for (const j of (await q(`SELECT s.id,s.ticket_no,s.service_type,s.assigned_on,s.submitted_on,c.name,c.address FROM services s LEFT JOIN customers c ON c.id=s.customer_id
      WHERE (s.technician_id=$1 OR s.helper_id=$1) AND s.status=ANY($2::text[]) LIMIT 100`, [u.id, OPEN_ST])).rows) {
    const st = new Date(j.assigned_on || j.submitted_on);
    ev.push(['BEGIN:VEVENT', `UID:job-${j.id}@rago-crm`, `DTSTAMP:${stamp}`, `DTSTART:${icsTs(st)}`, `DTEND:${icsTs(st.getTime() + 60 * 60000)}`,
      `SUMMARY:${icsEsc(`🔧 Job #${j.ticket_no}: ${j.name || ''}`)}`, `LOCATION:${icsEsc(j.address || '')}`, `DESCRIPTION:${icsEsc(j.service_type || '')}`, 'END:VEVENT'].join('\r\n'));
  }
  res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-cache' }).send(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Rago CRM//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:Rago CRM · ${u.name}`, 'X-WR-TIMEZONE:Asia/Kolkata', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H', ...ev, 'END:VCALENDAR'].join('\r\n'));
}));

// ---------- payments overview (Dashboard + "Payments" page) ----------
// Who paid on a day (customer, ticket, amount, mode), day / month totals and ticket status counts — brand-scoped.
app.get('/api/payments/overview', wrap(async (req, res) => {
  if (!(can(req.user, 'pay_overview') || (can(req.user, 'dashboard') && can(req.user, 'view_charges')))) return res.status(403).json({ error: 'Not allowed' });
  const today = await todayIST(), date = isDate(req.query.date) ? req.query.date : today;
  const p = [], w = []; scope(req.user, p, w);
  if (!req.user.brand_id && +req.query.brand) { p.push(+req.query.brand); w.push(`s.brand_id=$${p.length}`); }
  const A = w.length ? ' AND ' + w.join(' AND ') : '', W = w.length ? 'WHERE ' + w.join(' AND ') : '';
  const dp = [...p, date], di = '$' + dp.length;
  const list = (await q(`SELECT y.id, y.amount, y.bank, y.note, y.approval, y.received_by, y.created_at, s.id service_id, s.ticket_no, s.kind, s.service_type, c.name customer, c.phone, br.name brand
    FROM payments y JOIN services s ON s.id=y.service_id LEFT JOIN customers c ON c.id=s.customer_id LEFT JOIN brands br ON br.id=s.brand_id
    WHERE y.approval<>'Rejected' AND y.paid_on=${di}::date${A} ORDER BY y.created_at DESC, y.id DESC LIMIT 300`, dp)).rows;
  const one = async (sql, pp) => (await q(sql, pp || p)).rows[0];
  const mp = [...p, date], mi = '$' + mp.length;
  const month = await one(`SELECT COALESCE(SUM(y.amount),0) total, COUNT(*)::int n FROM payments y JOIN services s ON s.id=y.service_id
    WHERE y.approval<>'Rejected' AND y.paid_on>=date_trunc('month',${mi}::date) AND y.paid_on<=${mi}::date${A}`, mp);
  const k = await one(`SELECT COUNT(*) FILTER (WHERE status='New Ticket')::int new_tickets, COUNT(*) FILTER (WHERE status='Work Not Started')::int assigned,
    COUNT(*) FILTER (WHERE status='On-Process')::int on_process, COUNT(*) FILTER (WHERE status='Work Pending')::int pending,
    COUNT(*) FILTER (WHERE kind='Job' AND status NOT IN ('Resolved','Cancelled'))::int open_jobs, COUNT(*) FILTER (WHERE status='Awaiting Payment')::int awaiting,
    COUNT(*) FILTER (WHERE status='Resolved' AND resolved_on>=date_trunc('month',now()))::int resolved_month,
    COALESCE(SUM(charges_applied-discount) FILTER (WHERE status<>'Cancelled'),0) billed FROM services s ${W}`);
  const paid = await one(`SELECT COALESCE(SUM(y.amount),0) paid FROM payments y JOIN services s ON s.id=y.service_id WHERE y.approval<>'Rejected'${A}`);
  const dayTotal = list.reduce((a, x) => a + Number(x.amount), 0), customers = new Set(list.map(x => x.service_id)).size;
  res.set('Cache-Control', 'no-store').json({ date, today, list, day_total: dayTotal, day_count: list.length, day_customers: customers,
    month_total: month.total, month_count: month.n, ...k, paid: paid.paid, outstanding: Math.max(0, k.billed - paid.paid) });
}));

// ---------- profile photos ----------
app.get('/api/users/:id/photo', wrap(async (req, res) => {
  const r = (await q('SELECT photo, photo_mime FROM users WHERE id=$1', [req.params.id])).rows[0];
  if (!r || !r.photo) return res.status(404).end();
  res.set('Content-Type', r.photo_mime || 'image/jpeg').set('Cache-Control', 'private, max-age=31536000, immutable').send(r.photo);
}));
app.post('/api/users/:id/photo', wrap(async (req, res) => {
  const id = +req.params.id, u = (await q('SELECT id, role FROM users WHERE id=$1', [id])).rows[0];
  if (!u) return res.status(404).json({ error: 'Not found' });
  if (id !== req.user.id && !(can(req.user, 'team') && manages(req.user, u.role))) return res.status(403).json({ error: 'Not allowed' });
  const b = req.body || {};
  if (b.remove) { await q('UPDATE users SET photo=NULL, photo_mime=NULL, photo_v=0 WHERE id=$1', [id]); return res.json({ ok: true, photo_v: 0 }); }
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(b.data || ''));
  if (!m) return res.status(400).json({ error: 'Choose a photo (JPG or PNG)' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 600 * 1024) return res.status(400).json({ error: 'Photo is too large' });
  const v = (await q('UPDATE users SET photo=$1, photo_mime=$2, photo_v=COALESCE(photo_v,0)+1 WHERE id=$3 RETURNING photo_v', [buf, m[1], id])).rows[0].photo_v;
  res.json({ ok: true, photo_v: v });
}));

// ---------- voice notes on services / jobs (admin ↔ technician) ----------
const voiceAccess = async (req, sid) => {
  const s = (await q('SELECT id, ticket_no, brand_id, technician_id, helper_id FROM services WHERE id=$1', [sid])).rows[0];
  if (!s) return { code: 404 };
  if (isTech(req.user) ? ![s.technician_id, s.helper_id].includes(req.user.id) : (!can(req.user, 'services') || !brandOK(req.user, s))) return { code: 403 };
  return { s };
};
app.post('/api/services/:id/voice', wrap(async (req, res) => {
  const a = await voiceAccess(req, +req.params.id); if (!a.s) return res.status(a.code).json({ error: a.code === 404 ? 'Not found' : 'Not allowed' });
  const b = req.body || {}, m = /^data:(audio\/[\w.+-]+)(?:;[\w=.+-]+)*;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.audio || ''));
  if (!m) return res.status(400).json({ error: 'Record a voice message first' });
  const buf = Buffer.from(m[2], 'base64'); if (buf.length < 200) return res.status(400).json({ error: 'The recording is empty — try again' });
  if (buf.length > 6 * 1024 * 1024) return res.status(400).json({ error: 'Recording too long (max 5 minutes)' });
  const dur = Math.max(1, Math.min(600, Math.round(+b.duration || 0)));
  const r = await q('INSERT INTO service_voice(service_id,user_id,user_name,role,audio,mime,duration) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id', [a.s.id, req.user.id, req.user.name, req.user.role, buf, m[1], dur]);
  await log(a.s.id, req.user.name, `🎙 Voice message (${dur}s)`);
  const to = isTech(req.user) ? [...await admins(a.s.brand_id), a.s.technician_id, a.s.helper_id] : [a.s.technician_id, a.s.helper_id];
  await notify(to.filter(x => x && x !== req.user.id), '🎙 Voice message', `${req.user.name} · #${a.s.ticket_no}`, a.s.id);
  res.json({ id: r.rows[0].id });
}));
app.get('/api/service-voice/:id', wrap(async (req, res) => {
  const v = (await q('SELECT service_id, audio, mime FROM service_voice WHERE id=$1', [req.params.id])).rows[0];
  if (!v) return res.status(404).end();
  const a = await voiceAccess(req, v.service_id); if (!a.s) return res.status(a.code).end();
  const buf = v.audio, total = buf.length, range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  res.set({ 'Content-Type': v.mime || 'audio/webm', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=86400' });
  if (range) { const st = range[1] ? +range[1] : 0, en = range[2] ? Math.min(+range[2], total - 1) : total - 1; res.status(206).set('Content-Range', `bytes ${st}-${en}/${total}`).send(buf.subarray(st, en + 1)); }
  else res.send(buf);
}));
app.delete('/api/service-voice/:id', superOnly, wrap(async (req, res) => { await q('DELETE FROM service_voice WHERE id=$1', [req.params.id]); res.json({ ok: true }); }));

// ---------- salary / payroll ----------
// Rules: per-day = salary ÷ 30, half-day = salary ÷ 60.  1 paid leave and 2 permissions free each month.
//   extra leave days, absent days → per-day each · half days and extra permissions → half-day each
//   advances (normal / petrol) given in the month are deducted.  Joined mid-month → paid from the joining day.
const PAY_RULES = { paid_leaves: 1, free_permissions: 2, day_div: 30, half_div: 60 };
// each person's own shift, week off and pay rules (set by the Super Admin when adding / editing the person)
const WDN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const RULE_DEF = { shift_on: true, in: '09:30', out: '18:30', grace: 15, week_off: 0, leave_on: true, paid_leaves: 1, perm_on: true, free_perms: 2, ot_on: false, ot_rate: 0, ot_min: 30 };
const hm2m = t => { const [h, m] = String(t || '0:0').split(':').map(Number); return h * 60 + (m || 0); };
const m2hm = n => `${String(Math.floor(n / 60) % 24).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
const rulesOf = (u, off) => {
  let r = null; try { r = u && u.att_rules ? (typeof u.att_rules === 'string' ? JSON.parse(u.att_rules) : u.att_rules) : null; } catch (e) { r = null; }
  const R = { ...RULE_DEF, ...(r || {}) };
  R.late_after = R.shift_on ? (r ? m2hm(hm2m(R.in) + (+R.grace || 0)) : (off && off.late) || m2hm(hm2m(R.in) + (+R.grace || 0))) : null;
  return R;
};
const cleanRules = (b, cur) => {
  const R = { ...RULE_DEF, ...(cur || {}) }, o = {}, bool = k => { if (b[k] !== undefined) o[k] = !!b[k]; }, num = (k, lo, hi) => { if (b[k] !== undefined && b[k] !== '') o[k] = Math.min(hi, Math.max(lo, Math.round(+b[k] || 0))); };
  ['shift_on', 'leave_on', 'perm_on', 'ot_on'].forEach(bool);
  if (isTime(b.in)) o.in = b.in; if (isTime(b.out)) o.out = b.out;
  num('grace', 0, 180); num('week_off', 0, 6); num('paid_leaves', 0, 31); num('free_perms', 0, 31); num('ot_min', 0, 600);
  if (b.ot_rate !== undefined && b.ot_rate !== '') o.ot_rate = Math.min(100000, Math.max(0, Math.round((+b.ot_rate || 0) * 100) / 100));
  const out = { ...R, ...o };
  if (hm2m(out.out) <= hm2m(out.in)) return { error: 'Check-out time must be after check-in time' };
  return { rules: out };
};
const dAdd = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
// week-off for a person: their weekly day, moved for a week when a "week off change" was approved (weeks run Monday–Sunday)
async function offDaysFor(uid, R, from, to) {
  const sw = (await q(`SELECT to_char(from_date,'YYYY-MM-DD') d FROM leave_requests WHERE user_id=$1 AND kind='WeekOff' AND status='Approved' AND from_date BETWEEN $2 AND $3`, [uid, dAdd(from, -7), dAdd(to, 7)])).rows.map(r => r.d);
  const on = new Set(sw), cancel = new Set();
  for (const d of sw) { const mon = dAdd(d, -((wday(d) + 6) % 7)), reg = dAdd(mon, (R.week_off + 6) % 7); if (reg !== d) cancel.add(reg); }
  return d => on.has(d) || (wday(d) === R.week_off && !cancel.has(d));
}
const ADV_KINDS = ['Advance', 'Petrol Advance'];
const r2 = v => Math.round(v * 100) / 100;
async function salaryFor(u, m, today, start, off) {
  const x = await monthFor(u, m, today, start, off), S = x.summary, sal = Number(u.salary) || 0, R = x.rules;
  const perDay = sal / PAY_RULES.day_div, half = sal / PAY_RULES.half_div, days = daysOf(m), last = days[days.length - 1];
  const jd = u.join_date ? String(u.join_date).slice(0, 10) : null;
  let gross = sal, notJoined = 0;
  if (jd && jd > days[0]) { notJoined = jd > last ? days.length : days.filter(d => d < jd).length; gross = Math.max(0, sal - notJoined * perDay); }
  // approved leave / permission count for the whole month (also later dates); absent days only up to today
  const from = jd && jd > days[0] ? jd : days[0], inM = x.days.filter(d => d.d >= from);
  S.leave = inM.filter(d => d.code === 'leave').length;
  const perms = inM.reduce((t, d) => t + d.perm.filter(p => !p.company).length, 0);
  // leave + absent share the free days (loss of pay only beyond them)
  const lop = S.leave + S.absent, freeL = R.leave_on ? Math.min(lop, R.paid_leaves) : 0, unpaid = R.leave_on ? Math.max(0, lop - R.paid_leaves) : 0;
  const extraPerm = R.perm_on ? Math.max(0, perms - R.free_perms) : 0;
  const adv = (await q(`SELECT id, kind, amount, to_char(given_on,'YYYY-MM-DD') given_on, note, given_by, created_at FROM advances WHERE user_id=$1 AND deduct_month=$2 ORDER BY given_on, id`, [u.id, m])).rows;
  const advN = adv.filter(a => a.kind !== 'Petrol Advance').reduce((t, a) => t + Number(a.amount), 0), advP = adv.filter(a => a.kind === 'Petrol Advance').reduce((t, a) => t + Number(a.amount), 0);
  const lines = [
    { k: 'leave', label: R.leave_on ? `Leave / absent days beyond ${R.paid_leaves} free` : 'Leave / absent (no deduction)', qty: unpaid, rate: perDay, of: lop, detail: `${S.leave} leave + ${S.absent} absent` },
    { k: 'half', label: 'Half days', qty: R.leave_on ? S.half : 0, rate: half, of: S.half },
    { k: 'perm', label: R.perm_on ? `Permissions beyond ${R.free_perms} free (half day each)` : 'Permissions (no deduction)', qty: extraPerm, rate: half, of: perms },
  ].map(l => ({ ...l, rate: r2(l.rate), amount: r2(l.qty * l.rate) }));
  const otH = r2((S.ot_min || 0) / 60), otAmt = R.ot_on ? r2(otH * (+R.ot_rate || 0)) : 0;
  const attDed = r2(lines.reduce((t, l) => t + l.amount, 0)), net = r2(gross + otAmt - attDed - advN - advP);
  return { user_id: u.id, month: m, salary: sal, per_day: r2(perDay), half_day: r2(half), join_date: jd, not_joined_days: notJoined, gross: r2(gross),
    leave_days: S.leave, paid_leave_used: freeL, permissions: perms, absent: S.absent, half_days: S.half, present: S.present, working: S.working,
    ot: { on: !!R.ot_on, minutes: S.ot_min || 0, hours: otH, rate: +R.ot_rate || 0, amount: otAmt, days: inM.filter(d => d.ot > 0).map(d => ({ d: d.d, min: d.ot, out: d.out })) },
    lines, att_deduction: attDed, advances: adv, advance: r2(advN), petrol: r2(advP), net, final: m < today.slice(0, 7),
    rules: { ...PAY_RULES, paid_leaves: R.paid_leaves, free_permissions: R.free_perms, leave_on: R.leave_on, perm_on: R.perm_on, ot_on: R.ot_on, ot_rate: R.ot_rate, shift: R.shift_on ? `${R.in}–${R.out} (+${R.grace} min)` : null, week_off: WDN[R.week_off] } };
}
const PSEL = `SELECT u.id,u.name,u.role,u.salary,u.att_rules,u.created_at,u.photo_v,u.brand_id,u.pay_brand_id,to_char(u.join_date,'YYYY-MM-DD') join_date, COALESCE(pb.name,b.name) pay_brand
  FROM users u LEFT JOIN brands b ON b.id=u.brand_id LEFT JOIN brands pb ON pb.id=u.pay_brand_id`;
const slipFor = async (uid, m) => { const today = await todayIST(), u = (await q(`${PSEL} WHERE u.id=$1`, [uid])).rows[0]; return u ? { user: u, ...(await salaryFor(u, m, today, await attStart(), await office())) } : null; };
const moneyIN = v => '₹' + Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const slipMsg = s => `Salary ${moneyIN(s.gross)} − leave/permission ${moneyIN(s.att_deduction)} − advances ${moneyIN(s.advance + s.petrol)} = ${moneyIN(s.net)} remaining for ${new Date(s.month + '-01T12:00:00Z').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}`;
// who an admin may give an advance to: Super Admin → anyone; Admin staff → people paid by their brand + technicians / support staff without a brand
const advOK = (me, u) => isSuper(me) || (isBoss(me) && u.role !== SUPER && u.id !== me.id && (!me.brand_id || (u.pay_brand_id || u.brand_id || null) === me.brand_id || (!u.pay_brand_id && !u.brand_id)));
app.get('/api/payroll', payNeed, wrap(async (req, res) => {
  const today = await todayIST(), m = isMonth(req.query.month) ? req.query.month : today.slice(0, 7), start = await attStart(), off = await office();
  const p = [SUPER]; let w = 'u.active AND u.role<>$1';
  if (+req.query.brand) { p.push(+req.query.brand); w += ` AND COALESCE(u.pay_brand_id,u.brand_id)=$${p.length}`; }
  if (req.query.brand === 'none') w += ' AND u.pay_brand_id IS NULL AND u.brand_id IS NULL';
  const users = (await q(`${PSEL} WHERE ${w} ORDER BY COALESCE(pb.name,b.name) NULLS LAST, u.name`, p)).rows, rows = [];
  for (const u of users) rows.push({ user: u, ...(await salaryFor(u, m, today, start, off)) });
  const T = k => r2(rows.reduce((t, r) => t + Number(r[k]), 0));
  res.set('Cache-Control', 'no-store').json({ month: m, today, rows, totals: { salary: T('salary'), gross: T('gross'), att_deduction: T('att_deduction'), advance: T('advance'), petrol: T('petrol'), net: T('net') }, rules: PAY_RULES });
}));
app.get('/api/payroll/slip', wrap(async (req, res) => {
  const today = await todayIST(), m = isMonth(req.query.month) ? req.query.month : today.slice(0, 7), uid = +req.query.user || req.user.id;
  if (uid !== req.user.id && !isSuper(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const s = await slipFor(uid, m); if (!s) return res.status(404).json({ error: 'Not found' });
  res.set('Cache-Control', 'no-store').json(s);
}));
app.post('/api/payroll/notify', payNeed, wrap(async (req, res) => {
  const m = isMonth((req.body || {}).month) ? req.body.month : (await todayIST()).slice(0, 7);
  const ids = (await q(`SELECT id FROM users WHERE active AND role<>$1 AND salary>0`, [SUPER])).rows.map(r => r.id); let n = 0;
  for (const id of ids) { const s = await slipFor(id, m); await notifyLink([id], '💰 Salary slip', slipMsg(s), 'salary'); n++; }
  res.json({ ok: true, sent: n });
}));
// advances (normal / petrol) — given by Admin staff or Super Admin, deducted from that month's salary
app.get('/api/advances/people', wrap(async (req, res) => {
  if (!isBoss(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const all = (await q(`${PSEL} WHERE u.active AND u.role<>$1 ORDER BY u.name`, [SUPER])).rows;
  res.json(all.filter(u => advOK(req.user, u)).map(u => ({ id: u.id, name: u.name, role: u.role, photo_v: u.photo_v, pay_brand: u.pay_brand })));
}));
app.get('/api/advances', wrap(async (req, res) => {
  const m = isMonth(req.query.month) ? req.query.month : (await todayIST()).slice(0, 7);
  const rows = (await q(`SELECT a.*, to_char(a.given_on,'YYYY-MM-DD') given_on, u.name, u.role, u.photo_v, u.brand_id, u.pay_brand_id FROM advances a JOIN users u ON u.id=a.user_id WHERE a.deduct_month=$1 ORDER BY a.given_on DESC, a.id DESC`, [m])).rows;
  res.set('Cache-Control', 'no-store').json(rows.filter(a => a.user_id === req.user.id || isSuper(req.user) || (isBoss(req.user) && (a.given_by_id === req.user.id || advOK(req.user, { id: a.user_id, role: a.role, brand_id: a.brand_id, pay_brand_id: a.pay_brand_id })))));
}));
app.post('/api/advances', wrap(async (req, res) => {
  if (!isBoss(req.user)) return res.status(403).json({ error: 'Only Admin staff or the Super Admin can give advances' });
  const b = req.body || {}, u = (await q(`${PSEL} WHERE u.id=$1 AND u.active`, [+b.user_id])).rows[0];
  if (!u) return res.status(400).json({ error: 'Choose the person' });
  if (!advOK(req.user, u)) return res.status(403).json({ error: 'You can only give advances to your brand’s staff' });
  const amt = money(b.amount); if (!(amt > 0)) return res.status(400).json({ error: 'Enter the amount' });
  const kind = ADV_KINDS.includes(b.kind) ? b.kind : 'Advance', today = await todayIST(), on = isDate(b.given_on) && b.given_on <= today ? b.given_on : today;
  const dm = isMonth(b.deduct_month) ? b.deduct_month : on.slice(0, 7);
  await q(`INSERT INTO advances(user_id,kind,amount,given_on,deduct_month,note,given_by,given_by_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [u.id, kind, amt, on, dm, String(b.note || '').trim().slice(0, 300) || null, req.user.name, req.user.id]);
  const s = await slipFor(u.id, dm);
  await notifyLink([u.id], kind === 'Petrol Advance' ? '⛽ Petrol advance given' : '💵 Advance given', `${moneyIN(amt)} by ${req.user.name}. ${slipMsg(s)}`, 'salary');
  res.json({ ok: true, net: s.net });
}));
app.delete('/api/advances/:id', superOnly, wrap(async (req, res) => { await q('DELETE FROM advances WHERE id=$1', [req.params.id]); res.json({ ok: true }); }));

// ---------- attendance, leave & permission ----------
// Check in / out works only inside the office radius. Outside (or no GPS) → the person sends an
// "Attendance request" with the time + reason, and an approver marks it. Leave = full days, Permission = morning / evening.
// Approvers: Super Admin, every Admin staff, and anyone given "Team attendance".
const isMonth = v => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || ''));
const daysOf = m => { const [y, mo] = m.split('-').map(Number), n = new Date(Date.UTC(y, mo, 0)).getUTCDate(); return Array.from({ length: n }, (_, i) => `${m}-${String(i + 1).padStart(2, '0')}`); };
const wday = s => new Date(s + 'T00:00:00Z').getUTCDay();   // 0 = Sunday
const MARKS = ['Present', 'Half Day', 'Absent', 'Week Off', 'Holiday'];
const KINDS = ['Leave', 'Permission', 'Attendance', 'WeekOff'];
const canAtt = u => can(u, 'att_team') || can(u, 'leave_approve');
const attNeed = (req, res, next) => canAtt(req.user) ? next() : res.status(403).json({ error: 'Not allowed' });
const attStart = async () => ((await q(`SELECT v FROM settings WHERE k='att_start'`)).rows[0] || {}).v || '2000-01-01';
const office = async () => { try { return { ...OFFICE_DEFAULT, ...JSON.parse(((await q(`SELECT v FROM settings WHERE k='office'`)).rows[0] || {}).v || '{}') }; } catch (e) { return OFFICE_DEFAULT; } };
const istHM = t => t ? new Date(t).toLocaleTimeString('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: true }) : null;
const ist24 = t => t ? new Date(t).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : null;
const metres = (a, b, c, d) => { const R = 6371000, r = x => x * Math.PI / 180, dl = r(c - a), dg = r(d - b), h = Math.sin(dl / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dg / 2) ** 2; return Math.round(2 * R * Math.asin(Math.sqrt(h))); };
const distTxt = m => m == null ? '' : m < 1000 ? m + ' m' : (m / 1000).toFixed(1) + ' km';
const approvers = async () => (await q(`SELECT id FROM users WHERE active AND (role=$1 OR 'leave_approve'=ANY(permissions))`, [SUPER])).rows.map(r => r.id);
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
  if (u.join_date === undefined || u.att_rules === undefined) u = { ...u, ...((await q(`SELECT to_char(join_date,'YYYY-MM-DD') join_date, att_rules FROM users WHERE id=$1`, [u.id])).rows[0] || {}) };
  const jd = u.join_date ? String(u.join_date).slice(0, 10) : null;
  const joined = jd || (u.created_at ? new Date(u.created_at).toLocaleDateString('en-CA', { timeZone: TZ }) : start), first = joined > start ? joined : start;
  const HOL = await officeHolidays(from, to);
  const R = rulesOf(u, off), isOff = await offDaysFor(u.id, R, from, to);
  const out = days.map(d => {
    const r = recs[d], sun = isOff(d), on = reqs.filter(x => x.f <= d && x.t >= d && x.kind !== 'WeekOff');
    const lv = on.find(x => x.kind === 'Leave' && x.status === 'Approved'), pm = on.filter(x => x.kind === 'Permission' && x.status === 'Approved'), pend = on.find(x => x.status === 'Pending');
    let code = '';
    if (r && r.marked_by && !['Present'].includes(r.status)) code = { 'Half Day': 'half', Absent: 'absent', 'Week Off': 'off', Holiday: 'holiday' }[r.status] || 'present';
    else if (HOL[d] && !(r && r.check_in)) code = 'holiday';
    else if (lv && lv.company && !(r && r.check_in)) code = 'holiday';   // leave given by the company (festival etc.) — not counted
    else if (lv && !sun && !(r && r.check_in)) code = 'leave';
    else if (pm.length) code = pm.some(x => x.session === 'Morning') ? (pm.some(x => x.session === 'Evening') ? 'perm-both' : 'perm-m') : 'perm-e';
    else if (r) code = r.status === 'Half Day' ? 'half' : r.status === 'Absent' ? 'absent' : 'present';
    else if (sun) code = 'off';
    else if (d < today && d >= first) code = 'absent';
    else if (d === today) code = 'today';
    const inT = r && r.check_in, late = !!(inT && R.late_after && ist24(inT) > R.late_after && !pm.some(x => x.session === 'Morning' || (x.company && (x.from_time || '00:00') <= R.late_after)));
    // overtime: minutes after the shift ends (whole time when working on a week off / holiday)
    let ot = 0; const outT = r && r.check_out;
    if (R.ot_on && inT && outT) {
      if (sun || HOL[d]) ot = Math.round((new Date(outT) - new Date(inT)) / 60000);
      else { const o = hm2m(ist24(outT)) - hm2m(R.out); if (o >= (+R.ot_min || 0)) ot = o; }
      ot = Math.max(0, ot);
    }
    return { d, sun, code, pending: !!pend, pend_kind: pend ? pend.kind : null, in: istHM(inT), out: istHM(r && r.check_out), in24: ist24(inT), out24: ist24(r && r.check_out),
      hours: +hrs(inT, r && r.check_out).toFixed(2), late, ot, in_dist: r ? r.in_dist : null, out_dist: r ? r.out_dist : null,
      status: r ? r.status : null, note: r ? r.note : null, by: r ? r.marked_by : null,
      holiday: HOL[d] || (lv && lv.company ? (lv.reason || 'Company leave') : null), leave: lv && !lv.company ? (lv.leave_type || 'Leave') : null, perm: pm.map(x => ({ session: x.session, from: x.from_time, to: x.to_time, company: !!x.company, reason: x.company ? x.reason : undefined })), counts: d >= first && d <= today };
  });
  const S = { present: 0, half: 0, absent: 0, leave: 0, perm_m: 0, perm_e: 0, off: 0, working: 0, late: 0, hours: 0, ot_min: 0 };
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
    S.ot_min += x.ot || 0;
    S.hours += x.hours;
  }
  S.hours = +S.hours.toFixed(1);
  S.pending = reqs.filter(x => x.status === 'Pending').length;
  const wk = (await q(`SELECT *, to_char(from_date,'YYYY-MM-DD') f FROM leave_requests WHERE user_id=$1 AND kind='WeekOff' AND status IN ('Pending','Approved') AND from_date BETWEEN $2 AND $3 ORDER BY id`, [u.id, from, to])).rows;
  return { rules: { ...R, week_off_name: WDN[R.week_off] }, days: out, summary: S, weekoff: wk.map(x => ({ id: x.id, date: x.f, status: x.status, reason: x.reason })), requests: reqs.map(({ f, t, ...x }) => ({ ...x, from_date: f, to_date: t })) };
}

app.get('/api/attendance/today', wrap(async (req, res) => {
  const today = await todayIST(), off = await office();
  const r = (await q(`SELECT * FROM attendance WHERE user_id=$1 AND day=$2`, [req.user.id, today])).rows[0];
  const pend = (await q(`SELECT id, from_time, to_time FROM leave_requests WHERE user_id=$1 AND kind='Attendance' AND status='Pending' AND from_date=$2 LIMIT 1`, [req.user.id, today])).rows[0];
  res.set('Cache-Control', 'no-store').json({ today, now: new Date().toISOString(), check_in: r && r.check_in, check_out: r && r.check_out, in: istHM(r && r.check_in), out: istHM(r && r.check_out),
    status: r ? r.status : null, by: r ? r.marked_by : null, office: off, anywhere: isSuper(req.user), pending: pend || null, ...(await (async () => {
      const R = rulesOf((await q('SELECT att_rules FROM users WHERE id=$1', [req.user.id])).rows[0], off), hol = (await officeHolidays(today, today))[today] || null;
      return { week_off: (await offDaysFor(req.user.id, R, today, today))(today), holiday: hol, shift: R.shift_on ? { in: R.in, out: R.out, late_after: R.late_after } : null };
    })()) });
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
  const u = (await q(`SELECT id,name,role,created_at,to_char(join_date,'YYYY-MM-DD') join_date,photo_v FROM users WHERE id=$1`, [uid])).rows[0];
  if (!u) return res.status(404).json({ error: 'Not found' });
  res.set('Cache-Control', 'no-store').json({ user: { id: u.id, name: u.name, role: u.role, photo_v: u.photo_v }, month: m, today, ...(await monthFor(u, m, today, await attStart(), await office())) });
}));
app.get('/api/attendance/report', attNeed, wrap(async (req, res) => {
  const today = await todayIST(), m = isMonth(req.query.month) ? req.query.month : today.slice(0, 7), start = await attStart(), off = await office();
  const users = (await q(`SELECT u.id,u.name,u.role,u.created_at,to_char(u.join_date,'YYYY-MM-DD') join_date,u.photo_v,COALESCE(b.name, pb.name) brand FROM users u LEFT JOIN brands b ON b.id=u.brand_id LEFT JOIN brands pb ON pb.id=u.pay_brand_id WHERE u.active AND u.role<>$1 ORDER BY u.role, u.name`, [SUPER])).rows;
  const rows = [];
  for (const u of users) {
    const x = await monthFor(u, m, today, start, off), td = x.days.find(d => d.d === today);
    rows.push({ id: u.id, name: u.name, role: u.role, brand: u.brand, photo_v: u.photo_v, ...x.summary, today: td ? { code: td.code, in: td.in, out: td.out, late: td.late } : null });
  }
  res.set('Cache-Control', 'no-store').json({ month: m, today, rows });
}));
// dashboard: who is on leave / permission today, who is in, what is waiting for approval
app.get('/api/attendance/board', attNeed, wrap(async (req, res) => {
  const today = await todayIST(), off = await office();
  const staff = (await q(`SELECT u.id,u.name,u.role,u.photo_v,u.att_rules,COALESCE(b.name, pb.name) brand FROM users u LEFT JOIN brands b ON b.id=u.brand_id LEFT JOIN brands pb ON pb.id=u.pay_brand_id WHERE u.active AND u.role<>$1 ORDER BY u.name`, [SUPER])).rows;
  const att = {}; (await q(`SELECT * FROM attendance WHERE day=$1`, [today])).rows.forEach(r => { att[r.user_id] = r; });
  const tr = (await q(`${LSELR} WHERE r.status='Approved' AND r.kind IN ('Leave','Permission') AND r.from_date<=$1 AND r.to_date>=$1 ORDER BY r.kind, r.session, u.name`, [today])).rows;
  const pending = (await q(`${LSELR} WHERE r.status='Pending' ORDER BY r.created_at LIMIT 20`)).rows;
  const leave = tr.filter(r => r.kind === 'Leave'), perm = tr.filter(r => r.kind === 'Permission'), away = new Set(leave.map(r => r.user_id));
  const holToday = (await officeHolidays(today, today))[today] || null;
  const sunday = wday(today) === 0 || !!holToday;
  const RU = {}; for (const u of staff) { RU[u.id] = rulesOf(u, off); RU[u.id].off = (await offDaysFor(u.id, RU[u.id], today, today))(today); }
  const inn = staff.filter(u => att[u.id] && att[u.id].check_in).map(u => ({ ...u, in: istHM(att[u.id].check_in), out: istHM(att[u.id].check_out), late: !!(RU[u.id].late_after && ist24(att[u.id].check_in) > RU[u.id].late_after) }));
  const weekOff = staff.filter(u => RU[u.id].off && !(att[u.id] && att[u.id].check_in)).map(u => ({ id: u.id, name: u.name, role: u.role, photo_v: u.photo_v, brand: u.brand }));
  const notIn = sunday ? [] : staff.filter(u => !RU[u.id].off && !(att[u.id] && att[u.id].check_in) && !away.has(u.id) && !(att[u.id] && ['Week Off', 'Holiday', 'Absent'].includes(att[u.id].status)));
  res.set('Cache-Control', 'no-store').json({ today, holiday: holToday, total: staff.length, inn: inn.map(({ att_rules, ...x }) => x), notIn: notIn.map(({ att_rules, ...x }) => x), weekOff, leave, perm, pending, late: off.late });
}));
// MD (Super Admin) overview: everything about the team's attendance on one screen
app.get('/api/attendance/md', superOnly, wrap(async (req, res) => {
  const today = await todayIST(), m = isMonth(req.query.month) ? req.query.month : today.slice(0, 7), start = await attStart(), off = await office();
  const users = (await q(`SELECT u.id,u.name,u.role,u.created_at,to_char(u.join_date,'YYYY-MM-DD') join_date,u.photo_v,COALESCE(b.name, pb.name) brand FROM users u LEFT JOIN brands b ON b.id=u.brand_id LEFT JOIN brands pb ON pb.id=u.pay_brand_id WHERE u.active AND u.role<>$1 ORDER BY u.name`, [SUPER])).rows;
  const days = daysOf(m), daily = Object.fromEntries(days.map(d => [d, { d, present: 0, late: 0, leave: 0, perm: 0, absent: 0, staff: 0 }]));
  const rows = [], todayList = [];
  for (const u of users) {
    const x = await monthFor(u, m, today, start, off), ins = x.days.filter(d => d.in24).map(d => +d.in24.slice(0, 2) * 60 + +d.in24.slice(3));
    for (const d of x.days) {
      const D = daily[d.d]; if (!d.counts || d.sun) continue; D.staff++;
      if (['present', 'perm-m', 'perm-e', 'perm-both', 'half'].includes(d.code) && (d.in || d.status)) D.present++;
      if (d.late) D.late++; if (d.code === 'leave') D.leave++; if (d.perm.length) D.perm++; if (d.code === 'absent') D.absent++;
    }
    const S = x.summary, eff = S.present + S.half * 0.5, pct = S.working ? Math.round(eff / S.working * 100) : null, worked = x.days.filter(d => d.hours > 0);
    const avgIn = ins.length ? Math.round(ins.reduce((a, b) => a + b, 0) / ins.length) : null;
    rows.push({ id: u.id, name: u.name, role: u.role, brand: u.brand, photo_v: u.photo_v, ...S, pct,
      avg_in: avgIn == null ? null : `${String(Math.floor(avgIn / 60)).padStart(2, '0')}:${String(avgIn % 60).padStart(2, '0')}`,
      avg_hours: worked.length ? +(worked.reduce((a, d) => a + d.hours, 0) / worked.length).toFixed(1) : 0 });
    const td = x.days.find(d => d.d === today);
    if (td && m === today.slice(0, 7)) todayList.push({ id: u.id, name: u.name, role: u.role, brand: u.brand, photo_v: u.photo_v, code: td.code, in: td.in, out: td.out, late: td.late, hours: td.hours, leave: td.leave, perm: td.perm, in_dist: td.in_dist, pending: td.pending });
  }
  const field = (await q(`${LSELR} WHERE r.kind='Attendance' AND r.from_date=$1 AND r.status IN ('Pending','Approved') ORDER BY r.created_at DESC`, [today])).rows;
  const pending = (await q(`${LSELR} WHERE r.status='Pending' ORDER BY r.created_at LIMIT 30`)).rows;
  const upcoming = (await q(`${LSELR} WHERE r.status='Approved' AND r.kind IN ('Leave','Permission') AND r.from_date>$1 AND r.from_date<=$1::date + 14 ORDER BY r.from_date LIMIT 30`, [today])).rows;
  const tot = rows.reduce((a, r) => ({ working: a.working + r.working, eff: a.eff + r.present + r.half * 0.5, late: a.late + r.late, leave: a.leave + r.leave, perm: a.perm + r.perm_m + r.perm_e, absent: a.absent + r.absent, hours: a.hours + r.hours }), { working: 0, eff: 0, late: 0, leave: 0, perm: 0, absent: 0, hours: 0 });
  res.set('Cache-Control', 'no-store').json({ month: m, today, office: off, staff: users.length, rows, today_list: todayList, daily: Object.values(daily), field, pending, upcoming,
    totals: { ...tot, hours: +tot.hours.toFixed(1), pct: tot.working ? Math.round(tot.eff / tot.working * 100) : null } });
}));

app.post('/api/attendance/mark', approveNeed, wrap(async (req, res) => {
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

const LSELR = `SELECT r.*, to_char(r.from_date,'YYYY-MM-DD') from_date, to_char(r.to_date,'YYYY-MM-DD') to_date, u.name, u.role, u.photo_v, c.name customer, c.phone customer_phone
  FROM leave_requests r JOIN users u ON u.id=r.user_id LEFT JOIN customers c ON c.id=r.customer_id`;
const reqWhen = r => r.kind === 'WeekOff' ? `week off on ${fdIN(r.from_date)} instead of the usual day that week` : r.kind === 'Permission' ? `${r.session} permission on ${fdIN(r.from_date)}${r.from_time ? ` (${r.from_time}${r.to_time ? '–' + r.to_time : ''})` : ''}`
  : r.kind === 'Attendance' ? `attendance on ${fdIN(r.from_date)}: ${[r.from_time && 'in ' + r.from_time, r.to_time && 'out ' + r.to_time].filter(Boolean).join(', ')}`
  : `${r.leave_type || 'Leave'} ${fdIN(r.from_date)}${r.to_date !== r.from_date ? ' → ' + fdIN(r.to_date) : ''}`;
const t12s = t => { const [h, m] = String(t || '0:0').split(':').map(Number); return `${(h % 12) || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
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
  let session = null, ft = null, tt = null, lt = null, lat = null, lng = null, dist = null, custId = null, place = null, acc = null;
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
    const off = await office(); lat = isFinite(+b.lat) && b.lat != null && b.lat !== '' ? +b.lat : null; lng = isFinite(+b.lng) && b.lng != null && b.lng !== '' ? +b.lng : null;
    if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return res.status(400).json({ error: 'Your location pin is needed. Turn on GPS / allow location and tap “Get my location”.' });
    dist = metres(off.lat, off.lng, lat, lng);
    custId = Number.isInteger(+b.customer_id) && +b.customer_id > 0 ? +b.customer_id : null;
    place = String(b.place || '').trim().slice(0, 200) || null;
    if (custId) { const cp = [custId], sc = custScope(req.user, cp); if (!(await q(`SELECT 1 FROM customers c WHERE c.id=$1 AND ${sc}`, cp)).rows.length) return res.status(400).json({ error: 'Customer not found' }); }
    if (!custId && !place) return res.status(400).json({ error: 'Choose the customer you went to (or type the place)' });
    acc = Number.isFinite(+b.acc) ? Math.round(+b.acc) : null;
  } else if (kind === 'WeekOff') {
    const R = rulesOf((await q('SELECT att_rules FROM users WHERE id=$1', [req.user.id])).rows[0]);
    if (wday(from) === R.week_off) return res.status(400).json({ error: `${WDN[R.week_off]} is already your week off` });
    if ((await q(`SELECT 1 FROM leave_requests WHERE user_id=$1 AND kind='WeekOff' AND status IN ('Pending','Approved') AND from_date BETWEEN $2 AND $3`, [req.user.id, dAdd(from, -((wday(from) + 6) % 7)), dAdd(from, 6 - ((wday(from) + 6) % 7))])).rows.length)
      return res.status(409).json({ error: 'You already changed your week off for that week' });
  } else lt = LEAVE_TYPES.includes(b.leave_type) ? b.leave_type : 'Casual Leave';
  const clash = (await q(`SELECT kind, session, to_char(from_date,'DD Mon') f FROM leave_requests WHERE user_id=$1 AND status IN ('Pending','Approved') AND from_date<=$3 AND to_date>=$2
    AND $4<>'WeekOff' AND kind<>'WeekOff' AND (CASE WHEN $4='Attendance' THEN kind='Attendance' AND status='Pending' ELSE kind<>'Attendance' AND (kind='Leave' OR $4='Leave' OR session=$5) END) LIMIT 1`, [req.user.id, from, to, kind, session])).rows[0];
  if (clash) return res.status(409).json({ error: `You already have a ${clash.kind.toLowerCase()}${clash.session ? ' (' + clash.session + ')' : ''} request on ${clash.f}` });
  const r = await q(`INSERT INTO leave_requests(user_id,kind,leave_type,session,from_date,to_date,from_time,to_time,reason,lat,lng,distance,customer_id,place,accuracy) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [req.user.id, kind, lt, session, from, to, ft, tt, reason, lat, lng, dist, custId, place, acc]);
  const cname = custId ? (await q('SELECT name FROM customers WHERE id=$1', [custId])).rows[0].name : place;
  const title = kind === 'WeekOff' ? '🔄 Week off change request' : kind === 'Permission' ? '🕘 Permission request' : kind === 'Attendance' ? '📍 Attendance request' : '🌴 Leave request';
  await notifyLink((await approvers()).filter(id => id !== req.user.id), title, `${req.user.name}: ${reqWhen({ kind, session, from_date: from, to_date: to, from_time: ft, to_time: tt, leave_type: lt })}${kind === 'Attendance' ? ` at ${cname} (${distTxt(dist)} from office)` : ''} — ${reason}`, 'leave');
  res.json({ id: r.rows[0].id });
}));
// company leave / permission (festival etc.) — given by the Super Admin to everyone or chosen people; never counted against anyone
app.post('/api/company-leave', superOnly, wrap(async (req, res) => {
  const b = req.body || {}, kind = b.kind === 'Permission' ? 'Permission' : 'Leave', from = b.from_date, to = kind === 'Leave' && isDate(b.to_date) ? b.to_date : from;
  if (!isDate(from) || to < from) return res.status(400).json({ error: 'Choose the date' });
  const reason = String(b.reason || '').trim().slice(0, 200);
  if (!reason) return res.status(400).json({ error: 'Write the reason, e.g. Deepavali' });
  let ft = null, tt = null;
  if (kind === 'Permission') { ft = b.from_time; tt = b.to_time; if (!isTime(ft) || !isTime(tt) || tt <= ft) return res.status(400).json({ error: 'Choose the time: from and to' }); }
  const ids = b.users === 'all' ? (await q(`SELECT id FROM users WHERE active AND role<>$1`, [SUPER])).rows.map(r => r.id)
    : (await q(`SELECT id FROM users WHERE active AND id=ANY($1)`, [Array.isArray(b.users) ? b.users.map(Number) : []])).rows.map(r => r.id);
  if (!ids.length) return res.status(400).json({ error: 'Choose who gets it' });
  for (const id of ids) await q(`INSERT INTO leave_requests(user_id,kind,leave_type,session,from_date,to_date,from_time,to_time,reason,status,decided_by,decided_at,company)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'Approved',$10,now(),true)`, [id, kind, kind === 'Leave' ? 'Company leave' : null, kind === 'Permission' ? (tt <= '13:00' ? 'Morning' : 'Evening') : null, from, to, ft, tt, reason, req.user.name]);
  const when = kind === 'Leave' ? (from === to ? fdIN(from) : `${fdIN(from)} – ${fdIN(to)}`) : `${fdIN(from)}, ${t12s(ft)} – ${t12s(tt)}`;
  await notifyLink(ids, kind === 'Leave' ? `🎉 Leave from the company · ${reason}` : `🕘 Permission for everyone · ${reason}`, `${when}. This is not counted in your leave or permissions.`, 'att');
  res.json({ ok: true, count: ids.length });
}));
app.post('/api/leave/:id/decide', approveNeed, wrap(async (req, res) => {
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
  let extra = '';
  if (st === 'Approved' && ['Leave', 'Permission'].includes(r.kind)) {
    const s = await slipFor(r.user_id, r.from_date.slice(0, 7));
    if (s && s.salary > 0) { const ln = s.lines.find(l => l.k === (r.kind === 'Leave' ? 'leave' : 'perm'));
      extra = ln && ln.amount > 0 ? ` · Salary deduction ${moneyIN(ln.amount)} (${r.kind === 'Leave' ? `${s.rules.paid_leaves} free leave / absent day(s) a month` : `${s.rules.free_permissions} free permissions a month`}). ${slipMsg(s)}`
        : ` · No salary deduction (${r.kind === 'Leave' ? 'paid leave' : 'free permission'}).`; }
  }
  await notifyLink([r.user_id], st === 'Approved' ? '✅ Request approved' : '❌ Request rejected', `Your ${reqWhen(r)} was ${st.toLowerCase()} by ${req.user.name}${note ? ' — ' + note : ''}${extra}`, 'att');
  res.json({ ok: true });
}));
app.post('/api/leave/:id/cancel', wrap(async (req, res) => {
  const r = (await q('SELECT * FROM leave_requests WHERE id=$1', [req.params.id])).rows[0];
  if (!r || r.user_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
  if (r.status !== 'Pending') return res.status(400).json({ error: 'Only a pending request can be cancelled' });
  await q(`UPDATE leave_requests SET status='Cancelled' WHERE id=$1`, [r.id]); res.json({ ok: true });
}));
app.delete('/api/leave/:id', superOnly, wrap(async (req, res) => { await q('DELETE FROM leave_requests WHERE id=$1', [req.params.id]); res.json({ ok: true }); }));


// =====================================================================
// ---------- team chat (Skype-style): All-staff group, groups, direct messages ----------
// =====================================================================
async function permMigrate() {
  if ((await q(`SELECT 1 FROM settings WHERE k='perm_v13'`)).rows.length) return;
  // keep what people could do before: Admin staff (and anyone with the old "attendance" switch) see team attendance and approve; everyone keeps chat & projects
  await q(`UPDATE users SET permissions = (SELECT ARRAY(SELECT DISTINCT unnest(permissions || ARRAY['att_team','leave_approve']))) WHERE role='Admin' OR 'attendance'=ANY(permissions)`);
  await q(`UPDATE users SET permissions = array_remove(permissions,'attendance')`);
  await q(`UPDATE users SET permissions = (SELECT ARRAY(SELECT DISTINCT unnest(permissions || ARRAY['chat','projects']))) WHERE role IN ('Admin','Sales','Technician')`);
  await q(`UPDATE users SET permissions = (SELECT ARRAY(SELECT DISTINCT unnest(permissions || ARRAY['chat']))) WHERE role='Staff'`);
  await q(`UPDATE users SET permissions = (SELECT ARRAY(SELECT DISTINCT unnest(permissions || ARRAY['customer_edit','billing','lead_lists','voice_assign']))) WHERE role='Admin'`);
  await q(`INSERT INTO settings(k,v) VALUES('perm_v13','1') ON CONFLICT (k) DO NOTHING`);
}
// lead sources & interests can be changed (Leads → ⚙ Sources & interests)
async function loadLeadLists() {
  for (const [k, arr, def] of [['lead_sources', LEAD_SOURCES, LEAD_SOURCES_DEF], ['lead_interests', LEAD_INTERESTS, LEAD_INTERESTS_DEF]]) {
    let v = null; try { v = JSON.parse(((await q('SELECT v FROM settings WHERE k=$1', [k])).rows[0] || {}).v || 'null'); } catch (e) { v = null; }
    arr.splice(0, arr.length, ...(Array.isArray(v) && v.length ? v : def));
    if (!arr.includes('Other')) arr.push('Other');
  }
}
app.put('/api/lead-lists', need('lead_lists'), wrap(async (req, res) => {
  const clean = l => [...new Set((Array.isArray(l) ? l : []).map(x => String(x || '').trim().slice(0, 60)).filter(Boolean))].slice(0, 60);
  const b = req.body || {}, src = clean(b.sources), int = clean(b.interests);
  if (!src.length || !int.length) return res.status(400).json({ error: 'Keep at least one in each list' });
  await q(`INSERT INTO settings(k,v) VALUES('lead_sources',$1) ON CONFLICT (k) DO UPDATE SET v=$1`, [JSON.stringify(src)]);
  await q(`INSERT INTO settings(k,v) VALUES('lead_interests',$1) ON CONFLICT (k) DO UPDATE SET v=$1`, [JSON.stringify(int)]);
  await loadLeadLists(); res.json({ ok: true, sources: LEAD_SOURCES, interests: LEAD_INTERESTS });
}));
async function initChat() {
  await permMigrate(); await loadLeadLists();
  await q(`
  CREATE TABLE IF NOT EXISTS chats (id SERIAL PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'group', name TEXT, dm_key TEXT UNIQUE, created_by INT,
    created_at TIMESTAMPTZ DEFAULT now(), last_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS chat_members (chat_id INT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read INT DEFAULT 0, seen_at TIMESTAMPTZ, muted BOOLEAN DEFAULT false, PRIMARY KEY (chat_id, user_id));
  CREATE TABLE IF NOT EXISTS chat_messages (id SERIAL PRIMARY KEY, chat_id INT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, user_id INT, user_name TEXT,
    kind TEXT NOT NULL DEFAULT 'text', body TEXT, mime TEXT, data BYTEA, duration INT, w INT, h INT, mentions INT[] DEFAULT '{}', reply_to INT,
    deleted BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT now());
  CREATE INDEX IF NOT EXISTS idx_cm_chat ON chat_messages(chat_id, id);
  ALTER TABLE chats ADD COLUMN IF NOT EXISTS lead_id INT UNIQUE;
  CREATE INDEX IF NOT EXISTS idx_cmem_user ON chat_members(user_id);
  CREATE TABLE IF NOT EXISTS holidays (id SERIAL PRIMARY KEY, day DATE NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'Festival',
    is_holiday BOOLEAN DEFAULT false, emoji TEXT, greeting TEXT, created_at TIMESTAMPTZ DEFAULT now(), UNIQUE(day, name));`);
  if (!(await q(`SELECT 1 FROM chats WHERE kind='all'`)).rows.length)
    await q(`INSERT INTO chats(kind,name,created_by) VALUES('all','All Staff',NULL)`);
  if (!(await q(`SELECT 1 FROM settings WHERE k='holidays_seeded'`)).rows.length) {
    for (const h of HOLIDAY_SEED) await q(`INSERT INTO holidays(day,name,kind,is_holiday,emoji,greeting) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (day,name) DO NOTHING`, h);
    await q(`INSERT INTO settings(k,v) VALUES('holidays_seeded','1') ON CONFLICT (k) DO NOTHING`);
  }
}
const ALL_CHAT = async () => (await q(`SELECT id FROM chats WHERE kind='all'`)).rows[0].id;
// is this user in the chat?  (everyone active is in "All Staff")
const chatFor = async (u, id) => {
  const c = (await q('SELECT * FROM chats WHERE id=$1', [id])).rows[0];
  if (!c) return null;
  if (c.kind === 'all') { await q(`INSERT INTO chat_members(chat_id,user_id,last_read) VALUES($1,$2,(SELECT COALESCE(MAX(id),0) FROM chat_messages WHERE chat_id=$1)) ON CONFLICT DO NOTHING`, [c.id, u.id]); return c; }
  return (await q('SELECT 1 FROM chat_members WHERE chat_id=$1 AND user_id=$2', [c.id, u.id])).rows.length ? c : null;
};
const chatMemberIds = async c => c.kind === 'all' ? (await q('SELECT id FROM users WHERE active')).rows.map(r => r.id)
  : (await q('SELECT m.user_id FROM chat_members m JOIN users u ON u.id=m.user_id WHERE m.chat_id=$1 AND u.active', [c.id])).rows.map(r => r.user_id);
const chatUnread = async uid => {
  const all = await ALL_CHAT();
  await q(`INSERT INTO chat_members(chat_id,user_id,last_read) VALUES($1,$2,(SELECT COALESCE(MAX(id),0) FROM chat_messages WHERE chat_id=$1)) ON CONFLICT DO NOTHING`, [all, uid]);
  return (await q(`SELECT COUNT(*)::int n FROM chat_messages x JOIN chat_members m ON m.chat_id=x.chat_id AND m.user_id=$1
    WHERE x.id>m.last_read AND x.user_id IS DISTINCT FROM $1 AND NOT x.deleted`, [uid])).rows[0].n;
};
const MSG_COLS = `x.id, x.chat_id, x.user_id, x.user_name, x.kind, CASE WHEN x.deleted THEN NULL ELSE x.body END body, x.mime, x.duration, x.w, x.h,
  x.mentions, x.reply_to, x.deleted, x.created_at, x.fname, x.fsize, u.photo_v, u.role`;
const preview = m => m.deleted ? 'Message deleted' : m.kind === 'file' ? '📎 ' + (m.fname || 'File') + (m.body ? ' · ' + m.body : '') : m.kind === 'image' ? '📷 Photo' + (m.body ? ' · ' + m.body : '') : m.kind === 'voice' ? `🎤 Voice message (${durTxt(m.duration)})` : (m.body || '');
const durTxt = s => `${Math.floor((s || 0) / 60)}:${String((s || 0) % 60).padStart(2, '0')}`;

app.get('/api/chats', need('chat'), wrap(async (req, res) => {
  const uid = req.user.id; await chatUnread(uid);   // makes sure the user is in All Staff
  const rows = (await q(`SELECT c.*, m.last_read, m.muted,
      (SELECT COUNT(*)::int FROM chat_messages x WHERE x.chat_id=c.id AND x.id>m.last_read AND x.user_id IS DISTINCT FROM $1 AND NOT x.deleted) unread,
      (SELECT COUNT(*)::int FROM chat_messages x WHERE x.chat_id=c.id AND x.id>m.last_read AND NOT x.deleted AND ($1=ANY(x.mentions) OR -1=ANY(x.mentions)) AND x.user_id IS DISTINCT FROM $1) tagged,
      (SELECT COUNT(*)::int FROM chat_members mm WHERE mm.chat_id=c.id) members
    FROM chats c JOIN chat_members m ON m.chat_id=c.id AND m.user_id=$1 ORDER BY (c.kind='all') DESC, c.last_at DESC`, [uid])).rows;
  const ids = rows.map(r => r.id), last = {};
  if (ids.length) (await q(`SELECT DISTINCT ON (x.chat_id) ${MSG_COLS} FROM chat_messages x LEFT JOIN users u ON u.id=x.user_id WHERE x.chat_id=ANY($1) ORDER BY x.chat_id, x.id DESC`, [ids])).rows.forEach(m => { last[m.chat_id] = m; });
  const dms = rows.filter(r => r.kind === 'dm').map(r => r.id), other = {};
  if (dms.length) (await q(`SELECT m.chat_id, u.id, u.name, u.role, u.photo_v FROM chat_members m JOIN users u ON u.id=m.user_id WHERE m.chat_id=ANY($1) AND m.user_id<>$2`, [dms, uid])).rows.forEach(o => { other[o.chat_id] = o; });
  const allN = (await q('SELECT COUNT(*)::int n FROM users WHERE active')).rows[0].n;
  res.set('Cache-Control', 'no-store').json({ items: rows.map(r => {
    const l = last[r.id], o = other[r.id];
    return { id: r.id, kind: r.kind, lead_id: r.lead_id, project_id: r.project_id, name: r.kind === 'dm' ? (o ? o.name : 'Former staff') : r.name, other: o || null, created_by: r.created_by,
      members: r.kind === 'all' ? allN : r.members, unread: r.unread, tagged: r.tagged, muted: r.muted, last_at: l ? l.created_at : r.last_at,
      last: l ? { who: l.user_id === uid ? 'You' : (l.user_name || '').split(' ')[0], text: preview(l), kind: l.kind } : null };
  }).sort((a, b) => (b.kind === 'all') - (a.kind === 'all') || new Date(b.last_at) - new Date(a.last_at)) });
}));
// people you can chat with / tag
app.get('/api/chat/people', wrap(async (req, res) => {
  res.json({ items: (await q(`SELECT u.id, u.name, u.role, u.photo_v, COALESCE(b.name, pb.name) brand FROM users u LEFT JOIN brands b ON b.id=u.brand_id LEFT JOIN brands pb ON pb.id=u.pay_brand_id WHERE u.active ORDER BY u.name`)).rows });
}));
app.post('/api/chats/dm', need('chat'), wrap(async (req, res) => {
  const other = +(req.body || {}).user_id, me = req.user.id;
  if (!other || other === me) return res.status(400).json({ error: 'Choose a person' });
  if (!(await q('SELECT 1 FROM users WHERE id=$1 AND active', [other])).rows.length) return res.status(404).json({ error: 'Not found' });
  const key = [me, other].sort((a, b) => a - b).join('-');
  let c = (await q('SELECT id FROM chats WHERE dm_key=$1', [key])).rows[0];
  if (!c) {
    c = (await q(`INSERT INTO chats(kind,dm_key,created_by) VALUES('dm',$1,$2) ON CONFLICT (dm_key) DO UPDATE SET dm_key=EXCLUDED.dm_key RETURNING id`, [key, me])).rows[0];
    await q(`INSERT INTO chat_members(chat_id,user_id) VALUES($1,$2),($1,$3) ON CONFLICT DO NOTHING`, [c.id, me, other]);
  }
  res.json({ id: c.id });
}));
app.post('/api/chats', need('chat'), wrap(async (req, res) => {
  const b = req.body || {}, name = String(b.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Give the group a name' });
  const ids = [...new Set([req.user.id, ...(Array.isArray(b.members) ? b.members.map(Number) : [])])].filter(Boolean);
  if (ids.length < 2) return res.status(400).json({ error: 'Add at least one person' });
  const c = (await q(`INSERT INTO chats(kind,name,created_by) VALUES('group',$1,$2) RETURNING id`, [name, req.user.id])).rows[0];
  const ok = (await q('SELECT id FROM users WHERE active AND id=ANY($1)', [ids])).rows.map(r => r.id);
  for (const id of ok) await q('INSERT INTO chat_members(chat_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [c.id, id]);
  await sysMsg(c.id, `${req.user.name} created the group “${name}”`);
  notifyChat(ok.filter(x => x !== req.user.id), `👥 Added to “${name}”`, `${req.user.name} added you to a group chat`, c.id, true);
  res.json({ id: c.id });
}));
const sysMsg = async (cid, text) => { await q(`INSERT INTO chat_messages(chat_id,kind,body) VALUES($1,'system',$2)`, [cid, text]); await q('UPDATE chats SET last_at=now() WHERE id=$1', [cid]); };
const canManage = (u, c) => isSuper(u) || c.created_by === u.id;
app.patch('/api/chats/:id', wrap(async (req, res) => {
  const c = await chatFor(req.user, +req.params.id); if (!c) return res.status(404).json({ error: 'Not found' });
  if (c.kind !== 'group') return res.status(400).json({ error: 'This chat cannot be changed' });
  if (!canManage(req.user, c)) return res.status(403).json({ error: 'Only the person who made the group (or the Super Admin) can change it' });
  const b = req.body || {}, msgs = [];
  if (b.name && String(b.name).trim() && String(b.name).trim() !== c.name) { const n = String(b.name).trim().slice(0, 60); await q('UPDATE chats SET name=$2 WHERE id=$1', [c.id, n]); msgs.push(`${req.user.name} renamed the group to “${n}”`); }
  const add = Array.isArray(b.add) ? b.add.map(Number) : [], rem = Array.isArray(b.remove) ? b.remove.map(Number) : [];
  if (add.length) {
    const ok = (await q('SELECT id, name FROM users WHERE active AND id=ANY($1) AND id NOT IN (SELECT user_id FROM chat_members WHERE chat_id=$2)', [add, c.id])).rows;
    for (const u of ok) await q(`INSERT INTO chat_members(chat_id,user_id,last_read) VALUES($1,$2,(SELECT COALESCE(MAX(id),0) FROM chat_messages WHERE chat_id=$1)) ON CONFLICT DO NOTHING`, [c.id, u.id]);
    if (ok.length) { msgs.push(`${req.user.name} added ${ok.map(u => u.name).join(', ')}`); notifyChat(ok.map(u => u.id), `👥 Added to “${b.name || c.name}”`, `${req.user.name} added you to a group chat`, c.id, true); }
  }
  if (rem.length) {
    const gone = (await q('DELETE FROM chat_members m USING users u WHERE u.id=m.user_id AND m.chat_id=$1 AND m.user_id=ANY($2) RETURNING u.name', [c.id, rem])).rows;
    if (gone.length) msgs.push(`${req.user.name} removed ${gone.map(u => u.name).join(', ')}`);
  }
  for (const m of msgs) await sysMsg(c.id, m);
  res.json({ ok: true });
}));
app.post('/api/chats/:id/leave', wrap(async (req, res) => {
  const c = await chatFor(req.user, +req.params.id); if (!c) return res.status(404).json({ error: 'Not found' });
  if (c.kind !== 'group') return res.status(400).json({ error: 'You cannot leave this chat' });
  await q('DELETE FROM chat_members WHERE chat_id=$1 AND user_id=$2', [c.id, req.user.id]);
  await sysMsg(c.id, `${req.user.name} left the group`); res.json({ ok: true });
}));
app.post('/api/chats/:id/mute', wrap(async (req, res) => {
  const c = await chatFor(req.user, +req.params.id); if (!c) return res.status(404).json({ error: 'Not found' });
  await q('UPDATE chat_members SET muted=$3 WHERE chat_id=$1 AND user_id=$2', [c.id, req.user.id, !!(req.body || {}).muted]); res.json({ ok: true });
}));
app.delete('/api/chats/:id', superOnly, wrap(async (req, res) => {
  const c = (await q('SELECT kind FROM chats WHERE id=$1', [req.params.id])).rows[0];
  if (!c) return res.status(404).json({ error: 'Not found' });
  if (c.kind === 'all') { await q('DELETE FROM chat_messages WHERE chat_id=$1', [req.params.id]); await q('UPDATE chat_members SET last_read=0 WHERE chat_id=$1', [req.params.id]); return res.json({ ok: true, cleared: true }); }
  await q('DELETE FROM chats WHERE id=$1', [req.params.id]); res.json({ ok: true });
}));
// messages: ?after=<id> for new ones (polling), ?before=<id> for older ones
app.get('/api/chats/:id/messages', wrap(async (req, res) => {
  const c = await chatFor(req.user, +req.params.id); if (!c) return res.status(404).json({ error: 'Not found' });
  const after = +req.query.after || 0, before = +req.query.before || 0;
  let rows;
  if (after) rows = (await q(`SELECT ${MSG_COLS} FROM chat_messages x LEFT JOIN users u ON u.id=x.user_id WHERE x.chat_id=$1 AND x.id>$2 ORDER BY x.id LIMIT 200`, [c.id, after])).rows;
  else rows = (await q(`SELECT * FROM (SELECT ${MSG_COLS} FROM chat_messages x LEFT JOIN users u ON u.id=x.user_id WHERE x.chat_id=$1 ${before ? 'AND x.id<$2' : ''} ORDER BY x.id DESC LIMIT 60) t ORDER BY id`, before ? [c.id, before] : [c.id])).rows;
  await q('UPDATE chat_members SET seen_at=now() WHERE chat_id=$1 AND user_id=$2', [c.id, req.user.id]);
  const out = { items: rows, more: !after && rows.length === 60 };
  if (!after && !before) {   // first load: chat details + members + who has read up to where
    const mem = c.kind === 'all' ? (await q(`SELECT u.id, u.name, u.role, u.photo_v FROM users u WHERE u.active ORDER BY u.name`)).rows
      : (await q(`SELECT u.id, u.name, u.role, u.photo_v FROM chat_members m JOIN users u ON u.id=m.user_id WHERE m.chat_id=$1 ORDER BY u.name`, [c.id])).rows;
    const other = c.kind === 'dm' ? mem.find(m => m.id !== req.user.id) : null;
    out.chat = { id: c.id, kind: c.kind, lead_id: c.lead_id, project_id: c.project_id, name: c.kind === 'dm' ? (other ? other.name : 'Former staff') : c.name, created_by: c.created_by, other,
      can_manage: c.kind === 'group' && canManage(req.user, c), muted: !!((await q('SELECT muted FROM chat_members WHERE chat_id=$1 AND user_id=$2', [c.id, req.user.id])).rows[0] || {}).muted };
    out.members = mem;
  }
  // "seen" ticks: the lowest last_read among the other members (DMs show Seen)
  out.read_by = c.kind === 'dm' ? ((await q('SELECT last_read FROM chat_members WHERE chat_id=$1 AND user_id<>$2', [c.id, req.user.id])).rows[0] || {}).last_read || 0 : null;
  res.set('Cache-Control', 'no-store').json(out);
}));
app.post('/api/chats/:id/read', wrap(async (req, res) => {
  const c = await chatFor(req.user, +req.params.id); if (!c) return res.status(404).json({ error: 'Not found' });
  const last = +(req.body || {}).last || 0;
  await q('UPDATE chat_members SET last_read=GREATEST(last_read,$3), seen_at=now() WHERE chat_id=$1 AND user_id=$2', [c.id, req.user.id, last]);
  // the related bell notifications for this chat are read too
  await q(`UPDATE notifications SET read=true WHERE user_id=$1 AND link=ANY($2) AND NOT read`, [req.user.id, ['chat:' + c.id, 'leadchat:' + c.lead_id, 'project:' + c.project_id]]);
  res.json({ ok: true, unread: await chatUnread(req.user.id) });
}));
// push + (for DMs / tags / group adds) a bell notification. Skips people who are looking at the chat right now.
async function notifyChat(ids, title, body, cid, bell, link) {
  for (const id of [...new Set(ids)].filter(Boolean)) {
    if (bell) await q('INSERT INTO notifications(user_id,title,body,link) VALUES($1,$2,$3,$4)', [id, title, body, link || 'chat:' + cid]);
    pushTo(id, title, body, null, link ? { url: '/?att=' + link, att: link, tag: 'rago-chat-' + cid } : { url: '/?chat=' + cid, chat: cid, tag: 'rago-chat-' + cid }).catch(() => {});
  }
}
async function chatPost(u, c, b) {
  b = b || {}; const text = String(b.text || '').replace(/\s+$/, '').slice(0, 4000);
  let kind = 'text', buf = null, mime = null, dur = null, w = null, h = null;
  if (b.image) {
    const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(b.image));
    if (!m) return { error: 'Choose a photo (JPG or PNG)' };
    buf = Buffer.from(m[2], 'base64'); if (buf.length > 3 * 1024 * 1024) return { error: 'Photo is too large' };
    kind = 'image'; mime = m[1]; w = +b.w || null; h = +b.h || null;
  } else if (b.audio) {
    const m = /^data:(audio\/[\w.+-]+)(?:;[\w=.+-]+)*;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.audio));
    if (!m) return { error: 'Record a voice message first' };
    buf = Buffer.from(m[2], 'base64'); if (buf.length < 200) return { error: 'The recording is empty — try again' };
    if (buf.length > 6 * 1024 * 1024) return { error: 'Recording too long (max 5 minutes)' };
    kind = 'voice'; mime = m[1]; dur = Math.max(1, Math.min(600, Math.round(+b.duration || 0)));
  } else if (b.file) {
    const m = /^data:([\w.+-]+\/[\w.+-]+)?(?:;[\w=.+-]+)*;base64,([A-Za-z0-9+/=]*)$/.exec(String(b.file));
    if (!m) return { error: 'Choose a file' };
    buf = Buffer.from(m[2], 'base64'); if (!buf.length) return { error: 'That file is empty' };
    if (buf.length > 10 * 1024 * 1024) return { error: 'File is too large (max 10 MB)' };
    kind = 'file'; mime = m[1] || 'application/octet-stream';
  } else if (!text.trim()) return { error: 'Type a message' };
  // tags: client sends ids; -1 = @everyone. Only people who are in this chat count.
  const members = await chatMemberIds(c);
  let tags = (Array.isArray(b.mentions) ? b.mentions.map(Number) : []).filter(x => x === -1 || members.includes(x));
  if (/(^|\s)@(all|everyone)\b/i.test(text) && !tags.includes(-1)) tags.push(-1);
  tags = [...new Set(tags)];
  const reply = +b.reply_to || null;
  const fname = kind === 'file' ? (String(b.fname || 'file').replace(/[\\/:*?"<>|\r\n]+/g, '_').trim().slice(0, 120) || 'file') : null;
  const r = (await q(`INSERT INTO chat_messages(chat_id,user_id,user_name,kind,body,mime,data,duration,w,h,mentions,reply_to,fname,fsize) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id, created_at`,
    [c.id, u.id, u.name, kind, text || null, mime, buf, dur, w, h, tags, reply, fname, buf ? buf.length : null])).rows[0];
  await q('UPDATE chats SET last_at=now() WHERE id=$1', [c.id]);
  await q('UPDATE chat_members SET last_read=GREATEST(last_read,$3) WHERE chat_id=$1 AND user_id=$2', [c.id, u.id, r.id]);
  // who to alert
  const others = members.filter(x => x !== u.id);
  const st = (await q(`SELECT user_id, muted, (seen_at > now() - interval '12 seconds') here FROM chat_members WHERE chat_id=$1`, [c.id])).rows, S = {};
  st.forEach(x => { S[x.user_id] = x; });
  const gname = c.kind === 'dm' ? null : c.name, pv = preview({ kind, body: text, duration: dur, fname: b.fname }).slice(0, 140);
  const tagged = tags.includes(-1) ? others : others.filter(x => tags.includes(x));
  const rest = others.filter(x => !tagged.includes(x) && !(S[x] && (S[x].muted || S[x].here)));
  if (c.kind === 'project') await notifyChat(others.filter(x => !(S[x] && S[x].here) && !(S[x] && S[x].muted && !tagged.includes(x))), `📁 ${u.name} · ${c.name.replace(/^Project · /, '')}`, pv, c.id, true, 'project:' + c.project_id);
  else if (c.kind === 'lead') await notifyChat(others.filter(x => !(S[x] && S[x].here)), `💬 ${u.name} · ${c.name}`, pv, c.id, true, 'leadchat:' + c.lead_id);
  else if (c.kind === 'dm') await notifyChat(others.filter(x => !(S[x] && S[x].here)), `💬 ${u.name}`, pv, c.id, true);
  else {
    await notifyChat(tagged.filter(x => !(S[x] && S[x].here)), `📣 ${u.name} tagged you · ${gname}`, pv, c.id, true);
    await notifyChat(rest, `💬 ${gname}`, `${u.name}: ${pv}`, c.id, false);
  }
  if (c.kind === 'lead') { await q('UPDATE leads SET last_contact=now(), updated_at=now() WHERE id=$1', [c.lead_id]).catch(() => {}); if (kind === 'voice') await leadLog(c.lead_id, u.name, `🎙 Voice message (${dur}s)`).catch(() => {}); }
  return { id: r.id, created_at: r.created_at };
}
app.post('/api/chats/:id/messages', wrap(async (req, res) => {
  const c = await chatFor(req.user, +req.params.id); if (!c) return res.status(404).json({ error: 'Not found' });
  const r = await chatPost(req.user, c, req.body); res.status(r.error ? 400 : 200).json(r);
}));
// ---------- lead discussion: MD (Super Admin) + the staff who own the lead, inside the lead ----------
async function leadChat(l) {
  const name = `Lead · ${l.name}${l.company ? ' (' + l.company + ')' : ''}`.slice(0, 80);
  let c = (await q('SELECT * FROM chats WHERE lead_id=$1', [l.id])).rows[0];
  if (!c) {
    c = (await q(`INSERT INTO chats(kind,name,lead_id,created_by) VALUES('lead',$1,$2,$3) ON CONFLICT (lead_id) DO UPDATE SET name=EXCLUDED.name RETURNING *`, [name, l.id, l.created_by || null])).rows[0];
    if (!(await q('SELECT 1 FROM chat_messages WHERE chat_id=$1 LIMIT 1', [c.id])).rows.length)   // bring in earlier voice notes of this lead
      await q(`INSERT INTO chat_messages(chat_id,user_id,user_name,kind,mime,data,duration,created_at) SELECT $1,user_id,user_name,'voice',mime,audio,duration,created_at FROM lead_voice WHERE lead_id=$2 ORDER BY id`, [c.id, l.id]).catch(() => {});
  } else if (c.name !== name) await q('UPDATE chats SET name=$2 WHERE id=$1', [c.id, name]);
  const ids = [...new Set([...(await q('SELECT id FROM users WHERE active AND role=$1', [SUPER])).rows.map(r => r.id), l.assigned_to, l.created_by].filter(Boolean))];
  const act = (await q('SELECT id FROM users WHERE active AND id=ANY($1)', [ids])).rows.map(r => r.id);
  for (const id of act) await q('INSERT INTO chat_members(chat_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [c.id, id]);
  await q('DELETE FROM chat_members WHERE chat_id=$1 AND NOT (user_id=ANY($2))', [c.id, act]);
  return c;
}
app.post('/api/leads/:id/chat', need('leads'), wrap(async (req, res) => {
  const l = await leadOK(req, res, req.params.id); if (!l) return;
  const c = await leadChat(l); res.json({ id: c.id });
}));
app.get('/api/chat-media/:id', wrap(async (req, res) => {
  const m = (await q('SELECT chat_id, data, mime, deleted, kind, fname FROM chat_messages WHERE id=$1', [req.params.id])).rows[0];
  if (!m || m.deleted || !m.data) return res.status(404).end();
  if (!(await chatFor(req.user, m.chat_id))) return res.status(403).end();
  const buf = m.data, total = buf.length, range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  res.set({ 'Content-Type': m.mime || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=604800', 'X-Content-Type-Options': 'nosniff' });
  if (m.kind === 'file') res.set('Content-Disposition', `${req.query.dl || !/^(application\/pdf|image\/)/.test(m.mime || '') ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(m.fname || 'file')}`);
  if (range) { const s = range[1] ? +range[1] : 0, e = range[2] ? Math.min(+range[2], total - 1) : total - 1; res.status(206).set('Content-Range', `bytes ${s}-${e}/${total}`).send(buf.subarray(s, e + 1)); }
  else res.send(buf);
}));
// delete: your own message, or anything if you are the Super Admin
app.delete('/api/chat-messages/:id', wrap(async (req, res) => {
  const m = (await q('SELECT id, user_id FROM chat_messages WHERE id=$1', [req.params.id])).rows[0];
  if (!m) return res.status(404).json({ error: 'Not found' });
  if (m.user_id !== req.user.id && !isSuper(req.user)) return res.status(403).json({ error: 'You can only delete your own messages' });
  await q('UPDATE chat_messages SET deleted=true, data=NULL, body=NULL WHERE id=$1', [m.id]); res.json({ ok: true });
}));

// =====================================================================
// ---------- holidays, festivals & special days + the daily greeting ----------
// =====================================================================
// [day, name, kind, office holiday?, emoji, greeting]
const G = 'Government', F = 'Festival', SP = 'Special Day';
const HOLIDAY_SEED = [
  ['2026-01-01', "New Year's Day", G, true, '🎆', 'Happy New Year! Wishing you a year full of good health, happy customers and big wins.'],
  ['2026-01-12', 'National Youth Day', SP, false, '🌟', 'Stay curious, stay bold — the energy you bring every day moves the whole team forward.'],
  ['2026-01-14', 'Bhogi', F, false, '🔥', 'Happy Bhogi! Out with the old, in with the new — a fresh start for the season.'],
  ['2026-01-15', 'Pongal', G, true, '🌾', 'Pongalo Pongal! May your home overflow with joy and prosperity, just like the sweet pongal pot.'],
  ['2026-01-16', 'Thiruvalluvar Day', G, true, '📜', 'Happy Thiruvalluvar Day! Wisdom, honesty and hard work — the timeless recipe for success.'],
  ['2026-01-17', 'Uzhavar Thirunal', G, true, '🐄', 'Happy Uzhavar Thirunal! A big thank you to the farmers who feed us all.'],
  ['2026-01-26', 'Republic Day', G, true, '🇮🇳', 'Happy Republic Day! Proud to build, serve and grow together.'],
  ['2026-02-01', 'Thai Poosam', G, true, '🪔', 'Happy Thai Poosam! Wishing you strength, devotion and blessings.'],
  ['2026-02-15', 'Maha Shivaratri', F, false, '🕉️', 'Wishing you a peaceful and blessed Maha Shivaratri.'],
  ['2026-03-04', 'Holi', F, false, '🎨', 'Happy Holi! May your day be as colourful as your smile.'],
  ['2026-03-08', "International Women's Day", SP, false, '💐', "Happy Women's Day to every amazing woman on our team and in our lives — thank you!"],
  ['2026-03-19', 'Telugu New Year (Ugadi)', G, true, '🌼', 'Happy Ugadi! A sweet new beginning with a little bit of every flavour of life.'],
  ['2026-03-21', 'Ramzan (Idul Fitr)', G, true, '🌙', 'Eid Mubarak! Wishing you peace, happiness and lots of sweet moments with family.'],
  ['2026-03-31', 'Mahaveer Jayanthi', G, true, '🙏', 'Happy Mahaveer Jayanthi! Kindness and peace to all.'],
  ['2026-04-03', 'Good Friday', G, true, '✝️', 'A day of reflection and peace. Wishing you calm and comfort today.'],
  ['2026-04-05', 'Easter', F, false, '🐣', 'Happy Easter! New hope, new beginnings.'],
  ['2026-04-14', 'Tamil New Year & Dr. Ambedkar Birthday', G, true, '🎉', 'Iniya Tamil Puthandu Nalvazhthukkal! Happy Tamil New Year — may this year bring success in everything you do.'],
  ['2026-04-22', 'Earth Day', SP, false, '🌍', 'Happy Earth Day! Switch off what you don’t need — every small saving counts.'],
  ['2026-05-01', 'May Day (Labour Day)', G, true, '🛠️', 'Happy May Day! Every job done well by this team makes a difference — thank you for your hard work.'],
  ['2026-05-10', "Mother's Day", SP, false, '💐', "Happy Mother's Day! Give your amma a call today."],
  ['2026-05-28', 'Bakrid (Idul Azha)', G, true, '🌙', 'Eid al-Adha Mubarak! Wishing you blessings, generosity and joy.'],
  ['2026-06-05', 'World Environment Day', SP, false, '🌱', 'Happy Environment Day! Plant a tree, save a drop, keep it green.'],
  ['2026-06-21', "International Yoga Day & Father's Day", SP, false, '🧘', "Happy Yoga Day and Father's Day! Take a deep breath, stretch — and thank your appa."],
  ['2026-06-26', 'Muharram', G, true, '🌙', 'Wishing you peace and reflection this Muharram.'],
  ['2026-07-01', "National Doctors' Day", SP, false, '🩺', "Happy Doctors' Day! Thank you to the doctors who keep us healthy."],
  ['2026-08-02', 'Friendship Day', SP, false, '🤝', 'Happy Friendship Day! Great teams are built on great friendships.'],
  ['2026-08-15', 'Independence Day', G, true, '🇮🇳', 'Happy Independence Day! Jai Hind!'],
  ['2026-08-26', 'Milad-un-Nabi', G, true, '🌙', 'Wishing you peace and blessings on Milad-un-Nabi.'],
  ['2026-08-26', 'Onam', F, false, '🌸', 'Happy Onam! Wishing you a feast of happiness.'],
  ['2026-08-28', 'Raksha Bandhan', F, false, '🎗️', 'Happy Raksha Bandhan! Celebrating the bond of love and care.'],
  ['2026-09-04', 'Krishna Jayanthi', G, true, '🦚', 'Happy Krishna Jayanthi! May the little Krishna bring joy into your home.'],
  ['2026-09-05', "Teachers' Day", SP, false, '🍎', "Happy Teachers' Day! Thank you to everyone who teaches and guides — at school and at work."],
  ['2026-09-14', 'Vinayakar Chathurthi', G, true, '🐘', 'Happy Vinayakar Chathurthi! May Lord Ganesha remove every obstacle in your way.'],
  ['2026-09-15', "Engineers' Day", SP, false, '⚙️', "Happy Engineers' Day to our technicians and engineers — you make it all work!"],
  ['2026-10-02', 'Gandhi Jayanthi', G, true, '🕊️', 'Happy Gandhi Jayanthi! Be the change you wish to see.'],
  ['2026-10-19', 'Ayudha Pooja', G, true, '🔧', 'Happy Ayudha Pooja! Honouring the tools and the hands that do great work every day.'],
  ['2026-10-20', 'Vijaya Dasami', G, true, '🏹', 'Happy Vijaya Dasami! May good always win — a great day to start something new.'],
  ['2026-11-08', 'Deepavali', G, true, '🪔', 'Happy Deepavali! May the festival of lights fill your home with joy, sweets and sparkle. Celebrate safely!'],
  ['2026-11-14', "Children's Day", SP, false, '🎈', "Happy Children's Day! Stay young at heart."],
  ['2026-11-24', 'Karthigai Deepam', F, false, '🪔', 'Happy Karthigai Deepam! May the lamps light up your home and your heart.'],
  ['2026-12-24', 'Christmas Eve', SP, false, '🎄', 'Merry Christmas Eve! Get ready for some cake and cheer.'],
  ['2026-12-25', 'Christmas', G, true, '🎄', 'Merry Christmas! Wishing you joy, peace and lots of cake.'],
  ['2026-12-31', "New Year's Eve", SP, false, '🥳', 'Last day of the year! Thank you for all your hard work in 2026 — let’s make 2027 even bigger.'],
  ['2027-01-01', "New Year's Day", G, true, '🎆', 'Happy New Year 2027! New goals, new wins — let’s go!'],
  ['2027-01-12', 'National Youth Day', SP, false, '🌟', 'Stay curious, stay bold — the energy you bring every day moves the whole team forward.'],
  ['2027-01-14', 'Bhogi', F, false, '🔥', 'Happy Bhogi! Out with the old, in with the new.'],
  ['2027-01-15', 'Pongal', G, true, '🌾', 'Pongalo Pongal! May your home overflow with joy and prosperity.'],
  ['2027-01-16', 'Thiruvalluvar Day', G, true, '📜', 'Happy Thiruvalluvar Day! Wisdom, honesty and hard work.'],
  ['2027-01-17', 'Uzhavar Thirunal', G, true, '🐄', 'Happy Uzhavar Thirunal! Thank you to the farmers who feed us all.'],
  ['2027-01-22', 'Thai Poosam', G, true, '🪔', 'Happy Thai Poosam! Wishing you strength and blessings.'],
  ['2027-01-26', 'Republic Day', G, true, '🇮🇳', 'Happy Republic Day! Proud to build, serve and grow together.'],
  ['2027-03-08', "International Women's Day", SP, false, '💐', "Happy Women's Day to every amazing woman on our team!"],
  ['2027-03-10', 'Ramzan (Idul Fitr)', G, true, '🌙', 'Eid Mubarak! Wishing you peace, happiness and sweet moments with family.'],
  ['2027-03-26', 'Good Friday', G, true, '✝️', 'A day of reflection and peace. Wishing you calm today.'],
  ['2027-04-07', 'Telugu New Year (Ugadi)', G, true, '🌼', 'Happy Ugadi! A sweet new beginning.'],
  ['2027-04-14', 'Tamil New Year & Dr. Ambedkar Birthday', G, true, '🎉', 'Iniya Tamil Puthandu Nalvazhthukkal! Happy Tamil New Year!'],
  ['2027-04-19', 'Mahaveer Jayanthi', G, true, '🙏', 'Happy Mahaveer Jayanthi! Kindness and peace to all.'],
  ['2027-05-01', 'May Day (Labour Day)', G, true, '🛠️', 'Happy May Day! Thank you for your hard work.'],
  ['2027-05-09', "Mother's Day", SP, false, '💐', "Happy Mother's Day! Give your amma a call today."],
  ['2027-05-17', 'Bakrid (Idul Azha)', G, true, '🌙', 'Eid al-Adha Mubarak! Wishing you blessings and joy.'],
  ['2027-06-15', 'Muharram', G, true, '🌙', 'Wishing you peace and reflection this Muharram.'],
  ['2027-06-20', "Father's Day", SP, false, '👔', "Happy Father's Day! Thank your appa today."],
  ['2027-08-15', 'Independence Day & Milad-un-Nabi', G, true, '🇮🇳', 'Happy Independence Day! Jai Hind! And peace and blessings on Milad-un-Nabi.'],
  ['2027-08-25', 'Krishna Jayanthi', G, true, '🦚', 'Happy Krishna Jayanthi!'],
  ['2027-09-04', 'Vinayakar Chathurthi', G, true, '🐘', 'Happy Vinayakar Chathurthi! May every obstacle be removed.'],
  ['2027-09-05', "Teachers' Day", SP, false, '🍎', "Happy Teachers' Day!"],
  ['2027-09-15', "Engineers' Day", SP, false, '⚙️', "Happy Engineers' Day to our technicians and engineers!"],
  ['2027-10-02', 'Gandhi Jayanthi', G, true, '🕊️', 'Happy Gandhi Jayanthi! Be the change you wish to see.'],
  ['2027-10-08', 'Ayudha Pooja', G, true, '🔧', 'Happy Ayudha Pooja! Honouring the tools and hands that do great work.'],
  ['2027-10-09', 'Vijaya Dasami', G, true, '🏹', 'Happy Vijaya Dasami! A great day to start something new.'],
  ['2027-10-28', 'Deepavali', G, true, '🪔', 'Happy Deepavali! May the festival of lights fill your home with joy. Celebrate safely!'],
  ['2027-11-14', "Children's Day", SP, false, '🎈', "Happy Children's Day! Stay young at heart."],
  ['2027-12-25', 'Christmas', G, true, '🎄', 'Merry Christmas! Wishing you joy and peace.'],
  ['2027-12-31', "New Year's Eve", SP, false, '🥳', 'Thank you for a great 2027!'],
];
const HCOLS = `id, to_char(day,'YYYY-MM-DD') AS day, name, kind, is_holiday, emoji, greeting`;
const officeHolidays = async (from, to) => { const o = {}; (await q(`SELECT ${HCOLS} FROM holidays WHERE is_holiday AND day BETWEEN $1 AND $2`, [from, to])).rows.forEach(h => { o[h.day] = o[h.day] ? o[h.day] + ' · ' + h.name : h.name; }); return o; };
app.get('/api/holidays', wrap(async (req, res) => {
  const y = /^\d{4}$/.test(req.query.year || '') ? req.query.year : (await todayIST()).slice(0, 4);
  res.set('Cache-Control', 'no-store').json({ year: y, today: await todayIST(), items: (await q(`SELECT ${HCOLS} FROM holidays WHERE EXTRACT(YEAR FROM day)=$1 ORDER BY day, is_holiday DESC, name`, [y])).rows });
}));
const holBody = b => {
  const day = String(b.day || ''), name = String(b.name || '').trim().slice(0, 80);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { error: 'Choose a date' };
  if (!name) return { error: 'Write the name' };
  const kind = [G, F, SP].includes(b.kind) ? b.kind : F;
  return { v: [day, name, kind, !!b.is_holiday, String(b.emoji || '').slice(0, 8) || '🎉', String(b.greeting || '').trim().slice(0, 400) || null] };
};
app.post('/api/holidays', wrap(async (req, res) => {
  if (!isSuper(req.user)) return res.status(403).json({ error: 'Only the Super Admin can change holidays' });
  const h = holBody(req.body || {}); if (h.error) return res.status(400).json(h);
  const r = await q(`INSERT INTO holidays(day,name,kind,is_holiday,emoji,greeting) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (day,name) DO UPDATE SET kind=$3,is_holiday=$4,emoji=$5,greeting=$6 RETURNING id`, h.v);
  res.json({ id: r.rows[0].id });
}));
app.patch('/api/holidays/:id', wrap(async (req, res) => {
  if (!isSuper(req.user)) return res.status(403).json({ error: 'Only the Super Admin can change holidays' });
  const h = holBody(req.body || {}); if (h.error) return res.status(400).json(h);
  await q(`UPDATE holidays SET day=$2,name=$3,kind=$4,is_holiday=$5,emoji=$6,greeting=$7 WHERE id=$1`, [req.params.id, ...h.v]); res.json({ ok: true });
}));
app.delete('/api/holidays/:id', superOnly, wrap(async (req, res) => { await q('DELETE FROM holidays WHERE id=$1', [req.params.id]); res.json({ ok: true }); }));

// Thoughts for an ordinary day (one per day, same for everyone)
const DAILY = [
  ['☀️', 'Small things done well every day add up to big results.'],
  ['🚀', 'Every happy customer is the best advertisement we will ever have.'],
  ['💪', 'Hard work beats talent when talent does not work hard.'],
  ['🤝', 'Alone we can do so little; together we can do so much.'],
  ['🎯', 'Focus on one job at a time and finish it like a pro.'],
  ['🌱', 'Learn one new thing today — tomorrow you will be glad you did.'],
  ['😊', 'A smile at the customer’s door is part of the service.'],
  ['⚡', 'Done is better than perfect — but neat and safe is non-negotiable.'],
  ['🧠', 'Listen first, then fix. The customer usually tells you the problem.'],
  ['🏆', 'Quality is remembered long after the price is forgotten.'],
  ['🔧', 'Take care of your tools and they will take care of you.'],
  ['📞', 'A quick call to update a customer saves ten angry calls later.'],
  ['🌈', 'Positive mind, positive day, positive results.'],
  ['⏰', 'On time is the new early. Respect the customer’s time.'],
  ['🙌', 'Thank a teammate today — appreciation is free and powerful.'],
  ['🧹', 'Leave every site cleaner than you found it.'],
  ['📈', 'Better than yesterday — that is the only target that matters.'],
  ['🛡️', 'Safety first, always. Your family is waiting for you at home.'],
  ['💡', 'Every problem has a solution — sometimes it just needs a fresh look.'],
  ['🎉', 'Celebrate small wins. They keep the big goals moving.'],
  ['🌟', 'Your work today builds the name of Heaven Automation tomorrow.'],
];
const GREET_TIME = h => h < 12 ? ['Good morning', '🌅'] : h < 16 ? ['Good afternoon', '🌤️'] : h < 20 ? ['Good evening', '🌇'] : ['Good night', '🌙'];
app.get('/api/greeting', wrap(async (req, res) => {
  const today = await todayIST(), uid = req.user.id;
  const now = (await q(`SELECT EXTRACT(HOUR FROM now() AT TIME ZONE '${TZ}')::int h, to_char((now() AT TIME ZONE '${TZ}')::date+1,'YYYY-MM-DD') tm`)).rows[0];
  const key = `greet:${uid}`, seen = ((await q('SELECT v FROM settings WHERE k=$1', [key])).rows[0] || {}).v;
  const first = seen !== today;
  if (first && req.query.mark) await q(`INSERT INTO settings(k,v) VALUES($1,$2) ON CONFLICT (k) DO UPDATE SET v=$2`, [key, today]);
  const days = (await q(`SELECT ${HCOLS} FROM holidays WHERE day=$1 ORDER BY is_holiday DESC, kind`, [today])).rows;
  const tomorrow = (await q(`SELECT ${HCOLS} FROM holidays WHERE day=$1 AND is_holiday`, [now.tm])).rows;
  const next = (await q(`SELECT ${HCOLS} FROM holidays WHERE day>$1 AND is_holiday ORDER BY day LIMIT 1`, [today])).rows[0] || null;
  const u = (await q(`SELECT name, to_char(join_date,'MM-DD') jmd, EXTRACT(YEAR FROM join_date)::int jy FROM users WHERE id=$1`, [uid])).rows[0] || {};
  const yrs = u.jmd && u.jmd === today.slice(5) && u.jy < +today.slice(0, 4) ? +today.slice(0, 4) - u.jy : 0;
  const n = Math.floor(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10)) / 864e5), [e, t] = DAILY[n % DAILY.length];
  const [hi, he] = GREET_TIME(now.h);
  // a short "your day" line
  let mine = null;
  try {
    if (req.user.role === 'Technician') mine = (await q(`SELECT COUNT(*)::int n FROM services WHERE (technician_id=$1 OR helper_id=$1) AND status NOT IN ('Resolved','Cancelled')`, [uid])).rows[0].n + ' open job(s) for you';
    else if (req.user.role !== 'Staff') { const d = (await q(`SELECT COUNT(*)::int n FROM todos WHERE COALESCE(for_user,created_by)=$1 AND NOT done AND to_char(due_at AT TIME ZONE '${TZ}','YYYY-MM-DD')=$2`, [uid, today])).rows[0]; mine = d.n ? `${d.n} reminder(s) due today` : null; }
  } catch (x) { mine = null; }
  res.set('Cache-Control', 'no-store').json({ first, today, hello: hi, hello_emoji: he, name: (u.name || req.user.name || '').split(' ')[0],
    days, tomorrow, next, anniversary: yrs, thought: { emoji: e, text: t }, mine });
}));
// Morning wishes on the day itself, and an evening heads-up the day before an office holiday
async function holidayDue() {
  try {
    const t = (await q(`SELECT to_char(now() AT TIME ZONE '${TZ}','YYYY-MM-DD') d, EXTRACT(HOUR FROM now() AT TIME ZONE '${TZ}')::int h, to_char((now() AT TIME ZONE '${TZ}')::date+1,'YYYY-MM-DD') tm`)).rows[0];
    const once = async k => (await q(`INSERT INTO settings(k,v) VALUES($1,'1') ON CONFLICT (k) DO NOTHING RETURNING k`, [k])).rows.length > 0;
    const everyone = async () => (await q('SELECT id FROM users WHERE active')).rows.map(r => r.id);
    if (t.h >= 8) for (const h of (await q(`SELECT ${HCOLS} FROM holidays WHERE day=$1`, [t.d])).rows)
      if (await once(`holnote:${t.d}:${h.id}`)) await notifyLink(await everyone(), `${h.emoji || '🎉'} ${h.is_holiday ? 'Holiday today' : 'Today'} · ${h.name}`, h.greeting || `Wishing you a wonderful ${h.name}!`, 'greet');
    if (t.h >= 17) for (const h of (await q(`SELECT ${HCOLS} FROM holidays WHERE day=$1 AND is_holiday`, [t.tm])).rows)
      if (await once(`holeve:${t.tm}:${h.id}`)) await notifyLink(await everyone(), `📅 Tomorrow is a holiday · ${h.name}`, `The office is closed tomorrow (${new Date(t.tm + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' })}) for ${h.name}. Enjoy! ${h.emoji || ''}`, 'greet');
  } catch (e) { console.error('holiday notify', e.message); }
}


// =====================================================================
// ---------- Projects: a lead becomes a project with its own team chat, tasks and files ----------
// =====================================================================
const PSTAT = ['Planning', 'In Progress', 'On Hold', 'Completed', 'Cancelled'];
async function initProjects() {
  await q(`
  CREATE TABLE IF NOT EXISTS projects (id SERIAL PRIMARY KEY, lead_id INT UNIQUE, name TEXT NOT NULL, company TEXT, contact TEXT, phone TEXT, email TEXT, address TEXT,
    lat DOUBLE PRECISION, lng DOUBLE PRECISION, map_url TEXT, brand_id INT, status TEXT DEFAULT 'Planning', value NUMERIC(12,2) DEFAULT 0, start_date DATE, due_date DATE,
    notes TEXT, source TEXT, interest TEXT, chat_id INT, created_by INT, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS project_tasks (id SERIAL PRIMARY KEY, project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, title TEXT NOT NULL, assigned_to INT,
    due_date DATE, done BOOLEAN DEFAULT false, done_by TEXT, done_at TIMESTAMPTZ, created_by INT, created_at TIMESTAMPTZ DEFAULT now());
  CREATE INDEX IF NOT EXISTS idx_ptask ON project_tasks(project_id);
  ALTER TABLE chats ADD COLUMN IF NOT EXISTS project_id INT UNIQUE;
  ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS fname TEXT;
  ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS fsize INT;`);
}
const PCOLS = `p.*, to_char(p.start_date,'YYYY-MM-DD') start_d, to_char(p.due_date,'YYYY-MM-DD') due_d, (SELECT name FROM brands WHERE id=p.brand_id) brand`;
const projTeam = async pid => (await q(`SELECT u.id, u.name, u.role, u.photo_v, COALESCE(b.name, pb.name) brand FROM chats c JOIN chat_members m ON m.chat_id=c.id JOIN users u ON u.id=m.user_id
  LEFT JOIN brands b ON b.id=u.brand_id LEFT JOIN brands pb ON pb.id=u.pay_brand_id WHERE c.project_id=$1 ORDER BY (u.role=$2) DESC, u.name`, [pid, SUPER])).rows;
// can this user open the project?  Super Admin: always. Others: when they are in the project team.
const projFor = async (u, id) => {
  const p = (await q(`SELECT ${PCOLS} FROM projects p WHERE p.id=$1`, [id])).rows[0];
  if (!p || !can(u, 'projects')) return null;
  if (isSuper(u)) { await q('INSERT INTO chat_members(chat_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [p.chat_id, u.id]); return p; }
  return (await q('SELECT 1 FROM chat_members WHERE chat_id=$1 AND user_id=$2', [p.chat_id, u.id])).rows.length ? p : null;
};
const projEdit = u => isSuper(u) || u.role === 'Admin';
const pDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null;
async function makeProject(u, d, team) {
  const p = (await q(`INSERT INTO projects(lead_id,name,company,contact,phone,email,address,lat,lng,map_url,brand_id,status,value,start_date,due_date,notes,source,interest,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Planning',$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
    [d.lead_id || null, d.name, d.company || null, d.contact || null, d.phone || null, d.email || null, d.address || null, d.lat ?? null, d.lng ?? null, d.map_url || null,
     d.brand_id || null, Math.max(0, +d.value || 0), pDate(d.start_date) || await todayIST(), pDate(d.due_date), d.notes || null, d.source || null, d.interest || null, u.id])).rows[0];
  const c = (await q(`INSERT INTO chats(kind,name,project_id,created_by) VALUES('project',$1,$2,$3) RETURNING id`, [('Project · ' + p.name).slice(0, 80), p.id, u.id])).rows[0];
  await q('UPDATE projects SET chat_id=$2 WHERE id=$1', [p.id, c.id]);
  const ids = [...new Set([...(await q('SELECT id FROM users WHERE active AND role=$1', [SUPER])).rows.map(r => r.id), u.id, ...team].filter(Boolean))];
  const act = (await q('SELECT id FROM users WHERE active AND id=ANY($1)', [ids])).rows.map(r => r.id);
  for (const id of act) await q('INSERT INTO chat_members(chat_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [c.id, id]);
  return { ...p, chat_id: c.id, team: act };
}
const projNote = (ids, title, body, pid) => notifyLink(ids, title, body, 'project:' + pid);

app.get('/api/projects', need('projects'), wrap(async (req, res) => {
  const u = req.user, sup = isSuper(u);
  const rows = (await q(`SELECT ${PCOLS}, m.last_read,
      (SELECT COUNT(*)::int FROM chat_messages x WHERE x.chat_id=p.chat_id AND x.id>COALESCE(m.last_read,0) AND x.user_id IS DISTINCT FROM $1 AND NOT x.deleted) unread,
      (SELECT COUNT(*)::int FROM project_tasks t WHERE t.project_id=p.id) tasks, (SELECT COUNT(*)::int FROM project_tasks t WHERE t.project_id=p.id AND t.done) done,
      (SELECT COUNT(*)::int FROM chat_members mm WHERE mm.chat_id=p.chat_id) team_n,
      (SELECT MAX(created_at) FROM chat_messages x WHERE x.chat_id=p.chat_id) last_at
    FROM projects p LEFT JOIN chat_members m ON m.chat_id=p.chat_id AND m.user_id=$1
    WHERE ${sup ? 'TRUE' : 'm.user_id IS NOT NULL'} ORDER BY (p.status IN ('Completed','Cancelled')), COALESCE((SELECT MAX(created_at) FROM chat_messages x WHERE x.chat_id=p.chat_id), p.updated_at) DESC`, [u.id])).rows;
  const ids = rows.map(r => r.id), team = {};
  if (ids.length) (await q(`SELECT c.project_id, u.id, u.name, u.photo_v FROM chats c JOIN chat_members m ON m.chat_id=c.id JOIN users u ON u.id=m.user_id WHERE c.project_id=ANY($1) AND u.role<>$2 ORDER BY u.name`, [ids, SUPER])).rows
    .forEach(t => { (team[t.project_id] = team[t.project_id] || []).push({ id: t.id, name: t.name, photo_v: t.photo_v }); });
  res.set('Cache-Control', 'no-store').json({ statuses: PSTAT, items: rows.map(r => ({ ...r, start_date: r.start_d, due_date: r.due_d, team: team[r.id] || [] })) });
}));
app.post('/api/projects', wrap(async (req, res) => {
  if (!isSuper(req.user)) return res.status(403).json({ error: 'Only the Super Admin can start a project' });
  const b = req.body || {}, name = String(b.name || '').trim().slice(0, 100);
  if (!name) return res.status(400).json({ error: 'Give the project a name' });
  const brand = Number.isInteger(+b.brand_id) && +b.brand_id > 0 ? +b.brand_id : (await q(`SELECT id FROM brands ORDER BY (lower(name)='heaven') DESC, id LIMIT 1`)).rows[0].id;
  const team = Array.isArray(b.team) ? b.team.map(Number) : [];
  const p = await makeProject(req.user, { ...b, name, brand_id: brand }, team);
  await sysMsg(p.chat_id, `${req.user.name} started the project “${name}”`);
  await projNote(p.team.filter(x => x !== req.user.id), '📁 Added to a project', `${req.user.name} added you to “${name}”`, p.id);
  res.json({ id: p.id });
}));
// lead → project (keeps all the lead details and brings the lead discussion along)
app.post('/api/leads/:id/project', need('leads'), need('projects'), wrap(async (req, res) => {
  const l = await leadOK(req, res, req.params.id); if (!l) return;
  const ex = (await q('SELECT id FROM projects WHERE lead_id=$1', [l.id])).rows[0];
  if (ex) return res.json({ id: ex.id, existed: true });
  const p = await makeProject(req.user, { lead_id: l.id, name: (l.company || l.name).slice(0, 100), company: l.company, contact: l.name, phone: l.phone, email: l.email, address: l.address,
    lat: l.lat, lng: l.lng, map_url: l.map_url, brand_id: l.brand_id, value: l.value, notes: l.notes, source: l.source, interest: l.interest }, [l.assigned_to, l.created_by]);
  const lc = (await q('SELECT id FROM chats WHERE lead_id=$1', [l.id])).rows[0];
  if (lc) await q(`INSERT INTO chat_messages(chat_id,user_id,user_name,kind,body,mime,data,duration,w,h,mentions,deleted,created_at,fname,fsize)
    SELECT $1,user_id,user_name,kind,body,mime,data,duration,w,h,mentions,deleted,created_at,fname,fsize FROM chat_messages WHERE chat_id=$2 AND kind<>'system' ORDER BY id`, [p.chat_id, lc.id]);
  await sysMsg(p.chat_id, `📁 ${req.user.name} converted the lead “${l.name}${l.company ? ' · ' + l.company : ''}” into this project${lc ? ' — the lead discussion is above' : ''}`);
  await leadLog(l.id, req.user.name, '📁 Converted to a project');
  await projNote(p.team.filter(x => x !== req.user.id), '📁 New project', `${req.user.name} converted the lead “${l.name}” into a project`, p.id);
  res.json({ id: p.id });
}));
app.get('/api/projects/:id', wrap(async (req, res) => {
  const p = await projFor(req.user, +req.params.id); if (!p) return res.status(404).json({ error: 'Not found' });
  const tasks = (await q(`SELECT t.*, to_char(t.due_date,'YYYY-MM-DD') due_d, u.name assigned_name, u.photo_v FROM project_tasks t LEFT JOIN users u ON u.id=t.assigned_to WHERE t.project_id=$1 ORDER BY t.done, t.id`, [p.id])).rows;
  const lead = p.lead_id ? (await q(`SELECT id, name, stage, priority, follow_up, created_at, (SELECT name FROM users WHERE id=assigned_to) agent, (SELECT name FROM users WHERE id=created_by) by FROM leads WHERE id=$1`, [p.lead_id])).rows[0] || null : null;
  const activity = p.lead_id ? (await q('SELECT by_name, text, created_at FROM lead_activity WHERE lead_id=$1 ORDER BY id DESC LIMIT 40', [p.lead_id])).rows : [];
  const ur = (await q(`SELECT COUNT(*)::int n FROM chat_messages x JOIN chat_members m ON m.chat_id=x.chat_id AND m.user_id=$2 WHERE x.chat_id=$1 AND x.id>m.last_read AND x.user_id IS DISTINCT FROM $2 AND NOT x.deleted`, [p.chat_id, req.user.id])).rows[0].n;
  const lm = (await q(`SELECT ${MSG_COLS} FROM chat_messages x LEFT JOIN users u ON u.id=x.user_id WHERE x.chat_id=$1 AND x.kind<>'system' ORDER BY x.id DESC LIMIT 3`, [p.chat_id])).rows.reverse();
  res.set('Cache-Control', 'no-store').json({ ...p, start_date: p.start_d, due_date: p.due_d, statuses: PSTAT, unread: ur, recent: lm.map(m => ({ who: m.user_id === req.user.id ? 'You' : m.user_name, text: preview(m), at: m.created_at })), team: await projTeam(p.id), tasks: tasks.map(t => ({ ...t, due_date: t.due_d })), lead, activity,
    can_edit: projEdit(req.user), can_team: isSuper(req.user), creator: (await q('SELECT name FROM users WHERE id=$1', [p.created_by])).rows[0]?.name || '' });
}));
app.patch('/api/projects/:id', wrap(async (req, res) => {
  const p = await projFor(req.user, +req.params.id); if (!p) return res.status(404).json({ error: 'Not found' });
  if (!projEdit(req.user)) return res.status(403).json({ error: 'Only the Super Admin or admin staff can change project details' });
  const b = req.body || {}, set = [], val = [p.id], add = (k, v) => { val.push(v); set.push(`${k}=$${val.length}`); };
  if (b.name !== undefined) { const n = String(b.name).trim().slice(0, 100); if (!n) return res.status(400).json({ error: 'Give the project a name' }); add('name', n); }
  for (const k of ['company', 'contact', 'phone', 'email', 'address', 'map_url', 'notes']) if (b[k] !== undefined) add(k, String(b[k] || '').trim().slice(0, 2000) || null);
  if (b.value !== undefined) add('value', Math.max(0, +b.value || 0));
  if (b.start_date !== undefined) add('start_date', pDate(b.start_date));
  if (b.due_date !== undefined) add('due_date', pDate(b.due_date));
  if (b.brand_id !== undefined && isSuper(req.user)) add('brand_id', +b.brand_id || null);
  let stMsg = null;
  if (b.status !== undefined) { if (!PSTAT.includes(b.status)) return res.status(400).json({ error: 'Choose a status' }); if (b.status !== p.status) { add('status', b.status); stMsg = b.status; } }
  if (!set.length) return res.json({ ok: true });
  await q(`UPDATE projects SET ${set.join(',')}, updated_at=now() WHERE id=$1`, val);
  if (b.name) await q('UPDATE chats SET name=$2 WHERE id=$1', [p.chat_id, ('Project · ' + String(b.name).trim()).slice(0, 80)]);
  if (stMsg) {
    await sysMsg(p.chat_id, `${req.user.name} changed the status to “${stMsg}”`);
    await projNote((await projTeam(p.id)).map(t => t.id).filter(x => x !== req.user.id), `📁 ${p.name}: ${stMsg}`, `${req.user.name} changed the project status to ${stMsg}`, p.id);
  }
  res.json({ ok: true });
}));
app.post('/api/projects/:id/team', wrap(async (req, res) => {
  if (!isSuper(req.user)) return res.status(403).json({ error: 'Only the Super Admin can add or remove people' });
  const p = await projFor(req.user, +req.params.id); if (!p) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {}, add = Array.isArray(b.add) ? b.add.map(Number) : [], rem = Array.isArray(b.remove) ? b.remove.map(Number) : [];
  if (add.length) {
    const ok = (await q('SELECT id, name FROM users WHERE active AND id=ANY($1) AND id NOT IN (SELECT user_id FROM chat_members WHERE chat_id=$2)', [add, p.chat_id])).rows;
    for (const x of ok) await q(`INSERT INTO chat_members(chat_id,user_id,last_read) VALUES($1,$2,0) ON CONFLICT DO NOTHING`, [p.chat_id, x.id]);
    if (ok.length) { await sysMsg(p.chat_id, `${req.user.name} added ${ok.map(x => x.name).join(', ')}`); await projNote(ok.map(x => x.id), '📁 Added to a project', `${req.user.name} added you to “${p.name}”`, p.id); }
  }
  if (rem.length) {
    const gone = (await q(`DELETE FROM chat_members m USING users u WHERE u.id=m.user_id AND m.chat_id=$1 AND m.user_id=ANY($2) AND u.role<>$3 RETURNING u.name`, [p.chat_id, rem, SUPER])).rows;
    if (gone.length) await sysMsg(p.chat_id, `${req.user.name} removed ${gone.map(x => x.name).join(', ')}`);
  }
  res.json({ ok: true, team: await projTeam(p.id) });
}));
app.delete('/api/projects/:id', superOnly, wrap(async (req, res) => {
  const p = (await q('SELECT chat_id FROM projects WHERE id=$1', [req.params.id])).rows[0];
  if (!p) return res.status(404).json({ error: 'Not found' });
  await q('DELETE FROM chats WHERE id=$1', [p.chat_id]); await q('DELETE FROM projects WHERE id=$1', [req.params.id]); res.json({ ok: true });
}));
// tasks / checklist
app.post('/api/projects/:id/tasks', wrap(async (req, res) => {
  const p = await projFor(req.user, +req.params.id); if (!p) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {}, title = String(b.title || '').trim().slice(0, 300);
  if (!title) return res.status(400).json({ error: 'Write the task' });
  const team = (await projTeam(p.id)).map(t => t.id), to = team.includes(+b.assigned_to) ? +b.assigned_to : null;
  const r = await q('INSERT INTO project_tasks(project_id,title,assigned_to,due_date,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id', [p.id, title, to, pDate(b.due_date), req.user.id]);
  await sysMsg(p.chat_id, `✅ ${req.user.name} added a task: ${title}${to ? ' → ' + ((await q('SELECT name FROM users WHERE id=$1', [to])).rows[0] || {}).name : ''}`);
  if (to && to !== req.user.id) await projNote([to], `📌 New task · ${p.name}`, `${req.user.name}: ${title}`, p.id);
  res.json({ id: r.rows[0].id });
}));
app.patch('/api/project-tasks/:id', wrap(async (req, res) => {
  const t = (await q('SELECT * FROM project_tasks WHERE id=$1', [req.params.id])).rows[0]; if (!t) return res.status(404).json({ error: 'Not found' });
  const p = await projFor(req.user, t.project_id); if (!p) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  if (b.done !== undefined) {
    await q('UPDATE project_tasks SET done=$2, done_by=$3, done_at=CASE WHEN $2 THEN now() END WHERE id=$1', [t.id, !!b.done, b.done ? req.user.name : null]);
    if (b.done && !t.done) {
      await sysMsg(p.chat_id, `☑️ ${req.user.name} finished: ${t.title}`);
      const who = [t.created_by].filter(x => x && x !== req.user.id); if (who.length) await projNote(who, `☑️ Task done · ${p.name}`, `${req.user.name} finished: ${t.title}`, p.id);
    }
  }
  if (b.title !== undefined && String(b.title).trim()) await q('UPDATE project_tasks SET title=$2 WHERE id=$1', [t.id, String(b.title).trim().slice(0, 300)]);
  res.json({ ok: true });
}));
app.delete('/api/project-tasks/:id', wrap(async (req, res) => {
  const t = (await q('SELECT * FROM project_tasks WHERE id=$1', [req.params.id])).rows[0]; if (!t) return res.status(404).json({ error: 'Not found' });
  if (!isSuper(req.user) && t.created_by !== req.user.id) return res.status(403).json({ error: 'Only the Super Admin or the person who added it can delete a task' });
  await q('DELETE FROM project_tasks WHERE id=$1', [t.id]); res.json({ ok: true });
}));
// every photo and file shared in a chat (used by the project Files tab)
app.get('/api/chats/:id/files', wrap(async (req, res) => {
  const c = await chatFor(req.user, +req.params.id); if (!c) return res.status(404).json({ error: 'Not found' });
  res.set('Cache-Control', 'no-store').json({ items: (await q(`SELECT id, kind, body, mime, fname, fsize, w, h, user_name, created_at FROM chat_messages WHERE chat_id=$1 AND kind IN ('image','file') AND NOT deleted ORDER BY id DESC`, [c.id])).rows });
}));


// =====================================================================
// ---------- Notes (Apple Notes style) — each note belongs to a person and a day; the Super Admin can write notes for anyone ----------
// =====================================================================
const NCOLS = `n.id, n.user_id, to_char(n.day,'YYYY-MM-DD') AS day, n.title, n.body, n.pinned, n.created_by, n.created_by_name, n.created_at, n.updated_at, u.name user_name, u.photo_v`;
const noteFor = async (u, id) => {
  const n = (await q(`SELECT n.*, to_char(n.day,'YYYY-MM-DD') AS day FROM notes n WHERE n.id=$1`, [id])).rows[0];
  return n && (n.user_id === u.id || n.created_by === u.id || isSuper(u)) ? n : null;
};
const noteBody = b => ({ title: String(b.title || '').trim().slice(0, 200), body: String(b.body || '').replace(/\s+$/, '').slice(0, 20000) });
app.get('/api/notes', wrap(async (req, res) => {
  const u = req.user, p = [], w = [];
  const who = req.query.user;
  if (isSuper(u) && who === 'all') w.push('TRUE');
  else if (isSuper(u) && who === 'sent') { p.push(u.id); w.push(`n.created_by=$${p.length} AND n.user_id<>$${p.length}`); }
  else if (isSuper(u) && Number.isInteger(+who) && +who > 0) { p.push(+who); w.push(`n.user_id=$${p.length}`); }
  else { p.push(u.id); w.push(`n.user_id=$${p.length}`); }
  if (isDate(req.query.day)) { p.push(req.query.day); w.push(`n.day=$${p.length}`); }
  if (req.query.q) { p.push('%' + String(req.query.q).slice(0, 80) + '%'); w.push(`(n.title ILIKE $${p.length} OR n.body ILIKE $${p.length})`); }
  res.set('Cache-Control', 'no-store').json({ today: await todayIST(), items: (await q(`SELECT ${NCOLS} FROM notes n JOIN users u ON u.id=n.user_id WHERE ${w.join(' AND ')} ORDER BY n.pinned DESC, n.day DESC, n.updated_at DESC LIMIT 500`, p)).rows });
}));
app.get('/api/notes/:id', wrap(async (req, res) => {
  const n = await noteFor(req.user, +req.params.id); if (!n) return res.status(404).json({ error: 'Note not found' });
  res.json((await q(`SELECT ${NCOLS} FROM notes n JOIN users u ON u.id=n.user_id WHERE n.id=$1`, [n.id])).rows[0]);
}));
app.post('/api/notes', wrap(async (req, res) => {
  const b = req.body || {}, u = req.user, { title, body } = noteBody(b);
  if (!title && !body.trim()) return res.status(400).json({ error: 'Write something first' });
  let uid = u.id;
  if (b.user_id && +b.user_id !== u.id) {
    if (!isSuper(u)) return res.status(403).json({ error: 'Only the Super Admin can write notes for other people' });
    if (!(await q('SELECT 1 FROM users WHERE id=$1 AND active', [+b.user_id])).rows.length) return res.status(404).json({ error: 'Person not found' });
    uid = +b.user_id;
  }
  const day = isDate(b.day) ? b.day : await todayIST();
  const r = (await q(`INSERT INTO notes(user_id,day,title,body,pinned,created_by,created_by_name) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [uid, day, title || null, body || null, !!b.pinned, u.id, u.name])).rows[0];
  if (uid !== u.id) await notifyLink([uid], `📝 Note from ${u.name}`, `${title || body.split('\n')[0].slice(0, 80)} · for ${new Date(day + 'T12:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}`, 'note:' + r.id);
  res.json({ id: r.id });
}));
app.patch('/api/notes/:id', wrap(async (req, res) => {
  const n = await noteFor(req.user, +req.params.id); if (!n) return res.status(404).json({ error: 'Note not found' });
  const b = req.body || {}, set = [], val = [n.id], add = (k, v) => { val.push(v); set.push(`${k}=$${val.length}`); };
  if (b.title !== undefined || b.body !== undefined) { const x = noteBody({ title: b.title ?? n.title, body: b.body ?? n.body }); add('title', x.title || null); add('body', x.body || null); }
  if (b.day !== undefined && isDate(b.day)) add('day', b.day);
  if (b.pinned !== undefined) add('pinned', !!b.pinned);
  if (set.length) await q(`UPDATE notes SET ${set.join(',')}, updated_at=now() WHERE id=$1`, val);
  res.json({ ok: true });
}));
app.delete('/api/notes/:id', wrap(async (req, res) => {
  const n = await noteFor(req.user, +req.params.id); if (!n) return res.status(404).json({ error: 'Note not found' });
  await q('DELETE FROM notes WHERE id=$1', [n.id]); res.json({ ok: true });
}));


// =====================================================================
// ---------- WhatsApp Business (Meta Cloud API): Sales + Service numbers, shared inbox ----------
// Keys can be set in Render → Environment (WA_TOKEN, WA_APP_SECRET, WA_VERIFY_TOKEN, WA_WABA_ID,
// WA_SALES_PHONE_ID, WA_SERVICE_PHONE_ID) or in the app: Profile → WhatsApp setup (Super Admin).
// =====================================================================
// Every WhatsApp number is a row in wa_numbers: brand + purpose (Sales / Service), its own Phone number ID,
// optional own WhatsApp Business Account (WABA) and token. Staff see only the numbers of their own brand.
const WA_RATES = { service: 0.115, utility: 0.115, marketing: 0.8631, authentication: 0.115, free: 1000, gst: 0.18 };   // Meta India card (Oct 2026), ₹ per message
let WA_CFG = null;
async function waDb() { try { return JSON.parse(((await q(`SELECT v FROM settings WHERE k='wa_cfg'`)).rows[0] || {}).v || '{}'); } catch (e) { return {}; } }
async function waCfg(fresh) {
  if (WA_CFG && !fresh) return WA_CFG;
  const db = await waDb(), E = process.env, pick = (k, e) => E[e] || db[k] || '';
  const token = pick('token', 'WA_TOKEN'), waba = pick('waba_id', 'WA_WABA_ID');
  const rows = (await q(`SELECT n.*, b.name brand FROM wa_numbers n LEFT JOIN brands b ON b.id=n.brand_id ORDER BY n.sort, n.id`).catch(() => ({ rows: [] }))).rows;
  const numbers = rows.map(n => {
    const envPid = n.key === 'sales' ? E.WA_SALES_PHONE_ID : n.key === 'service' ? E.WA_SERVICE_PHONE_ID : '';
    const purpose = n.purpose === 'service' ? 'service' : 'sales';
    return { id: n.id, key: n.key, line: n.key, purpose, brand_id: n.brand_id || null, brand: n.brand || null, phone_id: String(envPid || n.phone_id || ''), number: n.number || '',
      waba_id: n.waba_id || waba, own_waba: !!n.waba_id, token: n.token || token, own_token: !!n.token, enabled: n.enabled !== false, auto_lead: n.auto_lead !== false, env_phone: !!envPid,
      name: n.label || '', label: n.label || ((n.brand ? n.brand + ' · ' : '') + (purpose === 'sales' ? 'Sales' : 'Service')) };
  });
  const by = {}; numbers.forEach(n => { by[n.key] = n; });
  WA_CFG = { token, app_secret: pick('app_secret', 'WA_APP_SECRET'), verify_token: pick('verify_token', 'WA_VERIFY_TOKEN'), waba_id: waba, numbers, by,
    graph: (E.WA_GRAPH_URL || 'https://graph.facebook.com') + '/' + (E.WA_API_VERSION || 'v21.0'),
    from_env: { token: !!E.WA_TOKEN, app_secret: !!E.WA_APP_SECRET, verify_token: !!E.WA_VERIFY_TOKEN, waba_id: !!E.WA_WABA_ID, sales_phone_id: !!E.WA_SALES_PHONE_ID, service_phone_id: !!E.WA_SERVICE_PHONE_ID } };
  return WA_CFG;
}
const waLineOf = async phoneId => { const c = await waCfg(); const n = c.numbers.find(x => x.phone_id && x.phone_id === String(phoneId)); return n ? n.key : null; };
const waReady = n => !!(n && n.token && n.phone_id);
// who sees a number: Super Admin all; others only switched-on numbers of their brand (or numbers shared by all brands)
const waSees = (u, n) => !!n && (isSuper(u) || (n.enabled && (!u.brand_id || !n.brand_id || n.brand_id === u.brand_id)));
const waMine = async u => (await waCfg()).numbers.filter(n => waSees(u, n));
const waDigits = p => { let d = String(p || '').replace(/\D/g, ''); if (d.length === 10) d = '91' + d; return d; };
const last10 = p => String(p || '').replace(/\D/g, '').slice(-10);
const waSlug = name => { const w = String(name || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean); return !w.length ? '' : w[0].length <= 2 && w[1] ? w[0] + w[1] : w[0]; };
// call Meta's Graph API (each number may have its own token)
async function graph(path, opt = {}) {
  const c = await waCfg(), token = opt.token || c.token;
  if (!token) throw new Error('WhatsApp is not connected yet — add the access token in WhatsApp setup');
  const r = await fetch(c.graph + path, { method: opt.method || 'GET', headers: { Authorization: 'Bearer ' + token, ...(opt.json ? { 'Content-Type': 'application/json' } : {}) }, body: opt.json ? JSON.stringify(opt.json) : opt.body });
  const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (e) { j = { raw: t }; }
  if (!r.ok || j.error) {
    const e = j.error || {}, d = (e.error_data && e.error_data.details) || e.error_user_msg || '';
    const nice = e.code === 131047 || e.code === 131026 ? 'More than 24 hours since the customer’s last message — send a template instead'
      : e.code === 190 ? 'The access token has expired or is wrong — update it in WhatsApp setup'
      : e.code === 131030 ? 'This number is not in the allowed list (test mode) — add it in Meta or go live'
      : (e.message || 'WhatsApp error') + (d ? ' — ' + d : '');
    const err = new Error(nice); err.meta = e; throw err;
  }
  return j;
}
async function initWA() {
  await q(`
  CREATE TABLE IF NOT EXISTS wa_threads (id SERIAL PRIMARY KEY, line TEXT NOT NULL, wa_phone TEXT NOT NULL, name TEXT, lead_id INT, customer_id INT,
    last_in_at TIMESTAMPTZ, last_at TIMESTAMPTZ DEFAULT now(), created_at TIMESTAMPTZ DEFAULT now(), UNIQUE(line, wa_phone));
  CREATE TABLE IF NOT EXISTS wa_messages (id SERIAL PRIMARY KEY, thread_id INT NOT NULL REFERENCES wa_threads(id) ON DELETE CASCADE, dir TEXT NOT NULL, wa_id TEXT UNIQUE,
    type TEXT, body TEXT, media_id TEXT, mime TEXT, fname TEXT, data BYTEA, lat DOUBLE PRECISION, lng DOUBLE PRECISION, status TEXT, error TEXT,
    category TEXT, template TEXT, sent_by INT, sent_by_name TEXT, reply_to TEXT, created_at TIMESTAMPTZ DEFAULT now());
  CREATE INDEX IF NOT EXISTS idx_wam_thread ON wa_messages(thread_id, id);
  CREATE TABLE IF NOT EXISTS wa_reads (thread_id INT NOT NULL REFERENCES wa_threads(id) ON DELETE CASCADE, user_id INT NOT NULL, last_read INT DEFAULT 0, PRIMARY KEY(thread_id, user_id));
  CREATE TABLE IF NOT EXISTS wa_numbers (id SERIAL PRIMARY KEY, key TEXT UNIQUE NOT NULL, label TEXT, purpose TEXT DEFAULT 'sales', brand_id INT, phone_id TEXT, number TEXT,
    waba_id TEXT, token TEXT, enabled BOOLEAN DEFAULT true, auto_lead BOOLEAN DEFAULT true, sort INT DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now());`);
  if (!(await q(`SELECT 1 FROM settings WHERE k='wa_perm_v1'`)).rows.length) {   // admin staff & sales get WhatsApp switched on once
    await q(`UPDATE users SET permissions = (SELECT ARRAY(SELECT DISTINCT unnest(permissions || ARRAY['whatsapp']))) WHERE role IN ('Admin','Sales')`);
    await q(`INSERT INTO settings(k,v) VALUES('wa_perm_v1','1') ON CONFLICT (k) DO NOTHING`);
  }
  if (!(await q(`SELECT 1 FROM wa_numbers LIMIT 1`)).rows.length) {   // the first two numbers (Version 14–20 setup) become rows
    const db = await waDb();
    await q(`INSERT INTO wa_numbers(key,purpose,brand_id,phone_id,number,auto_lead,sort) VALUES('sales','sales',$1,$2,$3,$4,1),('service','service',$5,$6,$7,true,2) ON CONFLICT (key) DO NOTHING`,
      [+db.sales_brand_id || null, db.sales_phone_id || null, db.sales_number || null, db.auto_lead !== false, +db.service_brand_id || null, db.service_phone_id || null, db.service_number || null]);
  }
  await waCfg(true);
}
const waNeed = need('whatsapp');
// the thread for a phone on a number (made if missing); links it to a lead / customer with the same number
async function waThread(line, phone, name) {
  const p = waDigits(phone);
  let t = (await q('SELECT * FROM wa_threads WHERE line=$1 AND wa_phone=$2', [line, p])).rows[0];
  if (!t) t = (await q(`INSERT INTO wa_threads(line,wa_phone,name) VALUES($1,$2,$3) ON CONFLICT (line,wa_phone) DO UPDATE SET name=COALESCE(wa_threads.name,EXCLUDED.name) RETURNING *`, [line, p, name || null])).rows[0];
  const l10 = last10(p);
  if (!t.lead_id) { const l = (await q(`SELECT id FROM leads WHERE right(regexp_replace(COALESCE(phone,''),'\\D','','g'),10)=$1 ORDER BY id DESC LIMIT 1`, [l10])).rows[0]; if (l) { await q('UPDATE wa_threads SET lead_id=$2 WHERE id=$1', [t.id, l.id]); t.lead_id = l.id; } }
  if (!t.customer_id) { const c = (await q(`SELECT id FROM customers WHERE right(regexp_replace(COALESCE(phone,''),'\\D','','g'),10)=$1 ORDER BY id DESC LIMIT 1`, [l10])).rows[0]; if (c) { await q('UPDATE wa_threads SET customer_id=$2 WHERE id=$1', [t.id, c.id]); t.customer_id = c.id; } }
  return t;
}
// a chat the user may open (404 / 403 answered here)
async function waTh(req, res) {
  const t = (await q('SELECT * FROM wa_threads WHERE id=$1', [req.params.id])).rows[0]; if (!t) { res.status(404).json({ error: 'Not found' }); return null; }
  const n = (await waCfg()).by[t.line]; if (!waSees(req.user, n)) { res.status(403).json({ error: 'This chat is on another brand’s WhatsApp number' }); return null; }
  t.num = n; return t;
}
const waUsers = async n => (await q(`SELECT id, role, brand_id FROM users WHERE active AND (role=$1 OR 'whatsapp'=ANY(permissions))`, [SUPER])).rows.filter(u => waSees(u, n)).map(r => r.id);
const waText = m => m.type === 'text' ? m.body : m.type === 'image' ? '📷 Photo' + (m.body ? ' · ' + m.body : '') : m.type === 'document' ? '📄 ' + (m.fname || 'Document') : m.type === 'audio' ? '🎤 Voice message'
  : m.type === 'video' ? '🎬 Video' : m.type === 'sticker' ? '🙂 Sticker' : m.type === 'location' ? '📍 Location' : m.type === 'template' ? '📋 ' + (m.body || m.template || 'Template') : m.type === 'reaction' ? (m.body || '👍') : (m.body || 'Message');
// ---------- webhook (Meta calls this) ----------
app.get('/webhook/whatsapp', wrap(async (req, res) => {
  const c = await waCfg(true);
  if (req.query['hub.mode'] === 'subscribe' && c.verify_token && req.query['hub.verify_token'] === c.verify_token) { await waHookLog({ ok: true, why: 'Webhook verified by Meta ✓', fields: ['verify'] }); return res.status(200).send(String(req.query['hub.challenge'] || '')); }
  await waHookLog({ ok: false, why: 'Verify token did not match — copy it again from this setup screen', fields: ['verify'] });
  res.status(403).send('Verify token does not match');
}));
// last webhook calls from Meta (kept in settings so the Super Admin can see what arrives)
const waHookLog = async e => { try { const r = (await q(`SELECT v FROM settings WHERE k='wa_hooks'`)).rows[0]; let a = []; try { a = JSON.parse(r ? r.v : '[]'); } catch (x) {}
  a.unshift({ at: new Date().toISOString(), ...e }); await q(`INSERT INTO settings(k,v) VALUES('wa_hooks',$1) ON CONFLICT (k) DO UPDATE SET v=excluded.v`, [JSON.stringify(a.slice(0, 15))]); } catch (x) { console.error('wa hook log', x.message); } };
app.post('/webhook/whatsapp', wrap(async (req, res) => {
  const c = await waCfg();
  const sum = (() => { const o = { fields: [], phone_ids: [], messages: 0, statuses: 0, from: [] };
    for (const e of (req.body && req.body.entry) || []) for (const ch of e.changes || []) { o.fields.push(ch.field); const v = ch.value || {}; if (v.metadata && v.metadata.phone_number_id) o.phone_ids.push(String(v.metadata.phone_number_id)); o.messages += (v.messages || []).length; o.statuses += (v.statuses || []).length; (v.messages || []).forEach(m => o.from.push('…' + String(m.from || '').slice(-4))); }
    o.fields = [...new Set(o.fields)]; o.phone_ids = [...new Set(o.phone_ids)]; return o; })();
  if (c.app_secret) {   // only accept messages signed by Meta
    const sig = String(req.headers['x-hub-signature-256'] || ''), exp = 'sha256=' + crypto.createHmac('sha256', c.app_secret).update(req.rawBody || Buffer.from('')).digest('hex');
    if (sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) { await waHookLog({ ok: false, why: 'App secret does not match — copy it again from Meta → App settings → Basic', ...sum }); return res.status(401).send('bad signature'); }
  }
  res.sendStatus(200);   // answer Meta at once, then process
  const known = sum.phone_ids.map(id => c.numbers.find(n => n.phone_id === id)).filter(Boolean);
  sum.numbers = known.map(n => n.label + (n.enabled ? '' : ' (switched off)'));
  await waHookLog({ ok: !!known.length || !sum.phone_ids.length, why: !sum.fields.includes('messages') ? 'Not a message event (' + sum.fields.join(', ') + ')' : !known.length && sum.phone_ids.length ? `Phone number ID ${sum.phone_ids.join(', ')} is not added in WhatsApp setup → Numbers` : sum.messages ? 'Message received ✓' : sum.statuses ? 'Delivery / read update ✓' : 'Received', ...sum });
  try { for (const e of (req.body && req.body.entry) || []) for (const ch of e.changes || []) if (ch.field === 'messages') await waIncoming(ch.value || {}); } catch (err) { console.error('wa webhook', err.message); }
}));
async function waIncoming(v) {
  const line = await waLineOf(v.metadata && v.metadata.phone_number_id); if (!line) return;
  const C = await waCfg(), n = C.by[line];
  const names = {}; (v.contacts || []).forEach(x => { names[x.wa_id] = x.profile && x.profile.name; });
  for (const st of v.statuses || []) {   // sent / delivered / read / failed
    const err = st.errors && st.errors[0] ? (st.errors[0].title || '') + (st.errors[0].error_data && st.errors[0].error_data.details ? ' — ' + st.errors[0].error_data.details : '') : null;
    await q(`UPDATE wa_messages SET status=CASE WHEN status='read' AND $2<>'failed' THEN status ELSE $2 END, error=COALESCE($3,error), category=COALESCE(category,$4) WHERE wa_id=$1`, [st.id, st.status, err, st.pricing && st.pricing.category || null]);
  }
  for (const m of v.messages || []) {
    const t = await waThread(line, m.from, names[m.from]);
    if (names[m.from] && !t.name) await q('UPDATE wa_threads SET name=$2 WHERE id=$1', [t.id, names[m.from]]);
    let type = m.type, body = null, media = null, mime = null, fname = null, lat = null, lng = null;
    if (type === 'text') body = m.text && m.text.body;
    else if (['image', 'document', 'audio', 'video', 'sticker'].includes(type)) { const o = m[type] || {}; media = o.id; mime = o.mime_type; body = o.caption || null; fname = o.filename || null; }
    else if (type === 'location') { lat = m.location.latitude; lng = m.location.longitude; body = [m.location.name, m.location.address].filter(Boolean).join(' · ') || null; }
    else if (type === 'button') { type = 'text'; body = m.button && m.button.text; }
    else if (type === 'interactive') { type = 'text'; const i = m.interactive || {}; body = (i.button_reply && i.button_reply.title) || (i.list_reply && i.list_reply.title) || 'Reply'; }
    else if (type === 'reaction') body = (m.reaction && m.reaction.emoji) ? `Reacted ${m.reaction.emoji}` : 'Removed a reaction';
    else if (type === 'contacts') { type = 'text'; body = '👤 ' + ((m.contacts || []).map(x => (x.name && x.name.formatted_name) + ' ' + ((x.phones || [])[0] || {}).phone).join(', ')); }
    else body = 'Unsupported message';
    const ins = (await q(`INSERT INTO wa_messages(thread_id,dir,wa_id,type,body,media_id,mime,fname,lat,lng,status,reply_to,created_at) VALUES($1,'in',$2,$3,$4,$5,$6,$7,$8,$9,'received',$10,to_timestamp($11)) ON CONFLICT (wa_id) DO NOTHING RETURNING id`,
      [t.id, m.id, type, body, media, mime, fname, lat, lng, m.context && m.context.id || null, +m.timestamp || Date.now() / 1000])).rows[0];
    if (!ins) continue;
    await q('UPDATE wa_threads SET last_in_at=now(), last_at=now() WHERE id=$1', [t.id]);
    if (media) waFetchMedia(ins.id, media, n.token).catch(e => console.error('wa media', e.message));
    // a new number on a Sales number becomes a lead of that number's brand
    let isNewLead = false;
    if (n.purpose === 'sales' && n.enabled && n.auto_lead && !t.lead_id) {
      const brand = n.brand_id || (await q(`SELECT id FROM brands ORDER BY (lower(name)='heaven') DESC, id LIMIT 1`)).rows[0].id;
      const l = (await q(`INSERT INTO leads(name,phone,source,stage,priority,brand_id,notes) VALUES($1,$2,'WhatsApp','New Enquiry','Warm',$3,$4) RETURNING id`,
        [names[m.from] || ('WhatsApp ' + last10(m.from)), '+' + waDigits(m.from), brand, body ? 'First message: ' + String(body).slice(0, 300) : null])).rows[0];
      await q('UPDATE wa_threads SET lead_id=$2 WHERE id=$1', [t.id, l.id]); t.lead_id = l.id; isNewLead = true;
      await q(`INSERT INTO lead_activity(lead_id,by_name,text) VALUES($1,'WhatsApp',$2)`, [l.id, `New lead from WhatsApp (${n.label} number)`]).catch(() => {});
    }
    if (!n.enabled) continue;   // switched-off number: message kept, nobody disturbed
    const who = names[m.from] || t.name || '+' + waDigits(m.from), pv = waText({ type, body, fname }).slice(0, 120);
    for (const id of await waUsers(n)) {
      if (isNewLead) await q('INSERT INTO notifications(user_id,title,body,link) VALUES($1,$2,$3,$4)', [id, '🟢 New WhatsApp lead · ' + n.label, `${who}: ${pv}`, 'wa:' + t.id]);
      pushTo(id, `🟢 ${who} · WhatsApp ${n.label}`, pv, null, { url: '/?att=wa:' + t.id, att: 'wa:' + t.id, tag: 'rago-wa-' + t.id }).catch(() => {});
    }
  }
}
async function waFetchMedia(msgId, mediaId, token) {
  const info = await graph('/' + mediaId, { token }), c = await waCfg();
  const r = await fetch(info.url, { headers: { Authorization: 'Bearer ' + (token || c.token) } });
  if (!r.ok) throw new Error('media download ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 25 * 1024 * 1024) return;
  await q('UPDATE wa_messages SET data=$2, mime=COALESCE(mime,$3) WHERE id=$1', [msgId, buf, info.mime_type || null]);
  return buf;
}
// ---------- inbox for staff ----------
const WA_MCOLS = `id, thread_id, dir, wa_id, type, body, mime, fname, lat, lng, status, error, category, template, sent_by_name, reply_to, created_at, (data IS NOT NULL OR media_id IS NOT NULL) has_media, length(data) size`;
const waOpen = t => !!(t.last_in_at && Date.now() - new Date(t.last_in_at) < 24 * 3600 * 1000);
const waPub = n => ({ line: n.key, label: n.label, brand: n.brand, brand_id: n.brand_id, purpose: n.purpose, number: n.number, ready: waReady(n), enabled: n.enabled });
app.get('/api/wa/status', waNeed, wrap(async (req, res) => {
  const c = await waCfg(), mine = await waMine(req.user);
  res.json({ connected: !!c.token || c.numbers.some(n => n.own_token), lines: mine.map(waPub), templates: !!c.waba_id || mine.some(n => n.waba_id) });
}));
app.get('/api/wa/threads', waNeed, wrap(async (req, res) => {
  const keys = (await waMine(req.user)).map(n => n.key);
  if (!keys.length) return res.set('Cache-Control', 'no-store').json({ unread: {}, items: [] });
  const p = [req.user.id, keys], w = [`t.line = ANY($2::text[])`];
  if (req.query.line && keys.includes(String(req.query.line))) { p.push(String(req.query.line)); w.push(`t.line=$${p.length}`); }
  if (req.query.q) { p.push('%' + String(req.query.q).slice(0, 60) + '%'); w.push(`(t.name ILIKE $${p.length} OR t.wa_phone ILIKE $${p.length} OR l.name ILIKE $${p.length} OR c.name ILIKE $${p.length} OR c.company ILIKE $${p.length} OR l.company ILIKE $${p.length})`); }
  const rows = (await q(`SELECT t.*, l.name lead_name, l.company lead_company, l.stage lead_stage, c.name cust_name, c.company cust_company,
      (SELECT COUNT(*)::int FROM wa_messages m WHERE m.thread_id=t.id AND m.dir='in' AND m.id>COALESCE(r.last_read,0)) unread,
      (SELECT row_to_json(x) FROM (SELECT dir, type, body, fname, template, status, created_at FROM wa_messages m WHERE m.thread_id=t.id ORDER BY m.id DESC LIMIT 1) x) last
    FROM wa_threads t LEFT JOIN leads l ON l.id=t.lead_id LEFT JOIN customers c ON c.id=t.customer_id LEFT JOIN wa_reads r ON r.thread_id=t.id AND r.user_id=$1
    WHERE ${w.join(' AND ')} ORDER BY t.last_at DESC LIMIT 300`, p)).rows;
  const counts = (await q(`SELECT t.line, COUNT(*)::int n FROM wa_threads t JOIN wa_messages m ON m.thread_id=t.id AND m.dir='in' LEFT JOIN wa_reads r ON r.thread_id=t.id AND r.user_id=$1 WHERE m.id>COALESCE(r.last_read,0) AND t.line = ANY($2::text[]) GROUP BY t.line`, [req.user.id, keys])).rows;
  const un = {}; counts.forEach(x => { un[x.line] = x.n; });
  res.set('Cache-Control', 'no-store').json({ unread: un, items: rows.map(t => ({ ...t, open: waOpen(t), title: t.lead_name || t.cust_name || t.name || '+' + t.wa_phone, preview: t.last ? (t.last.dir === 'out' ? 'You: ' : '') + waText(t.last) : '' })) });
}));
const waThreadFor = async id => (await q(`SELECT t.*, l.name lead_name, l.company lead_company, l.stage lead_stage, c.name cust_name, c.company cust_company FROM wa_threads t LEFT JOIN leads l ON l.id=t.lead_id LEFT JOIN customers c ON c.id=t.customer_id WHERE t.id=$1`, [id])).rows[0];
app.get('/api/wa/threads/:id', waNeed, wrap(async (req, res) => {
  const g = await waTh(req, res); if (!g) return; const t = await waThreadFor(g.id), n = g.num;
  const after = +req.query.after || 0, before = +req.query.before || 0;
  const items = after ? (await q(`SELECT ${WA_MCOLS} FROM wa_messages WHERE thread_id=$1 AND id>$2 ORDER BY id`, [t.id, after])).rows
    : (await q(`SELECT * FROM (SELECT ${WA_MCOLS} FROM wa_messages WHERE thread_id=$1 ${before ? 'AND id<$2' : ''} ORDER BY id DESC LIMIT 80) x ORDER BY id`, before ? [t.id, before] : [t.id])).rows;
  // status ticks change after sending: give the latest statuses of the last 40 outgoing messages
  const st = after ? (await q(`SELECT id, status, error FROM wa_messages WHERE thread_id=$1 AND dir='out' ORDER BY id DESC LIMIT 40`, [t.id])).rows : [];
  res.set('Cache-Control', 'no-store').json({ thread: { ...t, open: waOpen(t), title: t.lead_name || t.cust_name || t.name || '+' + t.wa_phone, number: n.number, label: n.label, purpose: n.purpose, brand: n.brand, enabled: n.enabled, ready: waReady(n) && n.enabled }, items, statuses: st, more: !after && items.length === 80 });
}));
app.post('/api/wa/threads/:id/read', waNeed, wrap(async (req, res) => {
  const t = await waTh(req, res); if (!t) return; const n = t.num;
  const last = (await q(`SELECT MAX(id) n FROM wa_messages WHERE thread_id=$1`, [t.id])).rows[0].n || 0;
  await q(`INSERT INTO wa_reads(thread_id,user_id,last_read) VALUES($1,$2,$3) ON CONFLICT (thread_id,user_id) DO UPDATE SET last_read=GREATEST(wa_reads.last_read,$3)`, [t.id, req.user.id, last]);
  // blue ticks for the customer on their latest message
  const lastIn = (await q(`SELECT wa_id FROM wa_messages WHERE thread_id=$1 AND dir='in' ORDER BY id DESC LIMIT 1`, [t.id])).rows[0];
  if (lastIn && waReady(n) && req.body && req.body.seen !== false) graph(`/${n.phone_id}/messages`, { method: 'POST', token: n.token, json: { messaging_product: 'whatsapp', status: 'read', message_id: lastIn.wa_id } }).catch(() => {});
  res.json({ ok: true, unread: await waUnread(req.user) });
}));
const waUnread = async u => { const keys = (await waMine(u)).map(n => n.key); if (!keys.length) return 0;
  return (await q(`SELECT COUNT(*)::int n FROM wa_messages m JOIN wa_threads t ON t.id=m.thread_id LEFT JOIN wa_reads r ON r.thread_id=t.id AND r.user_id=$1 WHERE m.dir='in' AND m.id>COALESCE(r.last_read,0) AND t.line = ANY($2::text[])`, [u.id, keys])).rows[0].n; };
// open (or make) a chat for a lead / customer / ticket / phone. Picks the number of the same brand and purpose
// (lead → Sales, ticket / customer → Service); when more than one could fit, answers { choose } so the app asks.
app.post('/api/wa/open', waNeed, wrap(async (req, res) => {
  const b = req.body || {}; let phone = b.phone, name = b.name, lead = null, cust = null, brand = +b.brand_id || null, purpose = ['sales', 'service'].includes(b.purpose) ? b.purpose : null;
  if (b.lead_id) { const l = (await q('SELECT id, name, phone, brand_id FROM leads WHERE id=$1', [b.lead_id])).rows[0]; if (!l) return res.status(404).json({ error: 'Lead not found' }); phone = l.phone; name = l.name; lead = l.id; brand = brand || l.brand_id; purpose = purpose || 'sales'; }
  if (b.service_id) { const s = (await q('SELECT c.id, c.name, c.phone, s.brand_id FROM services s JOIN customers c ON c.id=s.customer_id WHERE s.id=$1', [b.service_id])).rows[0]; if (!s) return res.status(404).json({ error: 'Ticket not found' }); phone = s.phone; name = s.name; cust = s.id; brand = brand || s.brand_id; purpose = purpose || 'service'; }
  if (b.customer_id) { const c2 = (await q('SELECT id, name, phone, brand_id FROM customers WHERE id=$1', [b.customer_id])).rows[0]; if (!c2) return res.status(404).json({ error: 'Customer not found' }); phone = phone || c2.phone; name = name || c2.name; cust = c2.id; brand = brand || c2.brand_id; purpose = purpose || 'service'; }
  if (waDigits(phone).length < 11) return res.status(400).json({ error: 'This contact has no valid mobile number' });
  const c = await waCfg(), mine = c.numbers.filter(n => waSees(req.user, n) && n.enabled);
  let num = null;
  if (b.line) { num = c.by[b.line]; if (!num || !mine.includes(num)) return res.status(403).json({ error: 'You can’t use this WhatsApp number' }); }
  else {
    if (!mine.length) return res.status(400).json({ error: 'No WhatsApp number is switched on for you — ask the Super Admin' });
    const score = n => (purpose && n.purpose === purpose ? 3 : 0) + (brand && n.brand_id === brand ? 2 : !n.brand_id ? 1 : brand ? -10 : 0);
    const ranked = mine.map(n => ({ n, s: score(n) })).sort((x, y) => y.s - x.s), top = ranked[0].s, best = ranked.filter(x => x.s === top);
    if (mine.length === 1 || (best.length === 1 && top >= 3 && !b.ask)) num = best[0].n;
    else return res.json({ choose: ranked.map(x => ({ ...waPub(x.n), best: x.s === top && top > 0 })) });
  }
  const t = await waThread(num.key, phone, name);
  if (lead && !t.lead_id) await q('UPDATE wa_threads SET lead_id=$2 WHERE id=$1', [t.id, lead]);
  if (cust && !t.customer_id) await q('UPDATE wa_threads SET customer_id=$2 WHERE id=$1', [t.id, cust]);
  res.json({ id: t.id, line: num.key, label: num.label });
}));
app.patch('/api/wa/threads/:id', waNeed, wrap(async (req, res) => {   // link to a lead / customer, rename
  const t = await waTh(req, res); if (!t) return;
  const b = req.body || {};
  if (b.lead_id !== undefined) await q('UPDATE wa_threads SET lead_id=$2 WHERE id=$1', [t.id, +b.lead_id || null]);
  if (b.customer_id !== undefined) await q('UPDATE wa_threads SET customer_id=$2 WHERE id=$1', [t.id, +b.customer_id || null]);
  if (b.name !== undefined) await q('UPDATE wa_threads SET name=$2 WHERE id=$1', [t.id, String(b.name || '').trim().slice(0, 80) || null]);
  res.json({ ok: true });
}));
// make a lead from a chat
app.post('/api/wa/threads/:id/lead', waNeed, need('leads'), wrap(async (req, res) => {
  const t = await waTh(req, res); if (!t) return;
  if (t.lead_id) return res.json({ id: t.lead_id });
  const brand = req.user.brand_id || t.num.brand_id || (await q(`SELECT id FROM brands ORDER BY (lower(name)='heaven') DESC, id LIMIT 1`)).rows[0].id;
  const l = (await q(`INSERT INTO leads(name,phone,source,stage,priority,brand_id,created_by,assigned_to) VALUES($1,$2,'WhatsApp','New Enquiry','Warm',$3,$4,$4) RETURNING id`, [t.name || ('WhatsApp ' + last10(t.wa_phone)), '+' + t.wa_phone, brand, req.user.id])).rows[0];
  await q('UPDATE wa_threads SET lead_id=$2 WHERE id=$1', [t.id, l.id]); res.json({ id: l.id });
}));
// send: text, file (photo / document / voice) or an approved template
async function waUpload(n, buf, mime, fname) {
  const fd = new FormData(); fd.append('messaging_product', 'whatsapp'); fd.append('type', mime); fd.append('file', new Blob([buf], { type: mime }), fname || 'file');
  return (await graph(`/${n.phone_id}/media`, { method: 'POST', body: fd, token: n.token })).id;
}
// Chrome records voice as WebM — WhatsApp needs OGG/Opus, so convert (ffmpeg comes with the app)
function toOgg(buf) {
  return new Promise((ok, no) => {
    let ff; try { ff = require('ffmpeg-static'); } catch (e) { return no(new Error('no ffmpeg')); }
    const p = require('child_process').spawn(ff, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-c:a', 'libopus', '-b:a', '32k', '-ac', '1', '-ar', '48000', '-f', 'ogg', 'pipe:1']);
    const out = []; p.stdout.on('data', d => out.push(d)); p.on('error', no); p.on('close', code => code === 0 && out.length ? ok(Buffer.concat(out)) : no(new Error('convert failed')));
    p.stdin.on('error', () => {}); p.stdin.end(buf);
  });
}
app.post('/api/wa/threads/:id/send', waNeed, wrap(async (req, res) => {
  const t = await waTh(req, res); if (!t) return; const n = t.num;
  if (!n.enabled) return res.status(400).json({ error: `The ${n.label} number is switched off — Super Admin: WhatsApp setup → Numbers` });
  if (!waReady(n)) return res.status(400).json({ error: `The ${n.label} number is not connected yet — Super Admin: Profile → WhatsApp setup` });
  const b = req.body || {}; let payload, row = { type: 'text', body: null, mime: null, fname: null, data: null, template: null, category: null };
  try {
    if (b.template) {
      const tp = b.template, params = Array.isArray(tp.params) ? tp.params.map(x => String(x || '').slice(0, 900)) : [];
      if (!tp.name) return res.status(400).json({ error: 'Choose a template' });
      if (params.some(x => !x.trim())) return res.status(400).json({ error: 'Fill in every blank in the template' });
      payload = { type: 'template', template: { name: tp.name, language: { code: tp.lang || 'en' }, ...(params.length ? { components: [{ type: 'body', parameters: params.map(x => ({ type: 'text', text: x })) }] } : {}) } };
      row = { ...row, type: 'template', template: tp.name, body: String(tp.preview || tp.name).slice(0, 2000), category: String(tp.category || '').toLowerCase() || null };
    } else {
      if (!waOpen(t)) return res.status(400).json({ error: 'More than 24 hours since the customer’s last message — send a template instead', need_template: true });
      if (b.file) {
        const m = /^data:([\w.+-]+\/[\w.+-]+)?(?:;[\w=.+-]+)*;base64,([A-Za-z0-9+/=]*)$/.exec(String(b.file)); if (!m) return res.status(400).json({ error: 'Choose a file' });
        let buf = Buffer.from(m[2], 'base64'), mime = (m[1] || 'application/octet-stream').toLowerCase(), fname = String(b.fname || 'file').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 120);
        if (buf.length > 16 * 1024 * 1024) return res.status(400).json({ error: 'File is too large for WhatsApp (max 16 MB)' });
        let kind = /^image\/(jpeg|png)$/.test(mime) ? 'image' : /^audio\//.test(mime) || b.voice ? 'audio' : /^video\/(mp4|3gpp)$/.test(mime) ? 'video' : 'document';
        if (kind === 'audio' && !/ogg|mpeg|mp4|aac|amr/.test(mime)) { try { buf = await toOgg(buf); mime = 'audio/ogg'; fname = 'voice.ogg'; } catch (e) { kind = 'document'; } }
        if (kind === 'audio' && /ogg/.test(mime)) mime = 'audio/ogg';
        const mid = await waUpload(n, buf, mime.split(';')[0], fname);
        payload = { type: kind, [kind]: { id: mid, ...(kind === 'document' ? { filename: fname } : {}), ...(b.text && kind !== 'audio' ? { caption: String(b.text).slice(0, 1000) } : {}) } };
        row = { ...row, type: kind, body: b.text || null, mime: mime.split(';')[0], fname, data: buf };
      } else {
        const text = String(b.text || '').trim(); if (!text) return res.status(400).json({ error: 'Type a message' });
        payload = { type: 'text', text: { body: text.slice(0, 4096), preview_url: /https?:\/\//.test(text) } };
        row = { ...row, body: text };
      }
    }
    if (b.reply_to) { const rt = (await q('SELECT wa_id FROM wa_messages WHERE id=$1 AND thread_id=$2', [b.reply_to, t.id])).rows[0]; if (rt && rt.wa_id) payload.context = { message_id: rt.wa_id }; }
    const r = await graph(`/${n.phone_id}/messages`, { method: 'POST', token: n.token, json: { messaging_product: 'whatsapp', recipient_type: 'individual', to: t.wa_phone, ...payload } });
    const wid = r.messages && r.messages[0] && r.messages[0].id;
    const ins = (await q(`INSERT INTO wa_messages(thread_id,dir,wa_id,type,body,mime,fname,data,status,category,template,sent_by,sent_by_name,reply_to) VALUES($1,'out',$2,$3,$4,$5,$6,$7,'sent',$8,$9,$10,$11,$12) RETURNING id`,
      [t.id, wid || null, row.type, row.body, row.mime, row.fname, row.data, row.category || (b.template ? null : 'service'), row.template, req.user.id, req.user.name, payload.context ? payload.context.message_id : null])).rows[0];
    await q('UPDATE wa_threads SET last_at=now() WHERE id=$1', [t.id]);
    if (t.lead_id) { await q(`UPDATE leads SET last_contact=now(), updated_at=now() WHERE id=$1`, [t.lead_id]).catch(() => {}); if (b.template) await q(`INSERT INTO lead_activity(lead_id,by_name,text) VALUES($1,$2,$3)`, [t.lead_id, req.user.name, `📋 WhatsApp template sent: ${row.template}`]).catch(() => {}); }
    res.json({ ok: true, id: ins.id });
  } catch (e) { res.status(400).json({ error: e.message, need_template: /24 hours/.test(e.message) }); }
}));
app.get('/api/wa/media/:id', waNeed, wrap(async (req, res) => {
  let m = (await q('SELECT m.id, m.data, m.mime, m.media_id, m.fname, m.type, t.line FROM wa_messages m JOIN wa_threads t ON t.id=m.thread_id WHERE m.id=$1', [req.params.id])).rows[0];
  if (!m) return res.status(404).end();
  const n = (await waCfg()).by[m.line]; if (!waSees(req.user, n)) return res.status(403).end();
  let buf = m.data;
  if (!buf && m.media_id) { try { buf = await waFetchMedia(m.id, m.media_id, n.token); } catch (e) { return res.status(404).end(); } }
  if (!buf) return res.status(404).end();
  const total = buf.length, range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  res.set({ 'Content-Type': m.mime || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=604800', 'X-Content-Type-Options': 'nosniff' });
  if (m.type === 'document' || req.query.dl) res.set('Content-Disposition', `${req.query.dl ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(m.fname || 'file')}`);
  if (range) { const s = range[1] ? +range[1] : 0, e = range[2] ? Math.min(+range[2], total - 1) : total - 1; return res.status(206).set('Content-Range', `bytes ${s}-${e}/${total}`).send(buf.subarray(s, e + 1)); }
  res.send(buf);
}));
// ---------- templates (each WhatsApp Business Account has its own; cached 10 minutes) ----------
const WA_TPL = {};
const waTplOf = async (waba, token, fresh) => {
  const k = waba, c = WA_TPL[k];
  if (c && !fresh && Date.now() - c.at < 600000) return c.items;
  const r = await graph(`/${waba}/message_templates?fields=name,language,status,category,components,rejected_reason&limit=200`, { token });
  const items = (r.data || []).map(x => {
    const body = (x.components || []).find(k2 => k2.type === 'BODY') || {}, head = (x.components || []).find(k2 => k2.type === 'HEADER') || {};
    return { name: x.name, lang: x.language, status: x.status, reason: x.rejected_reason && x.rejected_reason !== 'NONE' ? x.rejected_reason : null, category: x.category, text: body.text || '', header: head.format === 'TEXT' ? head.text : head.format ? '[' + head.format.toLowerCase() + ']' : '', params: ((body.text || '').match(/\{\{\d+\}\}/g) || []).length, media_header: !!(head.format && head.format !== 'TEXT') };
  });
  WA_TPL[k] = { at: Date.now(), items }; return items;
};
// templates named after another brand (e.g. gmedia_… on a Heaven number) are hidden
const waBrandTpl = async (items, n) => {
  if (!n || !n.brand_id) return items;
  const others = (await q('SELECT id, name FROM brands')).rows.filter(b => b.id !== n.brand_id).map(b => waSlug(b.name)).filter(Boolean), mine = waSlug(n.brand);
  return items.filter(t => !others.some(s => s !== mine && t.name.startsWith(s + '_')));
};
const waTplTarget = async (req, line) => {   // → { waba, token, n }
  const c = await waCfg();
  if (line) { const n = c.by[line]; if (!waSees(req.user, n)) return { error: 'You can’t use this WhatsApp number' }; return { waba: n.waba_id, token: n.token, n }; }
  return { waba: c.waba_id, token: c.token, n: null };
};
app.get('/api/wa/templates', waNeed, wrap(async (req, res) => {
  const tg = await waTplTarget(req, req.query.line); if (tg.error) return res.status(403).json(tg);
  if (!tg.waba) return res.json({ items: [], error: 'Add the WhatsApp Business Account ID in WhatsApp setup to use templates' });
  try {
    let items = await waTplOf(tg.waba, tg.token, !!req.query.fresh);
    if (!(req.query.all && isSuper(req.user))) items = await waBrandTpl(items.filter(x => x.status === 'APPROVED'), tg.n);
    res.json({ items, waba: isSuper(req.user) ? tg.waba : undefined });
  } catch (e) { res.json({ items: [], error: e.message }); }
}));
// Super Admin: create a template from the CRM (Meta reviews it, usually within minutes to a day)
app.post('/api/wa/templates', superOnly, wrap(async (req, res) => {
  const b = req.body || {}, tg = await waTplTarget(req, b.line); if (tg.error) return res.status(403).json(tg);
  if (!tg.waba) return res.status(400).json({ error: 'Add the WhatsApp Business Account ID first' });
  const name = String(b.name || '').trim().toLowerCase(), body = String(b.body || '').trim(), cat = String(b.category || 'UTILITY').toUpperCase(), lang = String(b.lang || 'en').trim();
  if (!/^[a-z0-9_]{3,100}$/.test(name)) return res.status(400).json({ error: 'Name: small letters, numbers and _ only (e.g. heaven_service_update)' });
  if (!['UTILITY', 'MARKETING'].includes(cat)) return res.status(400).json({ error: 'Choose Utility or Marketing' });
  if (!body || body.length > 1024) return res.status(400).json({ error: 'Write the message (up to 1024 letters)' });
  const vars = (body.match(/\{\{(\d+)\}\}/g) || []).map(v => +v.replace(/\D/g, ''));
  if (vars.some((v, i) => v !== i + 1)) return res.status(400).json({ error: 'Blanks must be numbered in order: {{1}}, {{2}}, {{3}}…' });
  if (/^\s*\{\{\d+\}\}/.test(body) || /\{\{\d+\}\}[\s.!]*$/.test(body)) return res.status(400).json({ error: 'Meta does not allow a blank at the very start or end — add a word before / after it' });
  if (/\{\{\d+\}\}\s*\{\{\d+\}\}/.test(body)) return res.status(400).json({ error: 'Put a word between two blanks' });
  const ex = (Array.isArray(b.examples) ? b.examples : []).map(x => String(x || '').trim().slice(0, 200));
  if (vars.length && (ex.length < vars.length || ex.slice(0, vars.length).some(x => !x))) return res.status(400).json({ error: 'Give an example for every blank — Meta needs it to approve' });
  const comps = [];
  if (b.header) comps.push({ type: 'HEADER', format: 'TEXT', text: String(b.header).trim().slice(0, 60) });
  comps.push({ type: 'BODY', text: body, ...(vars.length ? { example: { body_text: [ex.slice(0, vars.length)] } } : {}) });
  if (b.footer) comps.push({ type: 'FOOTER', text: String(b.footer).trim().slice(0, 60) });
  try {
    const r = await graph(`/${tg.waba}/message_templates`, { method: 'POST', token: tg.token, json: { name, language: lang, category: cat, components: comps } });
    delete WA_TPL[tg.waba]; res.json({ ok: true, id: r.id, status: r.status || 'PENDING', category: r.category || cat });
  } catch (e) { res.status(400).json({ error: e.message }); }
}));
// this month: messages sent and an estimate of Meta's bill, per number
app.get('/api/wa/usage', waNeed, wrap(async (req, res) => {
  const m = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : (await todayIST()).slice(0, 7), mine = await waMine(req.user);
  const rows = (await q(`SELECT t.line, COALESCE(m.category,'service') cat, COUNT(*)::int n FROM wa_messages m JOIN wa_threads t ON t.id=m.thread_id
    WHERE m.dir='out' AND m.status<>'failed' AND to_char(m.created_at AT TIME ZONE '${TZ}','YYYY-MM')=$1 GROUP BY 1,2`, [m])).rows;
  const inN = (await q(`SELECT t.line, COUNT(*)::int n FROM wa_messages m JOIN wa_threads t ON t.id=m.thread_id WHERE m.dir='in' AND to_char(m.created_at AT TIME ZONE '${TZ}','YYYY-MM')=$1 GROUP BY 1`, [m])).rows;
  const out = mine.map(n => {
    const l = n.key, g = k => (rows.find(r => r.line === l && r.cat === k) || {}).n || 0, svc = g('service') + g('free_customer_service'), mk = g('marketing'), ut = g('utility'), au = g('authentication');
    const cost = Math.max(0, svc - WA_RATES.free) * WA_RATES.service + mk * WA_RATES.marketing + ut * WA_RATES.utility + au * WA_RATES.authentication;
    return { line: l, label: n.label, purpose: n.purpose, received: (inN.find(r => r.line === l) || {}).n || 0, replies: svc, free_left: Math.max(0, WA_RATES.free - svc), marketing: mk, utility: ut + au, cost: Math.round(cost * 100) / 100, with_gst: Math.round(cost * (1 + WA_RATES.gst) * 100) / 100 };
  });
  res.json({ month: m, rates: WA_RATES, lines: out, total: Math.round(out.reduce((t, x) => t + x.with_gst, 0) * 100) / 100 });
}));
// ---------- setup (Super Admin) ----------
const mask = v => v ? '••••' + String(v).slice(-4) : '';
const waNumOut = async () => { const c = await waCfg(true), th = {}; (await q(`SELECT line, COUNT(*)::int n FROM wa_threads GROUP BY 1`)).rows.forEach(r => { th[r.line] = r.n; });
  return c.numbers.map(n => ({ id: n.id, key: n.key, label: n.name, title: n.label, purpose: n.purpose, brand_id: n.brand_id, brand: n.brand, phone_id: n.phone_id, number: n.number, waba_id: n.own_waba ? n.waba_id : '', token: n.own_token ? mask(n.token) : '', enabled: n.enabled, auto_lead: n.auto_lead, env_phone: n.env_phone, ready: waReady(n), chats: th[n.key] || 0 })); };
app.get('/api/wa/settings', superOnly, wrap(async (req, res) => {
  const c = await waCfg(true), db = await waDb();
  if (!c.verify_token) { db.verify_token = crypto.randomBytes(12).toString('hex'); await q(`INSERT INTO settings(k,v) VALUES('wa_cfg',$1) ON CONFLICT (k) DO UPDATE SET v=$1`, [JSON.stringify(db)]); }
  const C = await waCfg(true), S = C.by.sales || {}, V = C.by.service || {};
  res.json({ token: mask(C.token), app_secret: mask(C.app_secret), verify_token: C.verify_token, waba_id: C.waba_id, from_env: C.from_env, numbers: await waNumOut(),
    sales_phone_id: S.phone_id || '', service_phone_id: V.phone_id || '', sales_number: S.number || '', service_number: V.number || '', sales_brand_id: S.brand_id || null, service_brand_id: V.brand_id || null, auto_lead: S.auto_lead !== false });
}));
app.get('/api/wa/hooks', superOnly, wrap(async (req, res) => { let a = []; try { a = JSON.parse(((await q(`SELECT v FROM settings WHERE k='wa_hooks'`)).rows[0] || {}).v || '[]'); } catch (e) {} res.json(a); }));
app.put('/api/wa/settings', superOnly, wrap(async (req, res) => {
  const db = await waDb(), b = req.body || {}, str = (k, max = 600) => { if (b[k] !== undefined && !/^••••/.test(String(b[k]))) db[k] = String(b[k] || '').trim().slice(0, max); };
  ['token', 'app_secret'].forEach(k => str(k, 1200)); ['verify_token', 'waba_id'].forEach(k => str(k, 80));
  await q(`INSERT INTO settings(k,v) VALUES('wa_cfg',$1) ON CONFLICT (k) DO UPDATE SET v=$1`, [JSON.stringify(db)]);
  // older screens / scripts still send the two fixed numbers
  for (const key of ['sales', 'service']) {
    const set = {}; if (b[key + '_phone_id'] !== undefined) set.phone_id = String(b[key + '_phone_id'] || '').trim().slice(0, 40) || null; if (b[key + '_number'] !== undefined) set.number = String(b[key + '_number'] || '').trim().slice(0, 40) || null;
    if (b[key + '_brand_id'] !== undefined) set.brand_id = +b[key + '_brand_id'] || null; if (key === 'sales' && b.auto_lead !== undefined) set.auto_lead = !!b.auto_lead;
    if (!Object.keys(set).length) continue;
    await q(`INSERT INTO wa_numbers(key,purpose,sort) VALUES($1,$1,$2) ON CONFLICT (key) DO NOTHING`, [key, key === 'sales' ? 1 : 2]);
    const ks = Object.keys(set); await q(`UPDATE wa_numbers SET ${ks.map((k, i) => `${k}=$${i + 2}`).join(', ')} WHERE key=$1`, [key, ...ks.map(k => set[k])]);
  }
  await waCfg(true); Object.keys(WA_TPL).forEach(k => delete WA_TPL[k]);
  res.json({ ok: true });
}));
// numbers: add / change / switch on-off / remove
const waNumBody = async (b, old) => {
  const o = {}, s = (k, max) => { if (b[k] !== undefined) o[k] = String(b[k] || '').trim().slice(0, max) || null; };
  s('label', 60); s('number', 40); s('waba_id', 40); if (b.phone_id !== undefined) o.phone_id = String(b.phone_id || '').replace(/\D/g, '').slice(0, 30) || null;
  if (b.token !== undefined && !/^••••/.test(String(b.token))) o.token = String(b.token || '').trim().slice(0, 1200) || null;
  if (b.purpose !== undefined) o.purpose = b.purpose === 'service' ? 'service' : 'sales';
  if (b.brand_id !== undefined) o.brand_id = +b.brand_id || null;
  for (const k of ['enabled', 'auto_lead']) if (b[k] !== undefined) o[k] = !!b[k];
  if (o.waba_id && !/^\d+$/.test(o.waba_id) && !/^W\d+$/.test(o.waba_id)) return { error: 'WhatsApp Business Account ID is a number' };
  if (o.phone_id) { const d = (await q('SELECT label, key FROM wa_numbers WHERE phone_id=$1 AND id<>$2', [o.phone_id, old ? old.id : 0])).rows[0]; if (d) return { error: 'This Phone number ID is already added' }; }
  if (o.brand_id && !(await q('SELECT 1 FROM brands WHERE id=$1', [o.brand_id])).rows.length) return { error: 'Brand not found' };
  return o;
};
app.post('/api/wa/numbers', superOnly, wrap(async (req, res) => {
  const o = await waNumBody(req.body || {}); if (o.error) return res.status(400).json(o);
  if (!o.phone_id) return res.status(400).json({ error: 'Enter the Phone number ID from Meta (WhatsApp Manager → Phone numbers)' });
  const sort = (await q('SELECT COALESCE(MAX(sort),0)+1 n FROM wa_numbers')).rows[0].n, ks = Object.keys(o);
  const r = (await q(`INSERT INTO wa_numbers(key,sort,${ks.join(',')}) VALUES('new-'||md5(random()::text),$1,${ks.map((k, i) => '$' + (i + 2)).join(',')}) RETURNING id`, [sort, ...ks.map(k => o[k])])).rows[0];
  await q(`UPDATE wa_numbers SET key='n'||id WHERE id=$1`, [r.id]); await waCfg(true);
  res.json({ ok: true, id: r.id, key: 'n' + r.id });
}));
app.patch('/api/wa/numbers/:id', superOnly, wrap(async (req, res) => {
  const old = (await q('SELECT * FROM wa_numbers WHERE id=$1', [req.params.id])).rows[0]; if (!old) return res.status(404).json({ error: 'Not found' });
  const o = await waNumBody(req.body || {}, old); if (o.error) return res.status(400).json(o);
  const ks = Object.keys(o); if (ks.length) await q(`UPDATE wa_numbers SET ${ks.map((k, i) => `${k}=$${i + 2}`).join(', ')} WHERE id=$1`, [old.id, ...ks.map(k => o[k])]);
  await waCfg(true); Object.keys(WA_TPL).forEach(k => delete WA_TPL[k]); res.json({ ok: true });
}));
app.delete('/api/wa/numbers/:id', superOnly, wrap(async (req, res) => {
  const old = (await q('SELECT * FROM wa_numbers WHERE id=$1', [req.params.id])).rows[0]; if (!old) return res.status(404).json({ error: 'Not found' });
  const n = (await q('SELECT COUNT(*)::int n FROM wa_threads WHERE line=$1', [old.key])).rows[0].n;
  if (n) return res.status(400).json({ error: `This number has ${n} chat${n > 1 ? 's' : ''} — switch it off instead, so the history stays` });
  await q('DELETE FROM wa_numbers WHERE id=$1', [old.id]); await waCfg(true); res.json({ ok: true });
}));
app.post('/api/wa/test', superOnly, wrap(async (req, res) => {   // check every number and account with Meta
  const c = await waCfg(true), out = { wabas: [] };
  for (const n of c.numbers) {
    if (!n.phone_id) { out[n.key] = { ok: false, label: n.label, enabled: n.enabled, error: 'Phone number ID missing' }; continue; }
    try { const r = await graph(`/${n.phone_id}?fields=display_phone_number,verified_name,quality_rating,code_verification_status,name_status`, { token: n.token }); out[n.key] = { ok: true, label: n.label, enabled: n.enabled, ...r }; }
    catch (e) { out[n.key] = { ok: false, label: n.label, enabled: n.enabled, error: e.message }; }
  }
  // every WhatsApp account must be subscribed to this app, or Meta sends it no messages — fixed automatically
  const accts = []; const add = (waba, token, label) => { if (!waba) return; let a = accts.find(x => x.waba === waba); if (!a) accts.push(a = { waba, token, numbers: [] }); if (label) a.numbers.push(label); };
  add(c.waba_id, c.token); c.numbers.forEach(n => add(n.waba_id, n.token, n.label));
  for (const a of accts) {
    const o = { waba: a.waba, numbers: a.numbers };
    try { let r = await graph(`/${a.waba}/subscribed_apps`, { token: a.token }); let apps = (r.data || []).map(x => (x.whatsapp_business_api_data || x).name || x.id).filter(Boolean);
      if (!(r.data || []).length) { await graph(`/${a.waba}/subscribed_apps`, { method: 'POST', token: a.token }); r = await graph(`/${a.waba}/subscribed_apps`, { token: a.token }); apps = (r.data || []).map(x => (x.whatsapp_business_api_data || x).name || x.id).filter(Boolean); o.subscribed = { ok: (r.data || []).length > 0, fixed: true, apps }; }
      else o.subscribed = { ok: true, apps }; }
    catch (e) { o.subscribed = { ok: false, error: e.message }; }
    try { const r = await graph(`/${a.waba}/message_templates?fields=name,status&limit=200`, { token: a.token }); o.templates = { ok: true, approved: (r.data || []).filter(x => x.status === 'APPROVED').length, total: (r.data || []).length }; } catch (e) { o.templates = { ok: false, error: e.message }; }
    out.wabas.push(o);
  }
  if (out.wabas[0]) { out.subscribed = out.wabas[0].subscribed; out.templates = out.wabas[0].templates; }
  res.json(out);
}));

// ---------- public legal pages (needed by Meta for the WhatsApp app) ----------
const LEGAL_CO = process.env.COMPANY_NAME || 'Heaven Automation Pvt Ltd', LEGAL_MAIL = process.env.COMPANY_EMAIL || 'heavenautomationindia@gmail.com';
const legalPage = (title, body) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · ${LEGAL_CO}</title>
<style>body{margin:0;background:#f6f5f2;font:16px/1.65 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1d1d1f}main{max-width:760px;margin:0 auto;padding:40px 22px 60px}h1{font-size:30px;margin:0 0 4px}h2{font-size:19px;margin:28px 0 6px}.d{color:#777;font-size:14px}a{color:#1f6f5c}nav{display:flex;gap:16px;font-size:14px;margin-bottom:26px}</style></head>
<body><main><nav><a href="/privacy">Privacy policy</a><a href="/terms">Terms of service</a><a href="/data-deletion">Data deletion</a></nav><h1>${title}</h1><div class="d">${LEGAL_CO} · Last updated 19 November 2026</div>${body}</main></body></html>`;
app.get('/privacy', (req, res) => res.send(legalPage('Privacy policy', `
<p>${LEGAL_CO} ("we", "us") uses Rago CRM, an internal business application, to manage customer enquiries, service requests, quotations, invoices and conversations with our customers, including over WhatsApp through the WhatsApp Business Platform provided by Meta.</p>
<h2>Information we collect</h2><p>When you contact us or buy from us, we may collect your name, company name, phone number, WhatsApp profile name, email address, billing and site address, GSTIN, the messages, photos, documents and voice notes you send us, and details of the products and services you ask about or buy.</p>
<h2>How we use it</h2><p>We use this information only to reply to your enquiries, provide quotations and invoices, schedule and complete service work, collect payments, send you updates about your order or service, and keep accounting and tax records required by law.</p>
<h2>WhatsApp messages</h2><p>Messages you send to our business WhatsApp numbers are received through Meta's WhatsApp Business Platform and stored in our CRM so that our staff can reply. We send you business messages (for example quotations, service updates and payment reminders) and, where you have agreed, occasional offers. You can ask us to stop at any time by replying STOP.</p>
<h2>Sharing</h2><p>We do not sell your personal data. It is accessible only to our authorised staff, and to service providers who host our systems (such as our cloud hosting provider and Meta for WhatsApp messaging) under their own privacy terms. We may disclose information when required by law.</p>
<h2>Retention and security</h2><p>We keep your information while you are our customer and for as long as tax and accounting laws require. Access to the CRM is protected by individual staff logins.</p>
<h2>Your rights</h2><p>You can ask us to see, correct or delete your personal information. See <a href="/data-deletion">Data deletion</a> or write to <a href="mailto:${LEGAL_MAIL}">${LEGAL_MAIL}</a>.</p>
<h2>Contact</h2><p>${LEGAL_CO} · <a href="mailto:${LEGAL_MAIL}">${LEGAL_MAIL}</a></p>`)));
app.get('/terms', (req, res) => res.send(legalPage('Terms of service', `
<p>These terms apply when you communicate with ${LEGAL_CO} through our WhatsApp numbers, website links, shared quotations or invoices.</p>
<h2>Use of our messaging</h2><p>Our WhatsApp numbers are for enquiries, orders, service requests and payments relating to our products and services. Please do not send unlawful, abusive or unrelated content.</p>
<h2>Quotations and invoices</h2><p>Quotations are valid for the period stated on them. Prices, taxes and terms printed on a quotation or invoice apply to that order. Shared document links are meant for the recipient only.</p>
<h2>Payments</h2><p>Payment details shown on our invoices (bank account and UPI) belong to ${LEGAL_CO}. Please confirm with us before paying to any other account.</p>
<h2>Liability</h2><p>We take reasonable care to keep information accurate and our services available, but we are not liable for delays or interruptions caused by third-party services such as internet or messaging providers.</p>
<h2>Contact</h2><p><a href="mailto:${LEGAL_MAIL}">${LEGAL_MAIL}</a></p>`)));
app.get('/data-deletion', (req, res) => res.send(legalPage('Data deletion', `
<p>You can ask ${LEGAL_CO} to delete the personal information we hold about you, including your WhatsApp conversation history with us.</p>
<h2>How to request deletion</h2><p>Either send the message <b>DELETE MY DATA</b> to the WhatsApp number you contacted us on, or email <a href="mailto:${LEGAL_MAIL}?subject=Data%20deletion%20request">${LEGAL_MAIL}</a> with your name and phone number.</p>
<h2>What happens next</h2><p>We confirm your identity and delete your messages and contact details within 30 days. Invoices and payment records that we must keep under Indian tax law (GST) are retained only for the legally required period and then deleted.</p>`)));

// ===================== WARRANTY & SERVICE: material collected from customers, handled on site or by a W&S vendor =====================
const WC_ST = ['New', 'In progress', 'With vendor', 'Ready', 'Converted', 'Closed', 'Cancelled'];
const WC_OPEN = ['New', 'In progress', 'With vendor', 'Ready'];
const BANKS_DEF = [...BANKS];
async function loadBanks() { let v = null; try { v = JSON.parse(((await q(`SELECT v FROM settings WHERE k='banks'`)).rows[0] || {}).v || 'null'); } catch (e) { v = null; } BANKS.splice(0, BANKS.length, ...(Array.isArray(v) && v.length ? v : BANKS_DEF)); }
app.get('/api/settings/banks', wrap(async (req, res) => res.json(BANKS)));
app.put('/api/settings/banks', superOnly, wrap(async (req, res) => {
  const l = [...new Set((Array.isArray((req.body || {}).banks) ? req.body.banks : []).map(x => String(x || '').trim().slice(0, 80)).filter(Boolean))].slice(0, 30);
  if (!l.length) return res.status(400).json({ error: 'Keep at least one account' });
  await q(`INSERT INTO settings(k,v) VALUES('banks',$1) ON CONFLICT (k) DO UPDATE SET v=$1`, [JSON.stringify(l)]); await loadBanks(); res.json({ ok: true, banks: BANKS });
}));
async function initWC() {
  await loadBanks();
  await q(`
  CREATE TABLE IF NOT EXISTS wc_vendors (id SERIAL PRIMARY KEY, name TEXT NOT NULL, company TEXT, phone TEXT, address TEXT, handles TEXT, notes TEXT, opening_bal NUMERIC(14,2) DEFAULT 0, active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS wc_cases (id SERIAL PRIMARY KEY, service_id INT, customer_id INT, brand_id INT, item TEXT, model TEXT, serial_no TEXT, qty INT DEFAULT 1, kind TEXT, engineer_note TEXT,
    created_by TEXT, created_by_id INT, status TEXT DEFAULT 'New', mode TEXT, handler_id INT, work_status TEXT, vendor_id INT REFERENCES wc_vendors(id), sent_on DATE, vendor_ref TEXT, vendor_status TEXT,
    vendor_back_on DATE, vendor_charge NUMERIC(14,2) DEFAULT 0, charge_type TEXT, customer_charge NUMERIC(14,2) DEFAULT 0, received NUMERIC(14,2) DEFAULT 0, cancel_reason TEXT, cancel_where TEXT,
    converted_service_id INT, history JSONB DEFAULT '[]', created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(), closed_at TIMESTAMPTZ);
  CREATE INDEX IF NOT EXISTS idx_wc_status ON wc_cases(status);
  ALTER TABLE wc_vendors ADD COLUMN IF NOT EXISTS gstin TEXT; ALTER TABLE wc_vendors ADD COLUMN IF NOT EXISTS state TEXT; ALTER TABLE wc_vendors ADD COLUMN IF NOT EXISTS pincode TEXT;
  CREATE TABLE IF NOT EXISTS wc_media (id SERIAL PRIMARY KEY, case_id INT REFERENCES wc_cases(id) ON DELETE CASCADE, kind TEXT, mime TEXT, data BYTEA, duration INT, uploaded_by TEXT, created_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS wc_payments (id SERIAL PRIMARY KEY, case_id INT REFERENCES wc_cases(id) ON DELETE CASCADE, vendor_id INT REFERENCES wc_vendors(id), dir TEXT, amount NUMERIC(14,2) NOT NULL, mode TEXT, account TEXT, note TEXT, by_name TEXT, paid_on DATE DEFAULT CURRENT_DATE, created_at TIMESTAMPTZ DEFAULT now());`);
  if (!(await q(`SELECT 1 FROM settings WHERE k='wc_perm_v1'`)).rows.length) {   // admins who handle services get Warranty & service once
    await q(`UPDATE users SET permissions = (SELECT ARRAY(SELECT DISTINCT unnest(permissions || ARRAY['warranty']))) WHERE role='Admin' AND 'services'=ANY(permissions)`);
    await q(`INSERT INTO settings(k,v) VALUES('wc_perm_v1','1') ON CONFLICT (k) DO NOTHING`);
  }
}
const wcCan = u => can(u, 'warranty');
const wcPeople = async brandId => (await q(`SELECT id FROM users WHERE active AND (role=$1 OR ('warranty'=ANY(permissions) AND (brand_id IS NULL OR brand_id=$2)))`, [SUPER, brandId || 0])).rows.map(r => r.id);
const wcMedia = (d, kinds) => { const m = /^data:([\w/+.-]+)(?:;[^,]*)?;base64,(.+)$/.exec(String(d || '')); if (!m || !kinds.test(m[1])) return null; const b = Buffer.from(m[2], 'base64'); return b.length > 8e6 ? null : { mime: m[1], buf: b }; };
const wcScope = (u, p, w) => {
  if (!wcCan(u)) { p.push(u.id); w.push(`(c.created_by_id=$${p.length} OR c.handler_id=$${p.length})`); }   // engineers: cases they collected or handle
  else if (u.brand_id && !isSuper(u)) { p.push(u.brand_id); w.push(`c.brand_id=$${p.length}`); }
};
const WC_SEL = `SELECT c.*, 'WS-' || c.id case_no, cu.name customer, cu.phone, cu.company customer_company, cu.address, s.ticket_no, b.name brand, h.name handler, v.name vendor, v.company vendor_company,
  (SELECT COALESCE(json_agg(json_build_object('id',m.id,'kind',m.kind,'duration',m.duration,'by',m.uploaded_by) ORDER BY m.id),'[]') FROM wc_media m WHERE m.case_id=c.id) media,
  COALESCE((SELECT SUM(amount) FROM wc_payments y WHERE y.case_id=c.id AND y.dir='vendor'),0) vendor_paid
  FROM wc_cases c LEFT JOIN customers cu ON cu.id=c.customer_id LEFT JOIN services s ON s.id=c.service_id LEFT JOIN brands b ON b.id=c.brand_id LEFT JOIN users h ON h.id=c.handler_id LEFT JOIN wc_vendors v ON v.id=c.vendor_id`;
const wcLoad = async (req, res) => {
  const p = [+req.params.id], w = ['c.id=$1']; wcScope(req.user, p, w);
  const c = (await q(`${WC_SEL} WHERE ${w.join(' AND ')}`, p)).rows[0];
  if (!c) { res.status(404).json({ error: 'Not found' }); return null; }
  ['vendor_charge', 'customer_charge', 'received', 'vendor_paid'].forEach(k => c[k] = Number(c[k] || 0)); return c;
};
const wcLog = async (id, by, text, status) => { await q(`UPDATE wc_cases SET history = history || $2::jsonb, updated_at=now() WHERE id=$1`, [id, JSON.stringify([{ at: new Date().toISOString(), by, text, status: status || null }])]); };
// engineer (or office) records that the customer handed over material for warranty / service
app.post('/api/services/:id/warranty', wrap(async (req, res) => {
  const s = await mine(req, res); if (!s) return;
  const b = req.body || {}, photos = (Array.isArray(b.photos) ? b.photos : []).map(x => wcMedia(x, /^image\//)).filter(Boolean).slice(0, 8);
  if (!photos.length) return res.status(400).json({ error: 'Add at least one photo of the material' });
  const tech = isTech(req.user);
  if (tech && s.status !== 'On-Process') return res.status(400).json({ error: 'Start the job first' });
  const t = (k, n = 300) => String(b[k] || '').trim().slice(0, n) || null;
  const c = (await q(`INSERT INTO wc_cases(service_id,customer_id,brand_id,item,model,serial_no,qty,engineer_note,created_by,created_by_id,history) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [s.id, s.customer_id, s.brand_id, t('item', 200), t('model', 120), t('serial_no', 80), Math.max(1, Math.min(999, parseInt(b.qty) || 1)), t('note', 2000), req.user.name, req.user.id,
      JSON.stringify([{ at: new Date().toISOString(), by: req.user.name, text: 'Material received from customer', status: 'New' }])])).rows[0];
  for (const ph of photos) await q('INSERT INTO wc_media(case_id,kind,mime,data,uploaded_by) VALUES($1,$2,$3,$4,$5)', [c.id, 'photo', ph.mime, ph.buf, req.user.name]);
  const vo = wcMedia(b.voice, /^audio\//); if (vo) await q('INSERT INTO wc_media(case_id,kind,mime,data,duration,uploaded_by) VALUES($1,$2,$3,$4,$5,$6)', [c.id, 'voice', vo.mime, vo.buf, Math.max(0, Math.min(600, parseInt(b.duration) || 0)), req.user.name]);
  if (tech) {   // the engineer's job is finished — the material now follows the Warranty & Service flow
    await q(`UPDATE services SET status='Awaiting Payment', work_status='Done', work_done_on=now(), completion_note=$2, pending_reason=NULL, billing_type='Free' WHERE id=$1`, [s.id, `Material collected for warranty / service → WS-${c.id}${b.note ? ' · ' + String(b.note).slice(0, 300) : ''}`]);
  }
  await log(s.id, req.user.name, `🛡 Warranty / service material received → WS-${c.id}${b.item ? ' · ' + String(b.item).slice(0, 100) : ''} · ${photos.length} photo${photos.length > 1 ? 's' : ''}${vo ? ' + voice' : ''}`);
  await notify((await wcPeople(s.brand_id)).filter(id => id !== req.user.id), '🛡 Warranty / service material received', `${req.user.name} collected ${b.item ? String(b.item).slice(0, 80) : 'material'} from ${s.customer || 'customer'} (#${s.ticket_no}) → WS-${c.id}`, null, 'wc:' + c.id);
  res.json({ ok: true, id: c.id, case_no: 'WS-' + c.id });
}));
app.get('/api/wc', wrap(async (req, res) => {
  const p = [], w = []; wcScope(req.user, p, w);
  const st = String(req.query.status || 'open');
  const cw = [...w], cp = [...p];
  if (req.query.service_id) {} else if (st === 'open') { p.push(WC_OPEN); w.push(`c.status=ANY($${p.length})`); } else if (WC_ST.includes(st)) { p.push(st); w.push(`c.status=$${p.length}`); }
  if (req.query.vendor) { p.push(+req.query.vendor); w.push(`c.vendor_id=$${p.length}`); }
  if (req.query.service_id) { p.push(+req.query.service_id); w.push(`c.service_id=$${p.length}`); }
  if (req.query.q) { p.push('%' + req.query.q + '%'); const n = p.length; w.push(`(c.item ILIKE $${n} OR c.serial_no ILIKE $${n} OR c.model ILIKE $${n} OR cu.name ILIKE $${n} OR cu.phone ILIKE $${n} OR ('WS-'||c.id) ILIKE $${n} OR s.ticket_no::text ILIKE $${n} OR v.name ILIKE $${n})`); }
  const items = (await q(`${WC_SEL} ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY c.updated_at DESC LIMIT 500`, p)).rows;
  const counts = Object.fromEntries((await q(`SELECT c.status, COUNT(*)::int n FROM wc_cases c ${cw.length ? 'WHERE ' + cw.join(' AND ') : ''} GROUP BY 1`, cp)).rows.map(r => [r.status, r.n]));
  counts.open = WC_OPEN.reduce((t, k) => t + (counts[k] || 0), 0);
  res.json({ items, counts, statuses: WC_ST, banks: BANKS, manage: wcCan(req.user) });
}));
app.get('/api/wc/:id', wrap(async (req, res) => {
  const c = await wcLoad(req, res); if (!c) return;
  c.payments = (await q(`SELECT *, to_char(paid_on,'YYYY-MM-DD') paid_on FROM wc_payments p WHERE case_id=$1 ORDER BY p.id`, [c.id])).rows;
  c.manage = wcCan(req.user); c.banks = BANKS; res.json(c);
}));
app.get('/api/wc/media/:mid', wrap(async (req, res) => {
  const m = (await q('SELECT * FROM wc_media WHERE id=$1', [+req.params.mid])).rows[0]; if (!m) return res.status(404).end();
  req.params.id = m.case_id; const c = await wcLoad(req, res); if (!c) return;
  res.setHeader('Content-Type', m.mime || 'application/octet-stream'); res.setHeader('Cache-Control', 'private, max-age=86400'); res.end(m.data);
}));
app.post('/api/wc/:id/media', wrap(async (req, res) => {
  const c = await wcLoad(req, res); if (!c) return;
  const b = req.body || {}, ph = wcMedia(b.image, /^image\//), vo = wcMedia(b.voice, /^audio\//);
  if (!ph && !vo) return res.status(400).json({ error: 'Add a photo or a voice message' });
  if (ph) await q('INSERT INTO wc_media(case_id,kind,mime,data,uploaded_by) VALUES($1,$2,$3,$4,$5)', [c.id, 'photo', ph.mime, ph.buf, req.user.name]);
  if (vo) await q('INSERT INTO wc_media(case_id,kind,mime,data,duration,uploaded_by) VALUES($1,$2,$3,$4,$5,$6)', [c.id, 'voice', vo.mime, vo.buf, Math.max(0, Math.min(600, parseInt(b.duration) || 0)), req.user.name]);
  await wcLog(c.id, req.user.name, ph ? '📷 Photo added' : '🎙 Voice message added'); res.json({ ok: true });
}));
// office decides how it is handled: on site (our engineer) or off site (W&S vendor); free or paid; progress
app.patch('/api/wc/:id', wrap(async (req, res) => {
  const c = await wcLoad(req, res); if (!c) return;
  const b = req.body || {}, set = {}, said = [];
  if (!wcCan(req.user)) {   // the engineer handling it on site can only move the work along
    if (c.handler_id !== req.user.id) return res.status(403).json({ error: 'Not allowed' });
    if (['Not started', 'Started', 'Done'].includes(b.work_status) && b.work_status !== c.work_status) { set.work_status = b.work_status; said.push('Work ' + b.work_status.toLowerCase()); if (b.work_status !== 'Not started' && c.status === 'New') set.status = 'In progress'; if (b.work_status === 'Done') set.status = 'Ready'; }
  } else {
    if (['Closed', 'Converted', 'Cancelled'].includes(c.status)) return res.status(400).json({ error: 'This case is ' + c.status.toLowerCase() });
    const t = (k, n = 200) => String(b[k] ?? '').trim().slice(0, n) || null;
    for (const k of ['item', 'model', 'serial_no']) if (b[k] !== undefined && t(k) !== c[k]) set[k] = t(k);
    if (['Warranty', 'Service'].includes(b.kind) && b.kind !== c.kind) { set.kind = b.kind; said.push(b.kind); }
    if (['On site', 'Off site'].includes(b.mode) && b.mode !== c.mode) { set.mode = b.mode; said.push(b.mode === 'On site' ? 'Handled on site' : 'Sent off site (vendor)'); }
    const mode = set.mode || c.mode;
    if (mode === 'On site') {
      if (b.handler_id !== undefined && (+b.handler_id || null) !== c.handler_id) {
        const h = +b.handler_id ? (await q(`SELECT id, name FROM users WHERE id=$1 AND active`, [+b.handler_id])).rows[0] : null;
        set.handler_id = h ? h.id : null; if (h) { said.push('Engineer: ' + h.name); if (h.id !== req.user.id) await notify([h.id], '🛡 Warranty / service work for you', `WS-${c.id} · ${c.item || 'material'} · ${c.customer || ''} — handle it on site`, null, 'wc:' + c.id); }
      }
      if (['Not started', 'Started', 'Done'].includes(b.work_status) && b.work_status !== c.work_status) { set.work_status = b.work_status; said.push('Work ' + b.work_status.toLowerCase()); }
      if (set.mode) { set.vendor_status = null; }
    }
    if (mode === 'Off site') {
      if (b.vendor_id !== undefined && (+b.vendor_id || null) !== c.vendor_id) {
        const v = +b.vendor_id ? (await q('SELECT id, name FROM wc_vendors WHERE id=$1', [+b.vendor_id])).rows[0] : null;
        set.vendor_id = v ? v.id : null; if (v) said.push('Vendor: ' + v.name);
      }
      if (b.vendor_ref !== undefined && t('vendor_ref', 80) !== c.vendor_ref) { set.vendor_ref = t('vendor_ref', 80); if (set.vendor_ref) said.push('Docket ' + set.vendor_ref); }
      if (/^\d{4}-\d{2}-\d{2}$/.test(b.sent_on || '')) set.sent_on = b.sent_on;
      if (['With vendor', 'Returned to us'].includes(b.vendor_status) && b.vendor_status !== c.vendor_status) {
        if (!(set.vendor_id || c.vendor_id)) return res.status(400).json({ error: 'Choose the vendor first' });
        set.vendor_status = b.vendor_status; said.push(b.vendor_status === 'With vendor' ? 'Given to vendor' : 'Material returned from vendor');
        if (b.vendor_status === 'With vendor' && !set.sent_on && !c.sent_on) set.sent_on = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
        if (b.vendor_status === 'Returned to us') set.vendor_back_on = /^\d{4}-\d{2}-\d{2}$/.test(b.vendor_back_on || '') ? b.vendor_back_on : new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
      }
      if (b.vendor_charge !== undefined && money(b.vendor_charge) !== c.vendor_charge) { set.vendor_charge = money(b.vendor_charge); said.push('Vendor charge ₹' + set.vendor_charge); }
    }
    if (['Free', 'Paid'].includes(b.charge_type) && b.charge_type !== c.charge_type) { set.charge_type = b.charge_type; said.push(b.charge_type === 'Free' ? 'Free for customer' : 'Paid by customer'); if (b.charge_type === 'Free') set.customer_charge = 0; }
    if ((set.charge_type || c.charge_type) === 'Paid' && b.customer_charge !== undefined && money(b.customer_charge) !== c.customer_charge) { set.customer_charge = money(b.customer_charge); said.push('Customer charge ₹' + set.customer_charge); }
    // case status follows what is happening
    const vs = set.vendor_status !== undefined ? set.vendor_status : c.vendor_status, ws = set.work_status !== undefined ? set.work_status : c.work_status;
    const nst = mode === 'Off site' ? (vs === 'With vendor' ? 'With vendor' : vs === 'Returned to us' ? 'Ready' : 'In progress') : mode === 'On site' ? (ws === 'Done' ? 'Ready' : 'In progress') : c.status;
    if (nst !== c.status) set.status = nst;
  }
  const note = String(b.note || '').trim().slice(0, 1000);
  const ks = Object.keys(set);
  if (!ks.length && !note) return res.json({ ok: true });
  if (ks.length) await q(`UPDATE wc_cases SET ${ks.map((k, i) => `${k}=$${i + 2}`).join(',')}, updated_at=now() WHERE id=$1`, [c.id, ...ks.map(k => set[k])]);
  await wcLog(c.id, req.user.name, [...said, note].filter(Boolean).join(' · ') || 'Details updated', set.status);
  if (set.status === 'Ready') await notify((await wcPeople(c.brand_id)).filter(id => id !== req.user.id), '🛡 Ready to go back to customer', `WS-${c.id} · ${c.item || 'material'} · ${c.customer || ''} is ready — convert to a service visit`, null, 'wc:' + c.id);
  if (c.service_id && set.status) await log(c.service_id, req.user.name, `🛡 WS-${c.id}: ${set.status}${said.length ? ' · ' + said.join(' · ') : ''}`);
  res.json({ ok: true, status: set.status || c.status });
}));
// money: customer pays us, or we pay the vendor
app.post('/api/wc/:id/payments', wrap(async (req, res) => {
  if (!wcCan(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const c = await wcLoad(req, res); if (!c) return;
  const b = req.body || {}, amt = money(b.amount), dir = b.dir === 'vendor' ? 'vendor' : 'customer';
  if (amt <= 0) return res.status(400).json({ error: 'Enter the amount' });
  const mode = b.mode === 'Bank' ? 'Bank' : 'Cash', acc = BANKS.includes(b.account) ? b.account : null;
  if (!acc) return res.status(400).json({ error: mode === 'Cash' ? 'Choose which cash account' : 'Choose which bank account' });
  if (dir === 'customer') { const due = Math.round((c.customer_charge - c.received) * 100) / 100; if (c.charge_type !== 'Paid' || c.customer_charge <= 0) return res.status(400).json({ error: 'Set the customer charge first (Paid)' }); if (amt > due + 0.009) return res.status(400).json({ error: `Only ₹${due} is due from the customer` }); }
  else if (!c.vendor_id) return res.status(400).json({ error: 'This case has no vendor' });
  await q(`INSERT INTO wc_payments(case_id,vendor_id,dir,amount,mode,account,note,by_name,paid_on) VALUES($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::date,CURRENT_DATE))`,
    [c.id, dir === 'vendor' ? c.vendor_id : null, dir, amt, mode, acc, String(b.note || '').slice(0, 300) || null, req.user.name, /^\d{4}-\d{2}-\d{2}$/.test(b.paid_on || '') ? b.paid_on : null]);
  if (dir === 'customer') await q('UPDATE wc_cases SET received=received+$2 WHERE id=$1', [c.id, amt]);
  await wcLog(c.id, req.user.name, `${dir === 'vendor' ? '💸 Paid vendor' : '💰 Received from customer'} ₹${amt} · ${mode} · ${acc}`);
  res.json({ ok: true });
}));
app.delete('/api/wc/payments/:pid', wrap(async (req, res) => {
  if (!wcCan(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const y = (await q('SELECT * FROM wc_payments WHERE id=$1', [+req.params.pid])).rows[0]; if (!y) return res.status(404).json({ error: 'Not found' });
  req.params.id = y.case_id; const c = await wcLoad(req, res); if (!c) return;
  await q('DELETE FROM wc_payments WHERE id=$1', [y.id]); if (y.dir === 'customer') await q('UPDATE wc_cases SET received=GREATEST(0,received-$2) WHERE id=$1', [c.id, y.amount]);
  await wcLog(c.id, req.user.name, `Payment of ₹${Number(y.amount)} removed`); res.json({ ok: true });
}));
// finished: make a service visit to give it back / install it, or close / cancel
app.post('/api/wc/:id/convert', wrap(async (req, res) => {
  if (!wcCan(req.user) || !can(req.user, 'service_create')) return res.status(403).json({ error: 'Not allowed' });
  const c = await wcLoad(req, res); if (!c) return;
  if (!WC_OPEN.includes(c.status)) return res.status(400).json({ error: 'This case is ' + c.status.toLowerCase() });
  if (!c.customer_id) return res.status(400).json({ error: 'This case has no customer' });
  const due = Math.max(0, Math.round((c.customer_charge - c.received) * 100) / 100);
  const det = `Return ${c.item || 'material'}${c.serial_no ? ' (S/N ' + c.serial_no + ')' : ''} after ${(c.kind || 'warranty / service').toLowerCase()} — WS-${c.id}${due ? ` · collect ₹${due}` : ''}`;
  const tn = 100000 + crypto.randomInt(899999);
  const sv = (await q(`INSERT INTO services(ticket_no,customer_id,brand_id,service_type,visit_type,request_details,charges_applied,kind,product) VALUES($1,$2,$3,$4,'Onsite',$5,$6,'Service',$7) RETURNING id, ticket_no`,
    [tn, c.customer_id, c.brand_id, 'Warranty / Service return', det, due, c.item])).rows[0];
  await q('UPDATE services SET created_by=$2 WHERE id=$1', [sv.id, req.user.id]);
  await log(sv.id, req.user.name, `Created from WS-${c.id}`);
  await q(`UPDATE wc_cases SET status='Converted', converted_service_id=$2, closed_at=now(), updated_at=now() WHERE id=$1`, [c.id, sv.id]);
  await wcLog(c.id, req.user.name, `Converted to service ticket #${sv.ticket_no}`, 'Converted');
  if (c.service_id) await log(c.service_id, req.user.name, `🛡 WS-${c.id} → new service #${sv.ticket_no}`);
  res.json({ ok: true, service_id: sv.id, ticket_no: sv.ticket_no });
}));
app.post('/api/wc/:id/close', wrap(async (req, res) => {
  if (!wcCan(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const c = await wcLoad(req, res); if (!c) return;
  if (!WC_OPEN.includes(c.status)) return res.status(400).json({ error: 'This case is ' + c.status.toLowerCase() });
  const b = req.body || {}, cancel = b.cancel === true, reason = String(b.reason || '').trim().slice(0, 500);
  if (cancel && !reason) return res.status(400).json({ error: 'Why is it cancelled?' });
  const where = ['Returned to customer', 'Left with vendor', 'Returned to vendor', 'With us'].includes(b.where) ? b.where : null;
  await q(`UPDATE wc_cases SET status=$2, cancel_reason=$3, cancel_where=$4, closed_at=now(), updated_at=now() WHERE id=$1`, [c.id, cancel ? 'Cancelled' : 'Closed', cancel ? reason : null, where]);
  await wcLog(c.id, req.user.name, (cancel ? 'Cancelled: ' + reason : 'Closed' + (reason ? ': ' + reason : '')) + (where ? ' · material ' + where.toLowerCase() : ''), cancel ? 'Cancelled' : 'Closed');
  if (c.service_id) await log(c.service_id, req.user.name, `🛡 WS-${c.id} ${cancel ? 'cancelled' : 'closed'}`);
  res.json({ ok: true });
}));
// W&S vendors (separate from purchase vendors) with their account
const wcVendorNeed = (req, res, next) => wcCan(req.user) ? next() : res.status(403).json({ error: 'Not allowed' });
app.get('/api/wc-vendors', wcVendorNeed, wrap(async (req, res) => {
  const rows = (await q(`SELECT v.*, COALESCE(x.charges,0) charges, COALESCE(x.holding,0)::int holding, COALESCE(x.cases,0)::int cases, COALESCE(y.paid,0) paid
    FROM wc_vendors v LEFT JOIN (SELECT vendor_id, SUM(vendor_charge) charges, COUNT(*) FILTER (WHERE vendor_status='With vendor' AND status NOT IN ('Cancelled','Closed','Converted')) holding, COUNT(*) cases FROM wc_cases GROUP BY 1) x ON x.vendor_id=v.id
    LEFT JOIN (SELECT vendor_id, SUM(amount) paid FROM wc_payments WHERE dir='vendor' GROUP BY 1) y ON y.vendor_id=v.id WHERE v.active OR $1 ORDER BY lower(v.name)`, [req.query.all === '1'])).rows;
  rows.forEach(r => { r.balance = Math.round((Number(r.charges) + Number(r.opening_bal || 0) - Number(r.paid)) * 100) / 100; });
  res.json(rows);
}));
app.post('/api/wc-vendors', wcVendorNeed, wrap(async (req, res) => {
  const b = req.body || {}, t = (k, n = 300) => String(b[k] || '').trim().slice(0, n) || null;
  if (!t('name', 120)) return res.status(400).json({ error: 'Enter the vendor name' });
  if (!blGstOk((t('gstin', 15) || '').toUpperCase())) return res.status(400).json({ error: 'GSTIN looks wrong — check the 15 characters' });
  const r = (await q(`INSERT INTO wc_vendors(name,company,phone,address,handles,notes,opening_bal,gstin,state,pincode) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [t('name', 120), t('company', 120), t('phone', 30), t('address', 500), t('handles', 300), t('notes', 1000), money(b.opening_bal), (t('gstin', 15) || '').toUpperCase() || null, blState(t('state', 60)) || t('state', 60), t('pincode', 10)])).rows[0];
  res.json({ ok: true, id: r.id });
}));
app.patch('/api/wc-vendors/:id', wcVendorNeed, wrap(async (req, res) => {
  const b = req.body || {}, set = {};
  for (const k of ['name', 'company', 'phone', 'address', 'handles', 'notes']) if (b[k] !== undefined) set[k] = String(b[k] || '').trim().slice(0, 500) || null;
  if (set.gstin === undefined && b.gstin !== undefined) set.gstin = String(b.gstin || '').trim().toUpperCase().slice(0, 15) || null;
  if (b.state !== undefined) set.state = blState(b.state) || String(b.state || '').trim().slice(0, 60) || null; if (b.pincode !== undefined) set.pincode = String(b.pincode || '').trim().slice(0, 10) || null;
  if (set.name === null) return res.status(400).json({ error: 'Enter the vendor name' });
  if (!blGstOk(set.gstin)) return res.status(400).json({ error: 'GSTIN looks wrong — check the 15 characters' });
  if (b.opening_bal !== undefined) set.opening_bal = money(b.opening_bal); if (b.active !== undefined) set.active = !!b.active;
  const ks = Object.keys(set); if (ks.length) await q(`UPDATE wc_vendors SET ${ks.map((k, i) => `${k}=$${i + 2}`).join(',')} WHERE id=$1`, [+req.params.id, ...ks.map(k => set[k])]);
  res.json({ ok: true });
}));
app.get('/api/wc-vendors/:id', wcVendorNeed, wrap(async (req, res) => {
  const v = (await q('SELECT * FROM wc_vendors WHERE id=$1', [+req.params.id])).rows[0]; if (!v) return res.status(404).json({ error: 'Not found' });
  const cases = (await q(`${WC_SEL} WHERE c.vendor_id=$1 ORDER BY c.updated_at DESC LIMIT 300`, [v.id])).rows;
  const pays = (await q(`SELECT p.*, to_char(p.paid_on,'YYYY-MM-DD') paid_on, 'WS-' || p.case_id case_no FROM wc_payments p WHERE p.vendor_id=$1 AND p.dir='vendor' ORDER BY p.paid_on DESC, p.id DESC`, [v.id])).rows;
  const charges = cases.reduce((t, c) => t + Number(c.vendor_charge || 0), 0), paid = pays.reduce((t, p) => t + Number(p.amount), 0);
  res.json({ vendor: v, cases, payments: pays, charges, paid, balance: Math.round((charges + Number(v.opening_bal || 0) - paid) * 100) / 100, holding: cases.filter(c => c.vendor_status === 'With vendor' && WC_OPEN.includes(c.status)).length, banks: BANKS });
}));
app.post('/api/wc-vendors/:id/payments', wcVendorNeed, wrap(async (req, res) => {   // pay the vendor without picking a case
  const b = req.body || {}, amt = money(b.amount); if (amt <= 0) return res.status(400).json({ error: 'Enter the amount' });
  const acc = BANKS.includes(b.account) ? b.account : null; if (!acc) return res.status(400).json({ error: 'Choose the account' });
  await q(`INSERT INTO wc_payments(vendor_id,dir,amount,mode,account,note,by_name) VALUES($1,'vendor',$2,$3,$4,$5,$6)`, [+req.params.id, amt, b.mode === 'Bank' ? 'Bank' : 'Cash', acc, String(b.note || '').slice(0, 300) || null, req.user.name]);
  res.json({ ok: true });
}));

// ===================== GSTIN lookup (auto-fill party details) =====================
const GST_RE = /^[0-9]{2}[A-Z0-9]{10}[0-9A-Z][Z1-9A-Z][0-9A-Z]$/;
const GST_CH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const gstSum = g => { let t = 0; for (let i = 0; i < 14; i++) { const v = GST_CH.indexOf(g[i]) * (i % 2 ? 2 : 1); t += Math.floor(v / 36) + (v % 36); } return GST_CH[(36 - (t % 36)) % 36]; };
const gstOk = v => { const g = String(v || '').trim().toUpperCase(); return g.length === 15 && /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g) && gstSum(g) === g[14]; };
let GSTKEY = '';
const gstKey = () => process.env.GSTIN_API_KEY || GSTKEY;
async function initGST() {
  await q(`CREATE TABLE IF NOT EXISTS gst_cache (gstin TEXT PRIMARY KEY, data JSONB, at TIMESTAMPTZ DEFAULT now())`);
  const r = (await q(`SELECT v FROM settings WHERE k='gst_api_key'`)).rows[0]; GSTKEY = r ? String(r.v || '') : '';
}
const gstOffline = g => { const st = (BL_STATES.find(x => x[0] === g.slice(0, 2)) || [])[1] || null; return { gstin: g, state: st, state_code: g.slice(0, 2), pan: g.slice(2, 12) }; };
const gstShape = (g, d) => {   // provider record → our party fields
  d = d || {}; const pick = (...k) => { for (const x of k) { const v = d[x]; if (v && typeof v === 'string' && v.trim()) return v.trim(); } return null; };
  let addr = d.address; if (addr && typeof addr === 'object') addr = [addr.building_number || addr.bno, addr.building_name || addr.bnm, addr.floor || addr.flno, addr.street || addr.st, addr.location || addr.loc, addr.locality, addr.city || addr.dst, addr.district].filter(Boolean).join(', ');
  addr = addr ? String(addr).replace(/\s+/g, ' ').trim() : null;
  const pin = pick('pincode', 'pin') || ((/\b(\d{6})\b/.exec(addr || '') || [])[1]) || null;
  const legal = pick('legal_name', 'lgnm', 'legalName'), trade = pick('trade_name', 'tradeNam', 'tradeName');
  const city = pick('city', 'district') || (d.address && typeof d.address === 'object' && (d.address.city || d.address.dst)) || null;
  const off = gstOffline(g);
  return { ...off, state: blState(pick('state', 'state_name')) || off.state, company: legal || trade, name: trade || legal, legal_name: legal, trade_name: trade, address: addr, city, pincode: pin,
    status: pick('status', 'sts'), taxpayer_type: pick('taxpayer_type', 'dty', 'taxpayerType'), registered_on: pick('registration_date', 'rgdt') };
};
app.get('/api/gst/:gstin', need('billing', 'purchases', 'warranty', 'leads', 'services', 'customers'), wrap(async (req, res) => {
  const g = String(req.params.gstin || '').trim().toUpperCase();
  if (!GST_RE.test(g) || !gstOk(g)) return res.status(400).json({ error: 'GSTIN looks wrong — it should be 15 characters like 33AAACH1234K1Z5' });
  const off = gstOffline(g);
  const c = (await q(`SELECT data FROM gst_cache WHERE gstin=$1 AND at>now()-interval '30 days'`, [g])).rows[0];
  if (c && req.query.fresh !== '1') return res.json({ ...c.data, source: 'cache' });
  if (!gstKey()) return res.json({ ...off, source: 'offline', note: 'Only state and PAN filled. Add a GSTIN lookup key in Settings to fill the name and address too.' });
  try {
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 12000);
    const r = await fetch(`${process.env.GSTIN_API_URL || 'https://www.gstinapi.in'}/v1/gstin/${encodeURIComponent(g)}`, { headers: { 'x-api-key': gstKey(), accept: 'application/json' }, signal: ctl.signal });
    clearTimeout(tm); const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) {
      const msg = r.status === 404 ? 'No business found for this GSTIN' : r.status === 401 || r.status === 403 ? 'GSTIN lookup key is not valid — check it in Settings' : r.status === 402 ? 'GSTIN lookup credits are used up — recharge at gstinapi.in' : r.status === 429 ? 'Too many lookups — try again in a minute' : (j.error || j.message || 'GSTIN lookup failed');
      return res.json({ ...off, source: 'offline', error: msg });
    }
    const out = gstShape(g, j.data || j);
    await q(`INSERT INTO gst_cache(gstin,data,at) VALUES($1,$2,now()) ON CONFLICT (gstin) DO UPDATE SET data=$2, at=now()`, [g, out]);
    res.json({ ...out, source: 'online', credits_remaining: j.credits_remaining ?? null });
  } catch (e) { res.json({ ...off, source: 'offline', error: e.name === 'AbortError' ? 'GSTIN lookup timed out' : 'Could not reach the GSTIN lookup service' }); }
}));
app.get('/api/settings/gst', superOnly, wrap(async (req, res) => {
  const k = gstKey(); res.json({ set: !!k, env: !!process.env.GSTIN_API_KEY, masked: k ? k.slice(0, 4) + '••••' + k.slice(-3) : '' });
}));
app.put('/api/settings/gst', superOnly, wrap(async (req, res) => {
  const k = String((req.body || {}).key || '').trim().slice(0, 200);
  await q(`INSERT INTO settings(k,v) VALUES('gst_api_key',$1) ON CONFLICT (k) DO UPDATE SET v=$1`, [k]); GSTKEY = k; res.json({ ok: true, set: !!gstKey() });
}));

// ===================== ROLES & FEATURES (Super Admin) =====================
async function initRoles() {
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS job_role TEXT`);
  const g = async k => { try { return JSON.parse(((await q(`SELECT v FROM settings WHERE k=$1`, [k])).rows[0] || {}).v || 'null'); } catch (e) { return null; } };
  ROLE_DEF = (await g('role_defaults')) || {}; CUSTOM_ROLES = (await g('roles_custom')) || [];
}
const ROLE_BASES = ['Admin', 'Sales Admin', 'Sales', 'Technician', 'Staff'];
app.get('/api/roles', superOnly, wrap(async (req, res) => {
  const used = Object.fromEntries((await q(`SELECT job_role, COUNT(*)::int n FROM users WHERE job_role IS NOT NULL AND active GROUP BY 1`)).rows.map(r => [r.job_role, r.n]));
  const byRole = Object.fromEntries((await q(`SELECT role, COUNT(*)::int n FROM users WHERE active GROUP BY 1`)).rows.map(r => [r.role, r.n]));
  res.json({ perms: PERMS, bases: ROLE_BASES, keys: Object.fromEntries(ROLE_BASES.map(r => [r, roleKeys(r)])), builtin: ROLE_BASES.map(r => ({ role: r, perms: roleDefaults()[r] || [], factory: DEFAULTS[r], users: byRole[r] || 0, changed: Array.isArray(ROLE_DEF[r]) })),
    custom: CUSTOM_ROLES.map(c => ({ ...c, users: used[c.name] || 0 })) });
}));
app.put('/api/roles', superOnly, wrap(async (req, res) => {
  const b = req.body || {}, defs = {}, cust = [], seen = new Set();
  for (const r of ROLE_BASES) if (b.defaults && Array.isArray(b.defaults[r])) defs[r] = [...new Set(b.defaults[r])].filter(k => roleKeys(r).includes(k));
  for (const c of (Array.isArray(b.custom) ? b.custom : []).slice(0, 40)) {
    const name = String(c.name || '').trim().slice(0, 40); if (!name) return res.status(400).json({ error: 'Every new role needs a name' });
    if (ROLES.map(x => x.toLowerCase()).includes(name.toLowerCase()) || seen.has(name.toLowerCase())) return res.status(400).json({ error: `“${name}” is already a role` });
    if (!ROLE_BASES.includes(c.base)) return res.status(400).json({ error: `Choose what “${name}” works like` });
    seen.add(name.toLowerCase()); cust.push({ name, base: c.base, perms: [...new Set(Array.isArray(c.perms) ? c.perms : [])].filter(k => roleKeys(c.base).includes(k)), apply: undefined });
  }
  // a renamed / removed custom role: people keep their features, the label goes back to the base role
  const gone = CUSTOM_ROLES.filter(o => !cust.some(n => n.name === o.name)).map(o => o.name);
  if (gone.length) await q(`UPDATE users SET job_role=NULL WHERE job_role=ANY($1)`, [gone]);
  for (const c of cust) await q(`UPDATE users SET role=$2 WHERE job_role=$1 AND role<>$2`, [c.name, c.base]).catch(() => {});
  await q(`INSERT INTO settings(k,v) VALUES('role_defaults',$1) ON CONFLICT (k) DO UPDATE SET v=excluded.v`, [JSON.stringify(defs)]);
  await q(`INSERT INTO settings(k,v) VALUES('roles_custom',$1) ON CONFLICT (k) DO UPDATE SET v=excluded.v`, [JSON.stringify(cust)]);
  ROLE_DEF = defs; CUSTOM_ROLES = cust;
  // optional: give the new features to everyone who already has that role
  let updated = 0;
  for (const a of (Array.isArray(b.apply) ? b.apply : [])) {
    const c = cust.find(x => x.name === a), set = c ? c.perms : defs[a] || (ROLE_BASES.includes(a) ? DEFAULTS[a] : null); if (!set) continue;
    const r = c ? await q(`UPDATE users SET permissions=$2 WHERE job_role=$1 AND role<>$3`, [a, set, SUPER]) : await q(`UPDATE users SET permissions=$2 WHERE role=$1 AND job_role IS NULL`, [a, set]); updated += r.rowCount;
  }
  res.json({ ok: true, updated });
}));

// ===================== FIELD VISITS: sales staff check in / out at sites, photos, customer, GPS route & km =====================
const FV_PURPOSE = ['Sales visit', 'Product demo', 'Follow-up', 'Site survey', 'Payment collection', 'Service / support', 'Other'];
const FV_OUTCOME = ['Interested', 'Quotation needed', 'Order confirmed', 'Follow-up later', 'Not interested', 'Payment collected', 'Other'];
async function initFV() {
  await q(`
  CREATE TABLE IF NOT EXISTS fv_visits (id SERIAL PRIMARY KEY, user_id INT NOT NULL, user_name TEXT, brand_id INT, day DATE NOT NULL, customer_id INT, lead_id INT, is_new BOOLEAN DEFAULT false,
    cust_name TEXT, cust_company TEXT, cust_phone TEXT, cust_address TEXT, purpose TEXT, notes TEXT, outcome TEXT, follow_up DATE,
    in_at TIMESTAMPTZ DEFAULT now(), in_lat DOUBLE PRECISION, in_lng DOUBLE PRECISION, in_acc INT, out_at TIMESTAMPTZ, out_lat DOUBLE PRECISION, out_lng DOUBLE PRECISION, out_acc INT,
    km_before NUMERIC(8,2), km_est BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT now());
  CREATE INDEX IF NOT EXISTS idx_fvv_user ON fv_visits(user_id, day);
  CREATE INDEX IF NOT EXISTS idx_fvv_cust ON fv_visits(customer_id);
  CREATE TABLE IF NOT EXISTS fv_media (id SERIAL PRIMARY KEY, visit_id INT REFERENCES fv_visits(id) ON DELETE CASCADE, data BYTEA, mime TEXT, lat DOUBLE PRECISION, lng DOUBLE PRECISION, created_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS fv_track (id BIGSERIAL PRIMARY KEY, user_id INT NOT NULL, day DATE NOT NULL, at TIMESTAMPTZ NOT NULL, lat DOUBLE PRECISION NOT NULL, lng DOUBLE PRECISION NOT NULL, acc INT, kind TEXT DEFAULT 'gps');
  CREATE INDEX IF NOT EXISTS idx_fvt_user ON fv_track(user_id, day, at);
  CREATE TABLE IF NOT EXISTS fv_plans (id SERIAL PRIMARY KEY, lead_id INT, customer_id INT, user_id INT NOT NULL, plan_date DATE NOT NULL, note TEXT, status TEXT DEFAULT 'planned', visit_id INT,
    by_id INT, by_name TEXT, created_at TIMESTAMPTZ DEFAULT now(), done_at TIMESTAMPTZ);
  CREATE INDEX IF NOT EXISTS idx_fvp_user ON fv_plans(user_id, status, plan_date);
  CREATE INDEX IF NOT EXISTS idx_fvp_lead ON fv_plans(lead_id);
  CREATE TABLE IF NOT EXISTS fv_legs (user_id INT NOT NULL, t_from TIMESTAMPTZ NOT NULL, t_to TIMESTAMPTZ NOT NULL, km NUMERIC(9,2), src TEXT, mins INT, created_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY(user_id, t_from, t_to));
  CREATE TABLE IF NOT EXISTS fv_days (user_id INT NOT NULL, day DATE NOT NULL, started_at TIMESTAMPTZ, start_lat DOUBLE PRECISION, start_lng DOUBLE PRECISION, ended_at TIMESTAMPTZ, end_lat DOUBLE PRECISION, end_lng DOUBLE PRECISION, PRIMARY KEY(user_id, day));`);
  await q(`ALTER TABLE fv_days ADD COLUMN IF NOT EXISTS rate NUMERIC(8,2)`);
  await q(`ALTER TABLE fv_visits ADD COLUMN IF NOT EXISTS plan_id INT`);
  await q(`ALTER TABLE fv_visits ADD COLUMN IF NOT EXISTS cust_pending BOOLEAN DEFAULT false`);
  if (!(await q(`SELECT 1 FROM settings WHERE k='fv_perm_v1'`)).rows.length) {   // sales people get field visits once
    await q(`UPDATE users SET permissions = (SELECT ARRAY(SELECT DISTINCT unnest(permissions || ARRAY['field']))) WHERE role='Sales'`);
    await q(`INSERT INTO settings(k,v) VALUES('fv_perm_v1','1') ON CONFLICT (k) DO NOTHING`);
  }
}
const fvHav = (a, b) => { const R = 6371, r = x => x * Math.PI / 180, dl = r(b.lat - a.lat), dg = r(b.lng - a.lng); const h = Math.sin(dl / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dg / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
// distance along GPS points: ignores poor fixes, small jitter and impossible jumps
const fvKm = pts => {
  let km = 0, a = null;
  for (const p of pts) {
    if (!p || p.lat == null) continue;
    if ((p.acc || 0) > 150 && p.kind === 'gps') continue;
    if (!a) { a = p; continue; }
    const d = fvHav(a, p), hrs = Math.max(1 / 3600, (new Date(p.at) - new Date(a.at)) / 3600e3);
    if (d * 1000 < Math.max(25, Math.min(p.acc || 0, 80))) continue;       // jitter
    if (d / hrs > 150 && d > 0.5) continue;                                // a jump no vehicle makes
    km += d; a = p;
  }
  return Math.round(km * 100) / 100;
};
const fvSees = (u, uid) => uid === u.id || isSuper(u) || can(u, 'field_team');
const fvPoint = (b) => { const lat = +b.lat, lng = +b.lng; if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (!lat && !lng)) return null; return { lat, lng, acc: Math.round(+b.acc || 0) || null }; };
const fvDayPts = async (uid, day) => (await q(`SELECT at, lat, lng, acc, kind FROM fv_track WHERE user_id=$1 AND day=$2 ORDER BY at, id`, [uid, day])).rows;
// km between two moments of the day: GPS trail if we have it, else straight line × 1.25 (marked as estimated)
const fvLeg = (pts, from, to, a, b) => {
  const seg = pts.filter(p => new Date(p.at) >= new Date(from) && new Date(p.at) <= new Date(to));
  const trail = fvKm(seg), straight = a && b ? fvHav(a, b) : 0;
  const gps = seg.filter(p => p.kind === 'gps').length;
  if (gps >= 2 && trail >= straight * 0.8) return { km: trail, est: false };
  return { km: Math.round(straight * 1.25 * 100) / 100, est: straight > 0.05 };
};
// ---- Google Maps road distance + ₹/km rate (Super Admin settings) ----
const fvCfg = async () => { let c = {}; try { c = JSON.parse(((await q(`SELECT v FROM settings WHERE k='fv_cfg'`)).rows[0] || {}).v || '{}'); } catch (e) {}
  c.key = c.key || process.env.GOOGLE_MAPS_API_KEY || ''; c.mode = c.mode === 'DRIVE' ? 'DRIVE' : 'TWO_WHEELER'; c.rate = Number(c.rate) || 0; c.rates = c.rates && typeof c.rates === 'object' ? c.rates : {}; return c; };
const fvRate = (c, uid) => c.rates[uid] !== undefined && c.rates[uid] !== '' && c.rates[uid] !== null ? Number(c.rates[uid]) || 0 : c.rate;
const GMAPS = () => (process.env.GMAPS_URL || 'https://routes.googleapis.com') + '/directions/v2:computeRoutes';
// asks Google for the road distance along the path (start, GPS points as "via" points, end)
const fvGoogle = async (cfg, path) => {
  const pts = []; for (const p of path) { if (!p || p.lat == null) continue; const l = pts[pts.length - 1]; if (!l || fvHav(l, p) >= 0.2) pts.push(p); }
  if (pts.length < 2) return { km: 0, mins: 0 };
  const a = pts[0], b = pts[pts.length - 1], mid = pts.slice(1, -1), K = 23, via = mid.length <= K ? mid : Array.from({ length: K }, (_, i) => mid[Math.round((i + 1) * (mid.length + 1) / (K + 1)) - 1]).filter(Boolean);
  const ll = p => ({ location: { latLng: { latitude: +p.lat, longitude: +p.lng } } });
  const r = await fetch(GMAPS(), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': cfg.key, 'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration' },
    body: JSON.stringify({ origin: ll(a), destination: ll(b), intermediates: via.map(p => ({ via: true, ...ll(p) })), travelMode: cfg.mode, units: 'METRIC' }), signal: AbortSignal.timeout(12000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.routes || !j.routes[0]) throw new Error((j.error && j.error.message) || 'Google Maps did not return a route (' + r.status + ')');
  return { km: Math.round((j.routes[0].distanceMeters || 0) / 10) / 100, mins: Math.round(parseInt(j.routes[0].duration || '0') / 60) };
};
// one leg of travel: cached Google road km when possible, else GPS trail / straight-line estimate
const fvLegRoad = async (uid, cfg, pts, from, to, a, b, done) => {
  const L = fvLeg(pts, from, to, a, b), fb = { km: L.km, est: L.est, src: L.est ? 'approx' : 'gps' };
  if (!from || !to || !a || !b) return fb;
  const c = (await q(`SELECT km, src, mins FROM fv_legs WHERE user_id=$1 AND t_from=$2 AND t_to=$3`, [uid, from, to])).rows[0];
  if (c) return { km: Number(c.km), est: false, src: c.src, mins: c.mins };
  if (!cfg.key || !done) return fb;
  const seg = pts.filter(p => p.kind === 'gps' && (p.acc || 0) <= 100 && new Date(p.at) > new Date(from) && new Date(p.at) < new Date(to));
  try { const g = await fvGoogle(cfg, [a, ...seg, b]);
    await q(`INSERT INTO fv_legs(user_id,t_from,t_to,km,src,mins) VALUES($1,$2,$3,$4,'google',$5) ON CONFLICT DO NOTHING`, [uid, from, to, g.km, g.mins]);
    return { km: g.km, est: false, src: 'google', mins: g.mins };
  } catch (e) { console.error('fv google', e.message); return { ...fb, gerr: e.message }; }
};
const fvDay = async (uid, day) => {
  const cfg = await fvCfg();
  const visits = (await q(`SELECT v.*, to_char(v.day,'YYYY-MM-DD') AS day, (SELECT COALESCE(json_agg(json_build_object('id',m.id,'at',m.created_at) ORDER BY m.id),'[]') FROM fv_media m WHERE m.visit_id=v.id) photos
    FROM fv_visits v WHERE v.user_id=$1 AND v.day=$2 ORDER BY v.in_at`, [uid, day])).rows;
  const d = (await q(`SELECT * FROM fv_days WHERE user_id=$1 AND day=$2`, [uid, day])).rows[0] || null;
  const pts = await fvDayPts(uid, day);
  let prevT = d && d.started_at, prevP = d && d.start_lat != null ? { lat: d.start_lat, lng: d.start_lng } : null, total = 0, onSite = 0;
  let gerr = null;
  for (const v of visits) {
    if (prevT) { const L = await fvLegRoad(uid, cfg, pts, prevT, v.in_at, prevP, { lat: v.in_lat, lng: v.in_lng }, true); v.km_before = L.km; v.km_est = L.est; v.km_src = L.src; v.drive_min = L.mins || null; if (L.gerr) gerr = L.gerr; total += L.km; } else { v.km_before = 0; v.km_est = false; v.km_src = null; }
    if (v.out_at) { onSite += (new Date(v.out_at) - new Date(v.in_at)) / 60e3; prevT = v.out_at; prevP = { lat: v.out_lat ?? v.in_lat, lng: v.out_lng ?? v.in_lng }; }
    else { onSite += (Date.now() - new Date(v.in_at)) / 60e3; prevT = null; }
  }
  let after = 0, afterSrc = null;   // travel after the last check-out (to the office / home)
  const lastOut = visits.length && visits[visits.length - 1].out_at;
  if (lastOut) { const ended = d && d.ended_at, endT = ended || new Date().toISOString(), endP = d && d.end_lat != null ? { lat: d.end_lat, lng: d.end_lng } : null;
    const seg = pts.filter(p => new Date(p.at) >= new Date(lastOut) && new Date(p.at) <= new Date(endT));
    if (endP || seg.length > 1) { const L = await fvLegRoad(uid, cfg, pts, lastOut, ended || null, prevP, endP || seg[seg.length - 1], !!(ended && endP)); after = ended ? L.km : fvLeg(pts, lastOut, endT, prevP, seg[seg.length - 1] || endP).km; afterSrc = ended ? L.src : 'gps'; if (L.gerr) gerr = L.gerr; }
    total += after; }
  const open = visits.find(v => !v.out_at) || null, km = Math.round(total * 100) / 100;
  const rate = d && d.rate != null ? Number(d.rate) : fvRate(cfg, uid);
  const srcs = visits.map(v => v.km_src).concat(afterSrc).filter(Boolean);
  return { day, visits, open, started: d, km, km_after: after, km_after_src: afterSrc, on_site_min: Math.round(onSite), rate, amount: Math.round(km * rate * 100) / 100,
    google: !!cfg.key, src: srcs.length && srcs.every(x => x === 'google') ? 'google' : srcs.some(x => x === 'google') ? 'mixed' : srcs.length ? 'gps' : null, gerr,
    route: pts.filter(p => p.kind !== 'gps' || (p.acc || 0) <= 150).map(p => [p.lat, p.lng, p.kind]) };
};
const fvUid = (req) => { const want = +req.query.user || +((req.body || {}).user) || req.user.id; return fvSees(req.user, want) ? want : null; };
app.get('/api/fv/settings', superOnly, wrap(async (req, res) => {
  const c = await fvCfg(), env = !!process.env.GOOGLE_MAPS_API_KEY && !((await q(`SELECT v FROM settings WHERE k='fv_cfg'`)).rows[0] || {}).v?.includes('"key":"');
  const staff = (await q(`SELECT id, name FROM users WHERE active AND (role='Sales' OR 'field'=ANY(permissions)) ORDER BY name`)).rows;
  res.json({ has_key: !!c.key, key_tail: c.key ? '••••' + c.key.slice(-4) : '', from_env: env, mode: c.mode, rate: c.rate, rates: c.rates, staff });
}));
app.put('/api/fv/settings', superOnly, wrap(async (req, res) => {
  const b = req.body || {}, c = await fvCfg(); let saved = {}; try { saved = JSON.parse(((await q(`SELECT v FROM settings WHERE k='fv_cfg'`)).rows[0] || {}).v || '{}'); } catch (e) {}
  if (b.key !== undefined) { const k = String(b.key || '').trim(); if (k && !/^[\w-]{20,60}$/.test(k)) return res.status(400).json({ error: 'That does not look like a Google API key (starts with AIza…)' }); saved.key = k; }
  if (b.mode !== undefined) saved.mode = b.mode === 'DRIVE' ? 'DRIVE' : 'TWO_WHEELER';
  if (b.rate !== undefined) { const r = +b.rate; if (!(r >= 0 && r <= 1000)) return res.status(400).json({ error: 'Enter the rate per km (₹)' }); saved.rate = Math.round(r * 100) / 100; }
  if (b.rates && typeof b.rates === 'object') { saved.rates = {}; for (const [k, v] of Object.entries(b.rates)) if (+k && v !== '' && v !== null && +v >= 0 && +v <= 1000) saved.rates[+k] = Math.round(+v * 100) / 100; }
  await q(`INSERT INTO settings(k,v) VALUES('fv_cfg',$1) ON CONFLICT (k) DO UPDATE SET v=excluded.v`, [JSON.stringify(saved)]);
  res.json({ ok: true });
}));
app.post('/api/fv/settings/test', superOnly, wrap(async (req, res) => {   // Trichy Thillai Nagar → Chatram bus stand by road
  const c = await fvCfg(); if (!c.key) return res.status(400).json({ error: 'Add the Google Maps API key first' });
  try { const g = await fvGoogle(c, [{ lat: 10.8226, lng: 78.6839 }, { lat: 10.8318, lng: 78.6935 }]); res.json({ ok: true, km: g.km, mins: g.mins }); }
  catch (e) { res.status(400).json({ error: 'Google Maps: ' + e.message }); }
}));
app.post('/api/fv/recalc', superOnly, wrap(async (req, res) => {   // drop stored road km for a day so it is asked again (e.g. after adding the key)
  const uid = +(req.body || {}).user, day = (req.body || {}).date; if (!uid || !/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return res.status(400).json({ error: 'Choose the person and day' });
  await q(`DELETE FROM fv_legs WHERE user_id=$1 AND (t_from AT TIME ZONE '${TZ}')::date=$2`, [uid, day]); res.json({ ok: true, ...(await fvDay(uid, day)) });
}));
// ---- visits assigned from a lead by Super Admin / Admin / Sales Admin ----
const fvCanAssign = u => isSuper(u) || u.role === 'Admin' || can(u, 'field_team');
const fvPush = async (ids, title, body, link) => { for (const id of [...new Set(ids)].filter(Boolean)) { await q('INSERT INTO notifications(user_id,title,body,link) VALUES($1,$2,$3,$4)', [id, title, body, link]); pushTo(id, title, body, null, { url: '/?att=' + link, att: link, tag: 'gz-fv-' + Date.now() }).catch(() => {}); } };
const FVP_SEL = `SELECT fp.*, to_char(fp.plan_date,'YYYY-MM-DD') plan_date, u.name user_name, l.name lead_name, l.company lead_company, l.phone lead_phone, l.address lead_address, l.lat, l.lng, l.map_url, l.customer_id lead_customer_id
  FROM fv_plans fp JOIN users u ON u.id=fp.user_id LEFT JOIN leads l ON l.id=fp.lead_id`;
app.get('/api/fv/staff', need('leads', 'field_team'), wrap(async (req, res) => {   // who can be sent on a field visit
  if (!fvCanAssign(req.user)) return res.status(403).json({ error: 'Only Super Admin / Admin can assign field visits' });
  const p = []; let w = `u.active AND (u.role=$${p.push(SUPER) && p.length} OR 'field'=ANY(u.permissions))`;
  if (req.user.brand_id && !isSuper(req.user)) { p.push(req.user.brand_id); w += ` AND (u.brand_id IS NULL OR u.brand_id=$${p.length})`; }
  res.json((await q(`SELECT u.id, u.name, u.role, u.job_role, (SELECT COUNT(*)::int FROM fv_plans fp WHERE fp.user_id=u.id AND fp.status='planned') planned FROM users u WHERE ${w} AND u.role<>'${SUPER}' ORDER BY u.name`, p)).rows);
}));
app.post('/api/fv/plans', need('leads', 'field_team'), wrap(async (req, res) => {
  if (!fvCanAssign(req.user)) return res.status(403).json({ error: 'Only Super Admin / Admin can assign field visits' });
  const b = req.body || {}, lp = [+b.lead_id], sc = leadScope(req.user, lp);
  const l = (await q(`SELECT l.* FROM leads l WHERE l.id=$1 AND ${sc}`, lp)).rows[0]; if (!l) return res.status(404).json({ error: 'Lead not found' });
  const u = (await q(`SELECT id, name, permissions, active FROM users WHERE id=$1`, [+b.user_id])).rows[0];
  if (!u || !u.active || !(u.permissions || []).includes('field')) return res.status(400).json({ error: 'Choose a field sales person' });
  const day = /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : await todayIST();
  if (day < await todayIST()) return res.status(400).json({ error: 'Choose today or a later date' });
  const note = String(b.note || '').trim().slice(0, 1000) || null;
  const r = (await q(`INSERT INTO fv_plans(lead_id,customer_id,user_id,plan_date,note,by_id,by_name) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [l.id, l.customer_id || null, u.id, day, note, req.user.id, req.user.name])).rows[0];
  await leadLog(l.id, req.user.name, `📍 Field visit assigned to ${u.name} for ${day}${note ? ' — ' + note : ''}`);
  await fvPush([u.id], '📍 New field visit', `${l.company || l.name}${l.address ? ' · ' + l.address : ''} — ${day === await todayIST() ? 'today' : day}${note ? ' · ' + note : ''} (by ${req.user.name})`, 'fvp:' + r.id);
  res.json({ ok: true, id: r.id });
}));
app.get('/api/fv/plans', need('leads', 'field', 'field_team'), wrap(async (req, res) => {
  if (req.query.lead_id) { const lp = [+req.query.lead_id], sc = leadScope(req.user, lp); if (!(await q(`SELECT 1 FROM leads l WHERE l.id=$1 AND ${sc}`, lp)).rows.length) return res.status(404).json({ error: 'Lead not found' });
    return res.json({ items: (await q(`${FVP_SEL} WHERE fp.lead_id=$1 ORDER BY fp.id DESC`, [+req.query.lead_id])).rows, can_assign: fvCanAssign(req.user) }); }
  const uid = fvUid(req); if (!uid) return res.status(403).json({ error: 'Not allowed' });   // my planned visits (today, overdue and coming days)
  res.json({ items: (await q(`${FVP_SEL} WHERE fp.user_id=$1 AND fp.status='planned' ORDER BY fp.plan_date, fp.id LIMIT 100`, [uid])).rows });
}));
app.patch('/api/fv/plans/:id', need('leads', 'field', 'field_team'), wrap(async (req, res) => {   // cancel (assigner / boss) or move the date
  const pl = (await q(`SELECT * FROM fv_plans WHERE id=$1`, [+req.params.id])).rows[0]; if (!pl) return res.status(404).json({ error: 'Not found' });
  if (!fvCanAssign(req.user) && pl.by_id !== req.user.id) return res.status(403).json({ error: 'Not allowed' });
  if (pl.status !== 'planned') return res.status(400).json({ error: 'This visit is already ' + pl.status });
  const b = req.body || {};
  if (b.status === 'cancelled') { await q(`UPDATE fv_plans SET status='cancelled' WHERE id=$1`, [pl.id]); if (pl.lead_id) await leadLog(pl.lead_id, req.user.name, '📍 Field visit cancelled');
    await fvPush([pl.user_id], '📍 Field visit cancelled', `The visit planned for ${pl.plan_date.toISOString ? pl.plan_date.toISOString().slice(0, 10) : pl.plan_date} was cancelled by ${req.user.name}`, 'fvp:' + pl.id); }
  else if (/^\d{4}-\d{2}-\d{2}$/.test(b.date || '')) await q(`UPDATE fv_plans SET plan_date=$2 WHERE id=$1`, [pl.id, b.date]);
  res.json({ ok: true });
}));
// ---- Field Sales dashboard (Super Admin / Admin / Sales admin) ----
app.get('/api/fv/dashboard', need('field_team'), wrap(async (req, res) => {
  const today = await todayIST(), ok = x => /^\d{4}-\d{2}-\d{2}$/.test(x || '');
  const to = ok(req.query.to) ? req.query.to : today, from = ok(req.query.from) ? req.query.from : today.slice(0, 8) + '01';
  const bp = [], bw = req.user.brand_id && !isSuper(req.user) ? (bp.push(req.user.brand_id), `AND (u.brand_id IS NULL OR u.brand_id=$${bp.length})`) : '';
  const staff = (await q(`SELECT u.id, u.name, u.photo_v, u.job_role, u.role FROM users u WHERE u.active AND 'field'=ANY(u.permissions) AND u.role<>'${SUPER}' ${bw} ORDER BY u.name`, bp)).rows;
  const ids = staff.map(u => u.id), cfg = await fvCfg();
  const days = ids.length ? (await q(`SELECT DISTINCT user_id, to_char(day,'YYYY-MM-DD') AS d FROM (SELECT user_id, day FROM fv_visits WHERE day BETWEEN $1 AND $2 UNION SELECT user_id, day FROM fv_days WHERE day BETWEEN $1 AND $2 AND started_at IS NOT NULL) t WHERE user_id=ANY($3) ORDER BY 2`, [from, to, ids])).rows : [];
  const per = Object.fromEntries(staff.map(u => [u.id, { id: u.id, name: u.name, photo_v: u.photo_v, role: u.job_role || u.role, rate: fvRate(cfg, u.id), days: 0, visits: 0, km: 0, amount: 0, new_customers: 0, orders: 0, on_site_min: 0, planned: 0, overdue: 0, now: 'Not started', last: null }]));
  const outcomes = {}, todayLive = {};
  for (const r of days) { const d = await fvDay(r.user_id, r.d), x = per[r.user_id]; if (!x) continue;
    x.days++; x.visits += d.visits.length; x.km += d.km; x.amount += d.amount; x.on_site_min += d.on_site_min; x.new_customers += d.visits.filter(v => v.is_new).length; x.orders += d.visits.filter(v => v.outcome === 'Order confirmed').length;
    d.visits.forEach(v => { if (v.outcome) outcomes[v.outcome] = (outcomes[v.outcome] || 0) + 1; });
    if (r.d === today) todayLive[r.user_id] = d; }
  // live status today + last known position
  const lastPts = ids.length ? (await q(`SELECT DISTINCT ON (user_id) user_id, lat, lng, at, kind FROM fv_track WHERE day=$1 AND user_id=ANY($2) ORDER BY user_id, at DESC`, [today, ids])).rows : [];
  for (const p of lastPts) if (per[p.user_id]) per[p.user_id].last = { lat: p.lat, lng: p.lng, at: p.at };
  for (const u of staff) { const d = todayLive[u.id] || (ok(today) && !days.some(r => r.user_id === u.id && r.d === today) ? null : null), x = per[u.id];
    if (!d) { x.now = 'Not started'; continue; }
    x.today = { visits: d.visits.length, km: d.km };
    x.now = d.open ? 'At ' + (d.open.cust_company || d.open.cust_name || 'a site') : d.started && d.started.ended_at ? 'Day ended' : 'Travelling'; x.now_since = d.open ? d.open.in_at : null; }
  const pl = ids.length ? (await q(`${FVP_SEL} WHERE fp.user_id=ANY($1) AND fp.status='planned' ORDER BY fp.plan_date, fp.id LIMIT 200`, [ids])).rows : [];
  pl.forEach(p => { const x = per[p.user_id]; if (x) { x.planned++; if (p.plan_date < today) x.overdue++; } });
  const doneP = ids.length ? +(await q(`SELECT COUNT(*) n FROM fv_plans WHERE user_id=ANY($1) AND status='done' AND done_at::date BETWEEN $2 AND $3`, [ids, from, to])).rows[0].n : 0;
  const recent = ids.length ? (await q(`SELECT v.id, v.user_id, v.user_name, to_char(v.day,'YYYY-MM-DD') AS day, v.in_at, v.out_at, v.cust_name, v.cust_company, v.is_new, v.purpose, v.outcome, v.notes, v.lead_id,
      (SELECT MIN(m.id) FROM fv_media m WHERE m.visit_id=v.id) photo, (SELECT COUNT(*)::int FROM fv_media m WHERE m.visit_id=v.id) photos
    FROM fv_visits v WHERE v.user_id=ANY($1) AND v.day BETWEEN $2 AND $3 ORDER BY v.in_at DESC LIMIT 20`, [ids, from, to])).rows : [];
  const people = Object.values(per).map(x => ({ ...x, km: Math.round(x.km * 100) / 100, amount: Math.round(x.amount * 100) / 100 }));
  const sum = k => Math.round(people.reduce((t, x) => t + (x[k] || 0), 0) * 100) / 100;
  res.json({ from, to, today, google: !!cfg.key, rate: cfg.rate,
    totals: { staff: staff.length, active_today: people.filter(x => x.now !== 'Not started').length, on_site_now: people.filter(x => /^At /.test(x.now)).length, visits: sum('visits'), km: sum('km'), amount: sum('amount'), new_customers: sum('new_customers'), orders: sum('orders'), planned: pl.length, overdue: pl.filter(p => p.plan_date < today).length, plans_done: doneP },
    people: people.sort((a, b) => b.visits - a.visits || b.km - a.km), outcomes: Object.entries(outcomes).sort((a, b) => b[1] - a[1]), planned: pl.slice(0, 50), recent });
}));
app.get('/api/fv/meta', need('field', 'field_team'), wrap(async (req, res) => {
  const staff = can(req.user, 'field_team') || isSuper(req.user) ? (await q(`SELECT id, name, role, brand_id FROM users WHERE active AND (role=$1 OR 'field'=ANY(permissions)) ORDER BY name`, [SUPER])).rows.filter(u => u.role !== SUPER || u.id === req.user.id) : [];
  res.json({ purposes: FV_PURPOSE, outcomes: FV_OUTCOME, staff, today: (await todayIST()), me: req.user.id, team: can(req.user, 'field_team') || isSuper(req.user) });
}));
app.get('/api/fv/day', need('field', 'field_team'), wrap(async (req, res) => {
  const uid = fvUid(req); if (!uid) return res.status(403).json({ error: 'Not allowed' });
  const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : (await todayIST());
  const u = (await q('SELECT id, name FROM users WHERE id=$1', [uid])).rows[0];
  res.json({ user: u, ...(await fvDay(uid, day)) });
}));
app.post('/api/fv/start', need('field'), wrap(async (req, res) => {   // start the field day (from home / office)
  const pt = fvPoint(req.body || {}); if (!pt) return res.status(400).json({ error: 'Location needed — turn on GPS' });
  const day = (await todayIST());
  await q(`INSERT INTO fv_days(user_id,day,started_at,start_lat,start_lng) VALUES($1,$2,now(),$3,$4) ON CONFLICT (user_id,day) DO UPDATE SET started_at=COALESCE(fv_days.started_at,now()), start_lat=COALESCE(fv_days.start_lat,$3), start_lng=COALESCE(fv_days.start_lng,$4), ended_at=NULL`, [req.user.id, day, pt.lat, pt.lng]);
  await q(`INSERT INTO fv_track(user_id,day,at,lat,lng,acc,kind) VALUES($1,$2,now(),$3,$4,$5,'start')`, [req.user.id, day, pt.lat, pt.lng, pt.acc]);
  res.json({ ok: true });
}));
app.post('/api/fv/end', need('field'), wrap(async (req, res) => {
  const day = (await todayIST()), pt = fvPoint(req.body || {});
  if ((await q(`SELECT 1 FROM fv_visits WHERE user_id=$1 AND out_at IS NULL`, [req.user.id])).rows.length) return res.status(400).json({ error: 'Check out of the current visit first' });
  await q(`INSERT INTO fv_days(user_id,day,started_at,ended_at,end_lat,end_lng) VALUES($1,$2,now(),now(),$3,$4) ON CONFLICT (user_id,day) DO UPDATE SET ended_at=now(), end_lat=$3, end_lng=$4`, [req.user.id, day, pt ? pt.lat : null, pt ? pt.lng : null]);
  await q(`UPDATE fv_days SET rate=$3 WHERE user_id=$1 AND day=$2`, [req.user.id, day, fvRate(await fvCfg(), req.user.id)]);   // the ₹/km on the day it ended stays for that day
  if (pt) await q(`INSERT INTO fv_track(user_id,day,at,lat,lng,acc,kind) VALUES($1,$2,now(),$3,$4,$5,'end')`, [req.user.id, day, pt.lat, pt.lng, pt.acc]);
  res.json({ ok: true });
}));
app.post('/api/fv/track', need('field'), wrap(async (req, res) => {   // GPS points sent by the phone while travelling
  const day = (await todayIST()), d = (await q(`SELECT started_at, ended_at FROM fv_days WHERE user_id=$1 AND day=$2`, [req.user.id, day])).rows[0];
  const onDuty = (d && d.started_at && !d.ended_at) || (await q(`SELECT 1 FROM fv_visits WHERE user_id=$1 AND day=$2 LIMIT 1`, [req.user.id, day])).rows.length;
  if (!onDuty || (d && d.ended_at)) return res.json({ ok: true, saved: 0, off: true });
  const last = (await q(`SELECT at FROM fv_track WHERE user_id=$1 AND day=$2 ORDER BY at DESC LIMIT 1`, [req.user.id, day])).rows[0];
  let lastT = last ? new Date(last.at).getTime() : 0, n = 0;
  const pts = (Array.isArray((req.body || {}).points) ? req.body.points : []).slice(0, 500).sort((a, b) => (+a.t || 0) - (+b.t || 0));
  for (const x of pts) { const pt = fvPoint(x), t = +x.t || Date.now(); if (!pt || t < lastT + 20000 || t > Date.now() + 60000 || t < Date.now() - 18 * 3600e3) continue;
    await q(`INSERT INTO fv_track(user_id,day,at,lat,lng,acc) VALUES($1,$2,to_timestamp($3/1000.0),$4,$5,$6)`, [req.user.id, day, t, pt.lat, pt.lng, pt.acc]); lastT = t; n++; }
  res.json({ ok: true, saved: n });
}));
// customers for the check-in box: name / phone / company, with how many times we visited
app.get('/api/fv/customers', need('field', 'field_team'), wrap(async (req, res) => {
  const v = String(req.query.q || '').trim(); if (v.length < 2) return res.json([]);
  const p = ['%' + v + '%'], dg = digits(v), sc = custScope(req.user, p); let ph = '';
  if (dg.length >= 4) { p.push('%' + dg.slice(-10) + '%'); ph = ` OR regexp_replace(COALESCE(c.phone,''),'\\D','','g') LIKE $${p.length}`; }
  const rows = (await q(`SELECT c.id, c.name, c.company, c.phone, c.address, c.city, (SELECT COUNT(*)::int FROM fv_visits f WHERE f.customer_id=c.id) visits, (SELECT to_char(MAX(f.day),'YYYY-MM-DD') FROM fv_visits f WHERE f.customer_id=c.id) last_visit
    FROM customers c WHERE (c.name ILIKE $1 OR c.company ILIKE $1${ph}) AND ${sc} ORDER BY lower(c.name) LIMIT 12`, p)).rows;
  res.json(rows);
}));
app.get('/api/fv/customer/:id', need('field', 'field_team'), wrap(async (req, res) => {   // old customer: details + earlier visits
  const p = [+req.params.id], sc = custScope(req.user, p);
  const c = (await q(`SELECT c.id, c.name, c.company, c.phone, c.address, c.city FROM customers c WHERE c.id=$1 AND ${sc}`, p)).rows[0];
  if (!c) return res.status(404).json({ error: 'Customer not found' });
  c.visits = (await q(`SELECT id, to_char(day,'YYYY-MM-DD') AS day, user_name, purpose, outcome, notes FROM fv_visits WHERE customer_id=$1 ORDER BY in_at DESC LIMIT 5`, [c.id])).rows;
  c.services = (await q(`SELECT COUNT(*)::int n FROM services WHERE customer_id=$1`, [c.id])).rows[0].n;
  res.json(c);
}));
const fvPhoto = async (visitId, b) => {
  const m = /^data:(image\/[\w+.-]+);base64,(.+)$/.exec(String(b.photo || '')); if (!m) return 'Photo must be an image';
  const buf = Buffer.from(m[2], 'base64'); if (buf.length > 3e6) return 'Photo is too big';
  const pt = fvPoint(b) || {}; await q(`INSERT INTO fv_media(visit_id,data,mime,lat,lng) VALUES($1,$2,$3,$4,$5)`, [visitId, buf, m[1], pt.lat ?? null, pt.lng ?? null]); return null;
};
app.post('/api/fv/checkin', need('field'), wrap(async (req, res) => {
  const b = req.body || {}, pt = fvPoint(b); if (!pt) return res.status(400).json({ error: 'Location needed — turn on GPS and allow location' });
  if ((await q(`SELECT 1 FROM fv_visits WHERE user_id=$1 AND out_at IS NULL`, [req.user.id])).rows.length) return res.status(400).json({ error: 'You are still checked in at another place — check out there first' });
  let c = null, plan = null;
  if (+b.plan_id) { plan = (await q(`${FVP_SEL} WHERE fp.id=$1`, [+b.plan_id])).rows[0];
    if (!plan || plan.user_id !== req.user.id || plan.status !== 'planned') return res.status(400).json({ error: 'This planned visit is not open for you' });
    if (!b.customer_id && plan.lead_customer_id) b.customer_id = plan.lead_customer_id;
    if (!b.customer_id && !b.cust) b.cust = { name: plan.lead_name, company: plan.lead_company, phone: plan.lead_phone, address: plan.lead_address }; }
  if (+b.customer_id) { const pp = [+b.customer_id], sc = +b.plan_id ? 'true' : custScope(req.user, pp); c = (await q(`SELECT c.* FROM customers c WHERE c.id=$1 AND ${sc}`, pp)).rows[0]; if (!c) return res.status(404).json({ error: 'Customer not found' }); }
  const n = b.cust || {}, t = (k, l = 200) => String(n[k] || '').trim().slice(0, l) || null;
  const pending = !c && !t('name') && !t('company');   // nothing asked at check-in: customer, purpose, photos and notes come at check-out
  if (!c && t('phone') && digits(t('phone')).length >= 7) {   // typed a phone that is already a customer → use that customer
    const ex = (await q(`SELECT * FROM customers WHERE right(regexp_replace(COALESCE(phone,''),'\\D','','g'),10)=$1 LIMIT 1`, [digits(t('phone')).slice(-10)])).rows[0]; if (ex) c = ex; }
  const day = (await todayIST());
  await q(`INSERT INTO fv_days(user_id,day,started_at,start_lat,start_lng) VALUES($1,$2,NULL,NULL,NULL) ON CONFLICT DO NOTHING`, [req.user.id, day]);
  await q(`UPDATE fv_days SET ended_at=NULL WHERE user_id=$1 AND day=$2`, [req.user.id, day]);
  const r = (await q(`INSERT INTO fv_visits(user_id,user_name,brand_id,day,customer_id,is_new,cust_name,cust_company,cust_phone,cust_address,purpose,notes,in_lat,in_lng,in_acc,cust_pending)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
  [req.user.id, req.user.name, req.user.brand_id || (c && c.brand_id) || null, day, c ? c.id : null, !c && !pending, c ? c.name : t('name') || t('company'), c ? c.company : t('company'), c ? c.phone : t('phone', 30), c ? c.address : t('address', 500),
    FV_PURPOSE.includes(b.purpose) ? b.purpose : (pending ? null : 'Sales visit'), String(b.notes || '').slice(0, 4000) || null, pt.lat, pt.lng, pt.acc, pending])).rows[0];
  await q(`INSERT INTO fv_track(user_id,day,at,lat,lng,acc,kind) VALUES($1,$2,now(),$3,$4,$5,'in')`, [req.user.id, day, pt.lat, pt.lng, pt.acc]);
  if (plan) { await q(`UPDATE fv_visits SET plan_id=$2, lead_id=$3 WHERE id=$1`, [r.id, plan.id, plan.lead_id]); await q(`UPDATE fv_plans SET visit_id=$2 WHERE id=$1`, [plan.id, r.id]);
    if (plan.lead_id) await leadLog(plan.lead_id, req.user.name, `📍 Reached the site (field visit) at ${new Date().toLocaleTimeString('en-IN', { timeZone: TZ, hour: 'numeric', minute: '2-digit' })}`); }
  if (b.photo) { const e = await fvPhoto(r.id, b); if (e) return res.status(400).json({ error: e }); }
  res.json({ ok: true, id: r.id, old_customer: !!c, customer_id: c ? c.id : null, pending });
}));
const fvOwn = async (req, res) => {
  const v = (await q(`SELECT * FROM fv_visits WHERE id=$1`, [+req.params.id])).rows[0];
  if (!v) { res.status(404).json({ error: 'Visit not found' }); return null; }
  if (v.user_id !== req.user.id && !isSuper(req.user)) { res.status(403).json({ error: 'Not your visit' }); return null; }
  return v;
};
app.post('/api/fv/:id/photo', need('field'), wrap(async (req, res) => {
  const v = await fvOwn(req, res); if (!v) return;
  if ((await q(`SELECT COUNT(*)::int n FROM fv_media WHERE visit_id=$1`, [v.id])).rows[0].n >= 20) return res.status(400).json({ error: 'Up to 20 photos per visit' });
  const e = await fvPhoto(v.id, req.body || {}); if (e) return res.status(400).json({ error: e }); res.json({ ok: true });
}));
app.delete('/api/fv/photo/:pid', need('field'), wrap(async (req, res) => {
  const m = (await q(`SELECT m.id, v.user_id, v.out_at FROM fv_media m JOIN fv_visits v ON v.id=m.visit_id WHERE m.id=$1`, [+req.params.pid])).rows[0];
  if (!m || (m.user_id !== req.user.id && !isSuper(req.user))) return res.status(404).json({ error: 'Not found' });
  await q('DELETE FROM fv_media WHERE id=$1', [m.id]); res.json({ ok: true });
}));
app.patch('/api/fv/:id', need('field'), wrap(async (req, res) => {   // notes / purpose / new-customer details while there (or the same day)
  const v = await fvOwn(req, res); if (!v) return;
  const b = req.body || {}, o = {};
  if (b.notes !== undefined) o.notes = String(b.notes || '').slice(0, 4000) || null;
  if (b.purpose !== undefined && FV_PURPOSE.includes(b.purpose)) o.purpose = b.purpose;
  if (v.is_new) for (const [k, f] of [['name', 'cust_name'], ['company', 'cust_company'], ['phone', 'cust_phone'], ['address', 'cust_address']]) if (b[k] !== undefined) o[f] = String(b[k] || '').trim().slice(0, 500) || null;
  const ks = Object.keys(o); if (ks.length) await q(`UPDATE fv_visits SET ${ks.map((k, i) => `${k}=$${i + 2}`).join(',')} WHERE id=$1`, [v.id, ...ks.map(k => o[k])]);
  res.json({ ok: true });
}));
app.post('/api/fv/:id/checkout', need('field'), wrap(async (req, res) => {
  const v = await fvOwn(req, res); if (!v) return; if (v.out_at) return res.status(400).json({ error: 'Already checked out' });
  const b = req.body || {}, pt = fvPoint(b); if (!pt) return res.status(400).json({ error: 'Location needed — turn on GPS' });
  const notes = String(b.notes ?? v.notes ?? '').trim(); if (!notes) return res.status(400).json({ error: 'Write what happened at this visit (description)' });
  const outcome = FV_OUTCOME.includes(b.outcome) ? b.outcome : null; if (!outcome) return res.status(400).json({ error: 'Choose how the visit went' });
  const fu = /^\d{4}-\d{2}-\d{2}$/.test(b.follow_up) ? b.follow_up : null;
  if (v.cust_pending) {   // the customer is chosen at check-out
    let c = null; const n = b.cust || {}, t = (k, l = 200) => String(n[k] || '').trim().slice(0, l) || null;
    if (+b.customer_id) { const pp = [+b.customer_id], sc = custScope(req.user, pp); c = (await q(`SELECT c.* FROM customers c WHERE c.id=$1 AND ${sc}`, pp)).rows[0]; if (!c) return res.status(404).json({ error: 'Customer not found' }); }
    else if (!t('name') && !t('company')) return res.status(400).json({ error: 'Choose the old customer or type the new customer’s name' });
    if (!c && t('phone') && digits(t('phone')).length >= 7) { const ex = (await q(`SELECT * FROM customers WHERE right(regexp_replace(COALESCE(phone,''),'\\D','','g'),10)=$1 LIMIT 1`, [digits(t('phone')).slice(-10)])).rows[0]; if (ex) c = ex; }
    await q(`UPDATE fv_visits SET cust_pending=false, customer_id=$2, is_new=$3, cust_name=$4, cust_company=$5, cust_phone=$6, cust_address=$7, brand_id=COALESCE(brand_id,$8) WHERE id=$1`,
      [v.id, c ? c.id : null, !c, c ? c.name : t('name') || t('company'), c ? c.company : t('company'), c ? c.phone : t('phone', 30), c ? c.address : t('address', 500), c ? c.brand_id : null]);
    Object.assign(v, (await q(`SELECT * FROM fv_visits WHERE id=$1`, [v.id])).rows[0]);
  }
  if (FV_PURPOSE.includes(b.purpose) || !v.purpose) { v.purpose = FV_PURPOSE.includes(b.purpose) ? b.purpose : 'Sales visit'; await q(`UPDATE fv_visits SET purpose=$2 WHERE id=$1`, [v.id, v.purpose]); }
  let custId = v.customer_id, leadId = null;
  if (v.is_new && !custId) {   // save the new customer (and a lead, if asked)
    const n = { name: String(b.name ?? v.cust_name ?? '').trim() || v.cust_company || 'Customer', company: String(b.company ?? v.cust_company ?? '').trim() || null, phone: String(b.phone ?? v.cust_phone ?? '').trim() || null, address: String(b.address ?? v.cust_address ?? '').trim() || null };
    const ex = n.phone && digits(n.phone).length >= 7 ? (await q(`SELECT id FROM customers WHERE right(regexp_replace(COALESCE(phone,''),'\\D','','g'),10)=$1 LIMIT 1`, [digits(n.phone).slice(-10)])).rows[0] : null;
    custId = ex ? ex.id : (await q(`INSERT INTO customers(name,company,phone,address,brand_id) VALUES($1,$2,$3,$4,$5) RETURNING id`, [n.name, n.company, n.phone, n.address, v.brand_id || req.user.brand_id || await blDefBrand(req.user)])).rows[0].id;
    await q(`UPDATE fv_visits SET cust_name=$2, cust_company=$3, cust_phone=$4, cust_address=$5 WHERE id=$1`, [v.id, n.name, n.company, n.phone, n.address]);
    if (v.lead_id) await q(`UPDATE leads SET customer_id=COALESCE(customer_id,$2) WHERE id=$1`, [v.lead_id, custId]);
    else if (b.add_lead !== false) {
      leadId = await insLead({ name: n.name, company: n.company, phone: n.phone, address: n.address, source: 'Field visit', notes, follow_up: fu, assigned_to: req.user.id, stage: 'New Enquiry' }, req.user.id, v.brand_id || req.user.brand_id || await blDefBrand(req.user));
      await q(`UPDATE leads SET customer_id=$2, lat=$3, lng=$4, location_by=$5, location_on=now() WHERE id=$1`, [leadId, custId, v.in_lat, v.in_lng, req.user.name]);
      await leadLog(leadId, req.user.name, `📍 Field visit (${v.purpose}) — ${outcome}: ${notes}`);
    }
  }
  await q(`UPDATE fv_visits SET out_at=now(), out_lat=$2, out_lng=$3, out_acc=$4, notes=$5, outcome=$6, follow_up=$7, customer_id=$8, lead_id=COALESCE($9,lead_id) WHERE id=$1`, [v.id, pt.lat, pt.lng, pt.acc, notes.slice(0, 4000), outcome, fu, custId, leadId]);
  await q(`INSERT INTO fv_track(user_id,day,at,lat,lng,acc,kind) VALUES($1,$2,now(),$3,$4,$5,'out')`, [v.user_id, v.day, pt.lat, pt.lng, pt.acc]);
  const mins = Math.round((Date.now() - new Date(v.in_at)) / 60e3);
  if (v.lead_id && !leadId) await leadLog(v.lead_id, req.user.name, `📍 Field visit done (${mins} min) — ${outcome}: ${notes.slice(0, 500)}${fu ? ' · follow-up ' + fu : ''}`);
  if (v.plan_id) { const pl = (await q(`UPDATE fv_plans SET status='done', done_at=now() WHERE id=$1 RETURNING by_id`, [v.plan_id])).rows[0];
    if (pl && pl.by_id && pl.by_id !== req.user.id) await fvPush([pl.by_id], '✅ Field visit done', `${req.user.name} visited ${v.cust_company || v.cust_name || ''} — ${outcome}: ${notes.slice(0, 120)}`, 'leadchat:' + v.lead_id); }
  res.json({ ok: true, minutes: mins, customer_id: custId, lead_id: leadId || v.lead_id });
}));
app.get('/api/fv/media/:pid', need('field', 'field_team'), wrap(async (req, res) => {
  const m = (await q(`SELECT m.data, m.mime, v.user_id FROM fv_media m JOIN fv_visits v ON v.id=m.visit_id WHERE m.id=$1`, [+req.params.pid])).rows[0];
  if (!m || !fvSees(req.user, m.user_id)) return res.status(404).end();
  res.setHeader('Content-Type', m.mime || 'image/jpeg'); res.setHeader('Cache-Control', 'private, max-age=86400'); res.end(m.data);
}));
// the whole team for one day (or a date range per person)
app.get('/api/fv/team', need('field_team'), wrap(async (req, res) => {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : (await todayIST());
  const users = (await q(`SELECT DISTINCT u.id, u.name, u.photo_v FROM users u WHERE u.active AND (EXISTS (SELECT 1 FROM fv_visits v WHERE v.user_id=u.id AND v.day=$1) OR EXISTS (SELECT 1 FROM fv_days d WHERE d.user_id=u.id AND d.day=$1 AND d.started_at IS NOT NULL)) ORDER BY u.name`, [day])).rows;
  const out = [];
  for (const u of users) { const d = await fvDay(u.id, day); out.push({ id: u.id, name: u.name, photo_v: u.photo_v, visits: d.visits.length, km: d.km, rate: d.rate, amount: d.amount, src: d.src, on_site_min: d.on_site_min, first_in: d.visits[0] ? d.visits[0].in_at : null, last_out: d.visits.length ? d.visits[d.visits.length - 1].out_at : null, now: d.open ? 'At ' + (d.open.cust_company || d.open.cust_name) : d.started && d.started.ended_at ? 'Day ended' : 'Travelling', new_customers: d.visits.filter(v => v.is_new).length }); }
  res.json({ day, staff: out, total_km: Math.round(out.reduce((t, x) => t + x.km, 0) * 100) / 100, total_visits: out.reduce((t, x) => t + x.visits, 0), total_amount: Math.round(out.reduce((t, x) => t + x.amount, 0) * 100) / 100 });
}));
app.get('/api/fv/report', need('field', 'field_team'), wrap(async (req, res) => {   // per day km & visits for one person over a range
  const uid = fvUid(req); if (!uid) return res.status(403).json({ error: 'Not allowed' });
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : (await todayIST()), from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : to.slice(0, 8) + '01';
  const days = (await q(`SELECT DISTINCT to_char(day,'YYYY-MM-DD') d FROM (SELECT day FROM fv_visits WHERE user_id=$1 AND day BETWEEN $2 AND $3 UNION SELECT day FROM fv_days WHERE user_id=$1 AND day BETWEEN $2 AND $3 AND started_at IS NOT NULL) t ORDER BY 1 DESC`, [uid, from, to])).rows.map(r => r.d);
  const rows = []; for (const d of days.slice(0, 62)) { const x = await fvDay(uid, d); rows.push({ day: d, visits: x.visits.length, km: x.km, rate: x.rate, amount: x.amount, src: x.src, on_site_min: x.on_site_min, new_customers: x.visits.filter(v => v.is_new).length }); }
  res.json({ from, to, rows, km: Math.round(rows.reduce((t, r) => t + r.km, 0) * 100) / 100, visits: rows.reduce((t, r) => t + r.visits, 0), amount: Math.round(rows.reduce((t, r) => t + r.amount, 0) * 100) / 100 });
}));

// ===================== BILLING (Swipe-style): quotations, invoices, proforma, challans, credit notes, purchases, stock, expenses =====================
const ExcelJS = require('exceljs');
const BL_STATES = [['01','Jammu and Kashmir'],['02','Himachal Pradesh'],['03','Punjab'],['04','Chandigarh'],['05','Uttarakhand'],['06','Haryana'],['07','Delhi'],['08','Rajasthan'],['09','Uttar Pradesh'],['10','Bihar'],['11','Sikkim'],['12','Arunachal Pradesh'],['13','Nagaland'],['14','Manipur'],['15','Mizoram'],['16','Tripura'],['17','Meghalaya'],['18','Assam'],['19','West Bengal'],['20','Jharkhand'],['21','Odisha'],['22','Chhattisgarh'],['23','Madhya Pradesh'],['24','Gujarat'],['26','Dadra and Nagar Haveli and Daman and Diu'],['27','Maharashtra'],['29','Karnataka'],['30','Goa'],['31','Lakshadweep'],['32','Kerala'],['33','Tamil Nadu'],['34','Puducherry'],['35','Andaman and Nicobar Islands'],['36','Telangana'],['37','Andhra Pradesh'],['38','Ladakh'],['97','Other Territory']];
const BL_ABBR = { JK: '01', HP: '02', PB: '03', CH: '04', UK: '05', UT: '05', HR: '06', DL: '07', RJ: '08', UP: '09', BR: '10', SK: '11', AR: '12', NL: '13', MN: '14', MZ: '15', TR: '16', ML: '17', AS: '18', WB: '19', JH: '20', OD: '21', OR: '21', CG: '22', CT: '22', MP: '23', GJ: '24', DN: '26', DD: '26', MH: '27', KA: '29', GA: '30', LD: '31', KL: '32', TN: '33', PY: '34', AN: '35', TS: '36', TG: '36', AP: '37', LA: '38' };
const blState = v => {            // "33-Tamil Nadu", "TN", "tamil nadu", "33" → "Tamil Nadu"
  const s = String(v || '').trim(); if (!s) return null;
  const n = s.toLowerCase().replace(/^\d+\s*[-–:]?\s*/, '').replace(/[^a-z ]/g, '').trim();
  let f = BL_STATES.find(x => x[1].toLowerCase().replace(/[^a-z ]/g, '') === n); if (f) return f[1];
  const code = (/^(\d{2})/.exec(s) || [])[1] || BL_ABBR[s.toUpperCase()]; f = code && BL_STATES.find(x => x[0] === code); if (f) return f[1];
  f = n.length > 3 && BL_STATES.find(x => x[1].toLowerCase().startsWith(n)); return f ? f[1] : null;
};
const blStateCode = st => (BL_STATES.find(x => x[1] === st) || [''])[0];
const BL_TYPES = {
  quotation: { l: 'Quotation', p: 'QT-', party: 'customer' }, invoice: { l: 'Tax Invoice', p: 'INV-', party: 'customer' },
  proforma: { l: 'Proforma Invoice', p: 'PI-', party: 'customer' }, challan: { l: 'Delivery Challan', p: 'DC-', party: 'customer' },
  credit_note: { l: 'Credit Note', p: 'CN-', party: 'customer' }, purchase: { l: 'Purchase', p: 'PUR-', party: 'vendor' },
};
const BL_MODES = ['Cash', 'UPI', 'Bank', 'Cheque', 'Card'];
const BL_UNITS = ['Nos', 'Pcs', 'Set', 'Box', 'Mtr', 'Kg', 'Ltr', 'Hrs', 'Days', 'Job', 'Pair', 'Roll', 'Unit'];
const BL_TAXES = [0, 0.25, 3, 5, 12, 18, 28];
const BL_EXP_CATS = ['Rent', 'Salary', 'Electricity', 'Internet & phone', 'Travel & fuel', 'Office', 'Repairs', 'Marketing', 'Tools & materials', 'Other'];
const br2 = v => Math.round((Number(v) || 0) * 100) / 100;
const blNeed = need('billing'), blBuy = need('purchases');
const blTypeNeed = t => t === 'purchase' ? 'purchases' : 'billing';

async function initBL() {
  await q(`
  CREATE TABLE IF NOT EXISTS bl_brand (brand_id INT PRIMARY KEY, legal_name TEXT, gstin TEXT, state TEXT, address TEXT, phone TEXT, email TEXT, website TEXT,
    bank_name TEXT, bank_account TEXT, bank_ifsc TEXT, bank_branch TEXT, upi TEXT, terms TEXT, notes TEXT, color TEXT DEFAULT '#1f6f5c', template TEXT DEFAULT 'modern',
    default_tax NUMERIC(5,2) DEFAULT 18, round_off BOOLEAN DEFAULT true, prefixes JSONB DEFAULT '{}', next_no JSONB DEFAULT '{}', logo BYTEA, logo_mime TEXT, sign_name TEXT, updated_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS bl_products (id SERIAL PRIMARY KEY, name TEXT NOT NULL, sku TEXT, hsn TEXT, unit TEXT DEFAULT 'Nos', kind TEXT DEFAULT 'product', price NUMERIC(14,2) DEFAULT 0,
    price_incl BOOLEAN DEFAULT false, purchase_price NUMERIC(14,2) DEFAULT 0, tax NUMERIC(5,2) DEFAULT 18, category TEXT, description TEXT, stock NUMERIC(14,3) DEFAULT 0,
    low_stock NUMERIC(14,3) DEFAULT 0, active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
  CREATE INDEX IF NOT EXISTS idx_blp_name ON bl_products(lower(name));
  CREATE TABLE IF NOT EXISTS bl_vendors (id SERIAL PRIMARY KEY, name TEXT NOT NULL, company TEXT, phone TEXT, email TEXT, gstin TEXT, state TEXT, address TEXT, opening_bal NUMERIC(14,2) DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now());
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS gstin TEXT;
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS state TEXT;
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS pincode TEXT;
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS ship_address TEXT;
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS ship_name TEXT;
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS ship_phone TEXT;
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS ship_city TEXT;
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS ship_pincode TEXT;
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS ship_state TEXT;
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS opening_bal NUMERIC(14,2) DEFAULT 0;
  CREATE TABLE IF NOT EXISTS bl_docs (id SERIAL PRIMARY KEY, type TEXT NOT NULL, brand_id INT, no TEXT, seq INT, doc_date DATE DEFAULT CURRENT_DATE, due_date DATE,
    customer_id INT, vendor_id INT, party JSONB DEFAULT '{}', pos TEXT, inter BOOLEAN DEFAULT false, items JSONB DEFAULT '[]', sub NUMERIC(14,2) DEFAULT 0, line_disc NUMERIC(14,2) DEFAULT 0,
    tax_total NUMERIC(14,2) DEFAULT 0, cgst NUMERIC(14,2) DEFAULT 0, sgst NUMERIC(14,2) DEFAULT 0, igst NUMERIC(14,2) DEFAULT 0, charges NUMERIC(14,2) DEFAULT 0, charges_label TEXT,
    extra_disc NUMERIC(14,2) DEFAULT 0, round_off NUMERIC(8,2) DEFAULT 0, total NUMERIC(14,2) DEFAULT 0, paid NUMERIC(14,2) DEFAULT 0, credited NUMERIC(14,2) DEFAULT 0,
    status TEXT, notes TEXT, terms TEXT, ref_id INT, ref_no TEXT, against_id INT, lead_id INT, service_id INT, share_token TEXT, template TEXT,
    created_by INT, created_by_name TEXT, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
  CREATE INDEX IF NOT EXISTS idx_bld_type ON bl_docs(type, doc_date DESC);
  CREATE INDEX IF NOT EXISTS idx_bld_cust ON bl_docs(customer_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_bld_share ON bl_docs(share_token);
  CREATE TABLE IF NOT EXISTS bl_payments (id SERIAL PRIMARY KEY, doc_id INT REFERENCES bl_docs(id) ON DELETE CASCADE, amount NUMERIC(14,2) NOT NULL, mode TEXT, account TEXT,
    pay_date DATE DEFAULT CURRENT_DATE, note TEXT, by_name TEXT, created_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS bl_stock (id SERIAL PRIMARY KEY, product_id INT REFERENCES bl_products(id) ON DELETE CASCADE, qty NUMERIC(14,3) NOT NULL, kind TEXT, doc_id INT, note TEXT, by_name TEXT, created_at TIMESTAMPTZ DEFAULT now());
  CREATE INDEX IF NOT EXISTS idx_bls_prod ON bl_stock(product_id, id DESC);
  CREATE TABLE IF NOT EXISTS bl_expenses (id SERIAL PRIMARY KEY, brand_id INT, category TEXT, amount NUMERIC(14,2) NOT NULL, tax NUMERIC(14,2) DEFAULT 0, exp_date DATE DEFAULT CURRENT_DATE,
    mode TEXT, paid_to TEXT, note TEXT, by_name TEXT, created_at TIMESTAMPTZ DEFAULT now());
  ALTER TABLE bl_brand ADD COLUMN IF NOT EXISTS banks JSONB DEFAULT '[]';
  ALTER TABLE bl_brand ADD COLUMN IF NOT EXISTS seal BYTEA;
  ALTER TABLE bl_brand ADD COLUMN IF NOT EXISTS seal_mime TEXT;
  ALTER TABLE bl_brand ADD COLUMN IF NOT EXISTS sign BYTEA;
  ALTER TABLE bl_brand ADD COLUMN IF NOT EXISTS sign_mime TEXT;
  ALTER TABLE bl_products ADD COLUMN IF NOT EXISTS purchase_incl BOOLEAN DEFAULT false;
  ALTER TABLE bl_docs ADD COLUMN IF NOT EXISTS bill_kind TEXT DEFAULT 'regular';
  ALTER TABLE bl_docs ADD COLUMN IF NOT EXISTS bank JSONB;
  ALTER TABLE bl_docs ADD COLUMN IF NOT EXISTS show_seal BOOLEAN DEFAULT true;`);
  if (!(await q(`SELECT 1 FROM settings WHERE k='bl_perm_v1'`)).rows.length) {   // whoever had billing also gets purchases once
    await q(`UPDATE users SET permissions = (SELECT ARRAY(SELECT DISTINCT unnest(permissions || ARRAY['purchases']))) WHERE 'billing'=ANY(permissions)`);
    await q(`INSERT INTO settings(k,v) VALUES('bl_perm_v1','1') ON CONFLICT (k) DO NOTHING`);
  }
}

// ---------- brand billing profile ----------
const blBrand = async id => {
  const b = (await q(`SELECT br.id, br.name, p.legal_name, p.gstin, p.state, p.address, p.phone, p.email, p.website, p.bank_name, p.bank_account, p.bank_ifsc, p.bank_branch, p.upi, p.terms, p.notes,
    COALESCE(p.color,'#1f6f5c') color, COALESCE(p.template,'modern') template, COALESCE(p.default_tax,18) default_tax, COALESCE(p.round_off,true) round_off, COALESCE(p.prefixes,'{}') prefixes, COALESCE(p.next_no,'{}') next_no,
    p.logo IS NOT NULL has_logo, p.seal IS NOT NULL has_seal, p.sign IS NOT NULL has_sign, COALESCE(p.banks,'[]') banks, p.sign_name, extract(epoch from p.updated_at)::bigint v FROM brands br LEFT JOIN bl_brand p ON p.brand_id=br.id WHERE br.id=$1`, [id])).rows[0];
  if (b) { b.default_tax = Number(b.default_tax); b.prefix = t => (b.prefixes || {})[t] ?? BL_TYPES[t].p;
    if (!Array.isArray(b.banks)) b.banks = [];
    if (!b.banks.length && (b.bank_account || b.upi)) b.banks = [{ bank_name: b.bank_name, bank_account: b.bank_account, bank_ifsc: b.bank_ifsc, bank_branch: b.bank_branch, upi: b.upi }]; }
  return b;
};
const blBankIn = list => (Array.isArray(list) ? list : []).slice(0, 10).map(x => {
  const t = k => String((x || {})[k] ?? '').trim().slice(0, 120) || undefined;
  return { label: t('label'), holder: t('holder'), bank_name: t('bank_name'), bank_account: t('bank_account'), bank_ifsc: (t('bank_ifsc') || '').toUpperCase() || undefined, bank_branch: t('bank_branch'), upi: t('upi') };
}).filter(x => x.bank_account || x.upi);
const blUserBrand = (u, want) => u.brand_id && !isSuper(u) ? u.brand_id : (+want || null);
const blDefBrand = async u => u.brand_id || ((await q('SELECT id FROM brands ORDER BY id LIMIT 1')).rows[0] || {}).id;

app.get('/api/bl/meta', need('billing', 'purchases'), wrap(async (req, res) => {
  const brands = [];
  for (const r of (await q(`SELECT id FROM brands ${req.user.brand_id && !isSuper(req.user) ? 'WHERE id=' + (+req.user.brand_id) : ''} ORDER BY id`)).rows) { const b = await blBrand(r.id); delete b.prefix; b.prefixes = Object.fromEntries(Object.keys(BL_TYPES).map(t => [t, (b.prefixes || {})[t] ?? BL_TYPES[t].p])); brands.push(b); }
  const cats = await blCats();
  res.json({ states: BL_STATES.map(s => s[1]), types: Object.fromEntries(Object.entries(BL_TYPES).map(([k, v]) => [k, v.l])), modes: BL_MODES, units: BL_UNITS, taxes: BL_TAXES, exp_cats: await blExpCats(), categories: cats, brands, banks: BANKS, my_brand: req.user.brand_id || null });
}));
app.put('/api/bl/brand/:id', superOnly, wrap(async (req, res) => {
  const id = +req.params.id, b = req.body || {};
  if (!(await q('SELECT 1 FROM brands WHERE id=$1', [id])).rows.length) return res.status(404).json({ error: 'Brand not found' });
  const gst = String(b.gstin || '').trim().toUpperCase();
  if (gst && !/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/.test(gst)) return res.status(400).json({ error: 'GSTIN should look like 33ABCDE1234F1Z5 (15 characters)' });
  const st = blState(b.state) || (gst ? blState(gst.slice(0, 2)) : null);
  const txt = k => String(b[k] ?? '').trim().slice(0, 2000) || null;
  const pre = {}, nxt = {};
  for (const t of Object.keys(BL_TYPES)) { if (b.prefixes && b.prefixes[t] !== undefined) pre[t] = String(b.prefixes[t]).slice(0, 20); if (b.next_no && +b.next_no[t] > 0) nxt[t] = Math.floor(+b.next_no[t]); }
  await q(`INSERT INTO bl_brand(brand_id) VALUES($1) ON CONFLICT DO NOTHING`, [id]);
  await q(`UPDATE bl_brand SET legal_name=$2, gstin=$3, state=$4, address=$5, phone=$6, email=$7, website=$8, bank_name=$9, bank_account=$10, bank_ifsc=$11, bank_branch=$12, upi=$13, terms=$14, notes=$15,
    color=$16, template=$17, default_tax=$18, round_off=$19, prefixes=$20, next_no=$21, sign_name=$22, updated_at=now() WHERE brand_id=$1`,
  [id, txt('legal_name'), gst || null, st, txt('address'), txt('phone'), txt('email'), txt('website'), txt('bank_name'), txt('bank_account'), (txt('bank_ifsc') || '').toUpperCase() || null, txt('bank_branch'), txt('upi'), txt('terms'), txt('notes'),
    /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : '#1f6f5c', ['modern', 'classic', 'thermal'].includes(b.template) ? b.template : 'modern', BL_TAXES.includes(+b.default_tax) ? +b.default_tax : 18, b.round_off !== false, pre, nxt, txt('sign_name')]);
  if (Array.isArray(b.banks)) {   // several bank accounts; the first is the default and is also kept in the old single-bank columns
    const bk = blBankIn(b.banks);
    const f = bk[0] || {};
    await q(`UPDATE bl_brand SET banks=$2, bank_name=$3, bank_account=$4, bank_ifsc=$5, bank_branch=$6, upi=$7 WHERE brand_id=$1`, [id, JSON.stringify(bk), f.bank_name || null, f.bank_account || null, f.bank_ifsc || null, f.bank_branch || null, f.upi || null]);
  }
  for (const k of ['seal', 'sign']) {   // round seal and signature images
    if (b[k] === null) await q(`UPDATE bl_brand SET ${k}=NULL, ${k}_mime=NULL WHERE brand_id=$1`, [id]);
    else if (typeof b[k] === 'string' && b[k].startsWith('data:image/')) {
      const m = /^data:(image\/[\w+.-]+);base64,(.+)$/.exec(b[k]); if (!m) return res.status(400).json({ error: 'Seal / signature must be an image' });
      const buf = Buffer.from(m[2], 'base64'); if (buf.length > 1.5e6) return res.status(400).json({ error: 'Image is too big — use one under 1.5 MB' });
      await q(`UPDATE bl_brand SET ${k}=$2, ${k}_mime=$3 WHERE brand_id=$1`, [id, buf, m[1]]);
    }
  }
  if (b.logo === null) await q(`UPDATE bl_brand SET logo=NULL, logo_mime=NULL WHERE brand_id=$1`, [id]);
  else if (typeof b.logo === 'string' && b.logo.startsWith('data:image/')) {
    const m = /^data:(image\/[\w+.-]+);base64,(.+)$/.exec(b.logo); if (!m) return res.status(400).json({ error: 'Logo must be an image' });
    const buf = Buffer.from(m[2], 'base64'); if (buf.length > 1.5e6) return res.status(400).json({ error: 'Logo is too big — use a smaller image (under 1.5 MB)' });
    await q(`UPDATE bl_brand SET logo=$2, logo_mime=$3 WHERE brand_id=$1`, [id, buf, m[1]]);
  }
  res.json({ ok: true });
}));
const blLogo = async (req, res) => {
  const r = (await q('SELECT logo, logo_mime FROM bl_brand WHERE brand_id=$1', [+req.params.id])).rows[0];
  if (!r || !r.logo) return res.status(404).end();
  res.setHeader('Content-Type', r.logo_mime || 'image/png'); res.setHeader('Cache-Control', 'public, max-age=86400'); res.end(r.logo);
};
app.get('/bl-logo/:id', wrap(blLogo));   // public: shown on shared invoices
for (const k of ['seal', 'sign']) app.get(`/bl-${k}/:id`, wrap(async (req, res) => {   // public: seal & signature on shared bills
  const r = (await q(`SELECT ${k} img, ${k}_mime mime FROM bl_brand WHERE brand_id=$1`, [+req.params.id])).rows[0];
  if (!r || !r.img) return res.status(404).end();
  res.setHeader('Content-Type', r.mime || 'image/png'); res.setHeader('Cache-Control', 'public, max-age=86400'); res.end(r.img);
}));
// categories: saved list + the ones used on products
const blCats = async () => {
  const s = (await q(`SELECT v FROM settings WHERE k='bl_cats'`)).rows[0]; let saved = []; try { saved = JSON.parse(s ? s.v : '[]'); } catch (e) {}
  const used = (await q(`SELECT DISTINCT category FROM bl_products WHERE category IS NOT NULL AND category<>''`)).rows.map(r => r.category);
  return [...new Set([...(Array.isArray(saved) ? saved : []), ...used])].sort((a, b) => a.localeCompare(b));
};
// expense heads: the standard list + ones added by staff + any used before
const blExpCats = async () => { let saved = []; try { saved = JSON.parse(((await q(`SELECT v FROM settings WHERE k='bl_exp_cats'`)).rows[0] || {}).v || '[]'); } catch (e) {}
  const used = (await q(`SELECT DISTINCT category FROM bl_expenses WHERE category IS NOT NULL AND category<>''`)).rows.map(r => r.category);
  const extra = [...new Set([...(Array.isArray(saved) ? saved : []), ...used])].filter(c => !BL_EXP_CATS.includes(c)).sort((a, b) => a.localeCompare(b));
  const base = BL_EXP_CATS.filter(c => c !== 'Other'); return [...base, ...extra, 'Other']; };
app.post('/api/bl/exp-categories', need('purchases'), wrap(async (req, res) => {
  const name = String((req.body || {}).name || '').trim().slice(0, 60); if (!name) return res.status(400).json({ error: 'Enter the category name' });
  const all = await blExpCats(), ex = all.find(c => c.toLowerCase() === name.toLowerCase());
  if (!ex) { let saved = []; try { saved = JSON.parse(((await q(`SELECT v FROM settings WHERE k='bl_exp_cats'`)).rows[0] || {}).v || '[]'); } catch (e) {}
    saved.push(name); await q(`INSERT INTO settings(k,v) VALUES('bl_exp_cats',$1) ON CONFLICT (k) DO UPDATE SET v=excluded.v`, [JSON.stringify(saved)]); }
  res.json({ ok: true, name: ex || name, categories: await blExpCats() });
}));
app.post('/api/bl/categories', need('billing', 'purchases'), wrap(async (req, res) => {
  const name = String((req.body || {}).name || '').trim().slice(0, 60); if (!name) return res.status(400).json({ error: 'Enter the category name' });
  const all = await blCats(); const ex = all.find(c => c.toLowerCase() === name.toLowerCase());
  if (!ex) { const s = (await q(`SELECT v FROM settings WHERE k='bl_cats'`)).rows[0]; let saved = []; try { saved = JSON.parse(s ? s.v : '[]'); } catch (e) {}
    saved.push(name); await q(`INSERT INTO settings(k,v) VALUES('bl_cats',$1) ON CONFLICT (k) DO UPDATE SET v=excluded.v`, [JSON.stringify(saved)]); }
  res.json({ ok: true, name: ex || name, categories: await blCats() });
}));

// ---------- products ----------
const blProdIn = (b, old = {}) => {
  const o = {}, s = (k, n = 300) => b[k] !== undefined ? (o[k] = String(b[k] ?? '').trim().slice(0, n) || null) : 0;
  if (b.name !== undefined) { o.name = String(b.name || '').trim().slice(0, 200); }
  s('sku', 60); s('hsn', 12); s('category', 60); s('description', 1000);
  if (b.brand_id !== undefined) o.brand_id = +b.brand_id || null;   // empty = shared by all branches
  if (b.unit !== undefined) o.unit = String(b.unit || 'Nos').trim().slice(0, 20) || 'Nos';
  if (b.kind !== undefined) o.kind = b.kind === 'service' ? 'service' : 'product';
  for (const k of ['price', 'purchase_price']) if (b[k] !== undefined) o[k] = br2(Math.max(0, +b[k] || 0));
  if (b.low_stock !== undefined) o.low_stock = Math.max(0, +b.low_stock || 0);
  if (b.tax !== undefined) o.tax = Math.max(0, Math.min(40, +b.tax || 0));
  if (b.price_incl !== undefined) o.price_incl = !!b.price_incl;
  if (b.purchase_incl !== undefined) o.purchase_incl = !!b.purchase_incl;
  if (b.active !== undefined) o.active = !!b.active;
  return o;
};
const blStockMove = async (pid, qty, kind, docId, note, by) => {
  if (!pid || !qty) return;
  const p = (await q('SELECT kind FROM bl_products WHERE id=$1', [pid])).rows[0]; if (!p || p.kind === 'service') return;
  await q('INSERT INTO bl_stock(product_id,qty,kind,doc_id,note,by_name) VALUES($1,$2,$3,$4,$5,$6)', [pid, qty, kind, docId || null, note || null, by || null]);
  await q('UPDATE bl_products SET stock=stock+$2, updated_at=now() WHERE id=$1', [pid, qty]);
};
app.get('/api/bl/products', need('billing', 'purchases'), wrap(async (req, res) => {
  const p = ['%' + String(req.query.q || '').trim() + '%'], w = ['(p.name ILIKE $1 OR p.sku ILIKE $1 OR p.hsn ILIKE $1 OR p.category ILIKE $1)'];
  if (req.query.all !== '1') w.push('p.active');
  if (req.query.low === '1') w.push(`p.kind='product' AND p.stock<=p.low_stock`);
  if (req.query.category) { p.push(req.query.category); w.push(`p.category=$${p.length}`); }
  blProdBrand(req.user, req.query, p, w);
  const pb = [], wb = ['true']; blProdBrand(req.user, req.query, pb, wb);
  const lim = Math.min(2000, +req.query.limit || 500);
  const rows = (await q(`SELECT p.*, (SELECT COALESCE(SUM(-s.qty),0) FROM bl_stock s WHERE s.product_id=p.id AND s.kind='Sale' AND s.created_at>now()-interval '30 days') sold30
    FROM bl_products p WHERE ${w.join(' AND ')} ORDER BY p.active DESC, lower(p.name) LIMIT ${lim}`, p)).rows;
  const tot = (await q(`SELECT COUNT(*)::int n, COUNT(*) FILTER (WHERE kind='product' AND stock<=low_stock AND active)::int low, COALESCE(SUM(CASE WHEN kind='product' AND stock>0 THEN stock*(CASE WHEN purchase_incl THEN purchase_price/(1+tax/100) ELSE purchase_price END) END),0) value FROM bl_products p WHERE active AND ${wb.join(' AND ')}`, pb)).rows[0];
  res.json({ items: rows, totals: tot });
}));
app.post('/api/bl/products', blNeed, wrap(async (req, res) => {
  const o = blProdIn(req.body || {}); if (!o.name) return res.status(400).json({ error: 'Enter the product name' });
  if (o.sku && (await q('SELECT 1 FROM bl_products WHERE lower(sku)=lower($1)', [o.sku])).rows.length) return res.status(409).json({ error: 'Another product already has code ' + o.sku });
  const ks = Object.keys(o), r = (await q(`INSERT INTO bl_products(${ks.join(',')}) VALUES(${ks.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`, ks.map(k => o[k]))).rows[0];
  const st = +(req.body || {}).opening_stock || 0; if (st) await blStockMove(r.id, st, 'Opening', null, 'Opening stock', req.user.name);
  res.json({ ok: true, id: r.id });
}));
app.patch('/api/bl/products/:id', blNeed, wrap(async (req, res) => {
  const o = blProdIn(req.body || {}); if (o.name === '') return res.status(400).json({ error: 'Enter the product name' });
  if (o.sku && (await q('SELECT 1 FROM bl_products WHERE lower(sku)=lower($1) AND id<>$2', [o.sku, +req.params.id])).rows.length) return res.status(409).json({ error: 'Another product already has code ' + o.sku });
  const ks = Object.keys(o); if (ks.length) await q(`UPDATE bl_products SET ${ks.map((k, i) => `${k}=$${i + 2}`).join(',')}, updated_at=now() WHERE id=$1`, [+req.params.id, ...ks.map(k => o[k])]);
  res.json({ ok: true });
}));
app.delete('/api/bl/products/:id', blNeed, wrap(async (req, res) => {    // used products are hidden, not deleted
  const used = (await q(`SELECT 1 FROM bl_docs WHERE items @> $1::jsonb LIMIT 1`, [JSON.stringify([{ pid: +req.params.id }])])).rows.length;
  if (used) await q('UPDATE bl_products SET active=false WHERE id=$1', [+req.params.id]); else await q('DELETE FROM bl_products WHERE id=$1', [+req.params.id]);
  res.json({ ok: true, hidden: !!used });
}));
app.get('/api/bl/products/:id/stock', need('billing', 'purchases'), wrap(async (req, res) => {
  res.json((await q(`SELECT s.*, d.no doc_no, d.type doc_type FROM bl_stock s LEFT JOIN bl_docs d ON d.id=s.doc_id WHERE s.product_id=$1 ORDER BY s.id DESC LIMIT 200`, [+req.params.id])).rows);
}));
app.post('/api/bl/products/:id/stock', blNeed, wrap(async (req, res) => {    // manual stock in / out / set
  const b = req.body || {}, p = (await q('SELECT * FROM bl_products WHERE id=$1', [+req.params.id])).rows[0];
  if (!p) return res.status(404).json({ error: 'Product not found' });
  if (p.kind === 'service') return res.status(400).json({ error: 'Services don’t have stock' });
  let qty = +b.qty || 0; if (b.mode === 'set') qty = (+b.qty || 0) - Number(p.stock); else if (b.mode === 'out') qty = -Math.abs(qty); else qty = Math.abs(qty);
  if (!qty) return res.status(400).json({ error: 'Enter the quantity' });
  await blStockMove(p.id, qty, b.mode === 'set' ? 'Adjust' : qty > 0 ? 'In' : 'Out', null, String(b.note || '').slice(0, 200), req.user.name);
  res.json({ ok: true, stock: Number(p.stock) + qty });
}));

// ---------- inventory (Swipe-style): stock list with values, bulk stock in / out, timeline ----------
app.get('/api/bl/inventory', need('billing', 'purchases'), wrap(async (req, res) => {
  const Q = req.query, p = ['%' + String(Q.q || '').trim() + '%'], w = [`p.active`, `p.kind='product'`, `(p.name ILIKE $1 OR p.sku ILIKE $1 OR p.hsn ILIKE $1)`];
  if (Q.category) { p.push(Q.category); w.push(`p.category=$${p.length}`); }
  blProdBrand(req.user, Q, p, w);
  const ws0 = w.join(' AND '), p0 = p.slice();
  if (Q.status === 'low') w.push(`p.stock<=p.low_stock`); else if (Q.status === 'in') w.push(`p.stock>p.low_stock`); else if (Q.status === 'out') w.push(`p.stock<=0`);
  const lim = Math.min(500, +Q.limit || 50), off = Math.max(0, +Q.offset || 0);
  const sort = { qty: 'p.stock', '-qty': 'p.stock DESC', name: 'lower(p.name)', updated: 'last DESC NULLS LAST' }[Q.sort] || 'last DESC NULLS LAST';
  const items = (await q(`SELECT p.id, p.name, p.sku, p.unit, p.category, p.stock, p.low_stock, p.price, p.price_incl, p.purchase_price, p.purchase_incl, p.tax,
    GREATEST(p.updated_at, (SELECT MAX(s.created_at) FROM bl_stock s WHERE s.product_id=p.id)) last
    FROM bl_products p WHERE ${w.join(' AND ')} ORDER BY ${sort}, lower(p.name) LIMIT ${lim} OFFSET ${off}`, p)).rows;
  const n = (await q(`SELECT COUNT(*)::int n FROM bl_products p WHERE ${w.join(' AND ')}`, p)).rows[0].n;
  const t = (await q(`SELECT COUNT(*) FILTER (WHERE stock<=low_stock)::int low_n, COALESCE(SUM(stock) FILTER (WHERE stock<=low_stock),0) low_q,
    COUNT(*) FILTER (WHERE stock>0)::int pos_n, COALESCE(SUM(stock) FILTER (WHERE stock>0),0) pos_q,
    COALESCE(SUM(CASE WHEN stock>0 THEN stock*(CASE WHEN price_incl THEN price/(1+tax/100) ELSE price END) END),0) val_sale,
    COALESCE(SUM(CASE WHEN stock>0 THEN stock*(CASE WHEN purchase_incl THEN purchase_price/(1+tax/100) ELSE purchase_price END) END),0) val_buy
    FROM bl_products p WHERE ${ws0}`, p0)).rows[0];
  res.json({ items, n, offset: off, limit: lim, totals: { low_n: t.low_n, low_q: Number(t.low_q), pos_n: t.pos_n, pos_q: Number(t.pos_q), val_sale: br2(t.val_sale), val_buy: br2(t.val_buy) } });
}));
app.post('/api/bl/stock/bulk', blNeed, wrap(async (req, res) => {   // many items in / out at once
  const b = req.body || {}, out = b.mode === 'out', rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, 300).filter(r => +r.pid && +r.qty > 0);
  if (!rows.length) return res.status(400).json({ error: 'Add at least one item with a quantity' });
  const note = String(b.note || '').slice(0, 200) || (out ? 'Bulk stock out' : 'Bulk stock in');
  let done = 0; for (const r of rows) { const pr = (await q(`SELECT kind FROM bl_products WHERE id=$1`, [+r.pid])).rows[0]; if (!pr || pr.kind === 'service') continue;
    await blStockMove(+r.pid, (out ? -1 : 1) * Math.abs(+r.qty), out ? 'Out' : 'In', null, note, req.user.name); done++; }
  res.json({ ok: true, done });
}));
app.get('/api/bl/stock-log', need('billing', 'purchases'), wrap(async (req, res) => {   // timeline of every stock move
  const p = [], w = ['true'];
  if (req.query.q) { p.push('%' + req.query.q + '%'); w.push(`p.name ILIKE $${p.length}`); }
  if (req.query.kind) { p.push(req.query.kind); w.push(`s.kind=$${p.length}`); }
  res.json((await q(`SELECT s.id, s.qty, s.kind, s.note, s.by_name, s.created_at, p.name, p.unit, d.no doc_no, d.type doc_type, d.id doc_id FROM bl_stock s JOIN bl_products p ON p.id=s.product_id LEFT JOIN bl_docs d ON d.id=s.doc_id
    WHERE ${w.join(' AND ')} ORDER BY s.id DESC LIMIT ${Math.min(500, +req.query.limit || 100)}`, p)).rows);
}));

// ---------- customers (billing fields) & vendors ----------
const blCustIn = (b) => {
  const o = {}, s = (k, n = 300) => { if (b[k] !== undefined) o[k] = String(b[k] ?? '').trim().slice(0, n) || null; };
  s('name', 120); s('company', 120); s('phone', 30); s('email', 120); s('address', 500); s('city', 80); s('pincode', 10); s('ship_address', 500); s('ship_name', 120); s('ship_phone', 30); s('ship_city', 80); s('ship_pincode', 10);
  if (b.ship_state !== undefined) o.ship_state = blState(b.ship_state);
  if (b.gstin !== undefined) o.gstin = String(b.gstin || '').trim().toUpperCase().slice(0, 15) || null;
  if (b.state !== undefined) o.state = blState(b.state);
  if (!o.state && o.gstin) o.state = blState(o.gstin.slice(0, 2));
  if (b.opening_bal !== undefined) o.opening_bal = br2(+b.opening_bal || 0);
  if (b.credit_days !== undefined) o.credit_days = b.credit_days === '' || b.credit_days === null ? null : Math.max(0, Math.min(365, Math.round(+b.credit_days || 0)));
  return o;
};
const blGstOk = g => !g || /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/.test(g);
app.post('/api/bl/customers', need('billing', 'service_create', 'customer_edit'), wrap(async (req, res) => {
  const b = req.body || {}, o = blCustIn(b);
  o.name = o.name || o.company; if (!o.name && !o.phone) return res.status(400).json({ error: 'Enter a name or phone number' });
  if (o.phone && digits(o.phone).length < 7) return res.status(400).json({ error: 'Enter a valid phone number' });
  if (!blGstOk(o.gstin)) return res.status(400).json({ error: 'GSTIN should look like 33ABCDE1234F1Z5' });
  if (o.phone) { const ex = (await q(`SELECT id, name FROM customers WHERE right(regexp_replace(COALESCE(phone,''),'\\D','','g'),10)=$1 LIMIT 1`, [digits(o.phone).slice(-10)])).rows[0]; if (ex) return res.status(409).json({ error: `${ex.name} already has this phone number`, id: ex.id }); }
  o.name = o.name || 'Customer ' + digits(o.phone).slice(-4); o.brand_id = blUserBrand(req.user, b.brand_id) || await blDefBrand(req.user);
  const ks = Object.keys(o), r = (await q(`INSERT INTO customers(${ks.join(',')}) VALUES(${ks.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`, ks.map(k => o[k]))).rows[0];
  res.json({ ok: true, id: r.id });
}));
app.patch('/api/bl/customers/:id', need('billing', 'customer_edit'), wrap(async (req, res) => {
  const p = [+req.params.id], sc = custScope(req.user, p);
  if (!(await q(`SELECT 1 FROM customers c WHERE c.id=$1 AND ${sc}`, p)).rows.length) return res.status(404).json({ error: 'Customer not found' });
  const o = blCustIn(req.body || {}); if (o.name === null) delete o.name;
  if (o.phone !== undefined && o.phone && digits(o.phone).length < 7) return res.status(400).json({ error: 'Enter a valid phone number' });
  if (!blGstOk(o.gstin)) return res.status(400).json({ error: 'GSTIN should look like 33ABCDE1234F1Z5' });
  const ks = Object.keys(o); if (ks.length) await q(`UPDATE customers SET ${ks.map((k, i) => `${k}=$${i + 2}`).join(',')} WHERE id=$1`, [+req.params.id, ...ks.map(k => o[k])]);
  res.json({ ok: true });
}));
// customers with billing balances (receivable)
app.get('/api/bl/customers', need('billing'), wrap(async (req, res) => {
  const p = ['%' + String(req.query.q || '').trim() + '%'];
  let sc = custScope(req.user, p); if (+req.query.brand) { p.push(+req.query.brand); sc += ` AND c.brand_id=$${p.length}`; }
  const rows = (await q(`SELECT c.id, c.name, c.company, c.phone, c.email, c.gstin, c.state, c.city, c.address, c.pincode, c.ship_address, c.ship_name, c.ship_phone, c.ship_city, c.ship_pincode, c.ship_state, COALESCE(c.opening_bal,0) opening_bal, c.brand_id, b.name brand, c.credit_days,
    COALESCE((SELECT SUM(d.total-d.paid-d.credited) FROM bl_docs d WHERE d.customer_id=c.id AND d.type='invoice' AND d.status NOT IN ('Cancelled','Draft')),0) inv_due,
    COALESCE((SELECT SUM(d.total) FROM bl_docs d WHERE d.customer_id=c.id AND d.type='invoice' AND d.status NOT IN ('Cancelled','Draft')),0) sales,
    COALESCE((SELECT SUM(d.total) FROM bl_docs d WHERE d.customer_id=c.id AND d.type='credit_note' AND d.against_id IS NULL AND d.status NOT IN ('Cancelled','Draft')),0) free_credit,
    (SELECT MAX(d.doc_date) FROM bl_docs d WHERE d.customer_id=c.id) last_doc
    FROM customers c LEFT JOIN brands b ON b.id=c.brand_id WHERE (c.name ILIKE $1 OR c.phone ILIKE $1 OR c.company ILIKE $1 OR c.gstin ILIKE $1) AND ${sc}
    ORDER BY ${req.query.sort === 'due' ? 'inv_due DESC,' : ''} lower(c.name) LIMIT ${Math.min(2000, +req.query.limit || 300)}`, p)).rows;
  rows.forEach(r => { r.balance = br2(Number(r.inv_due) + Number(r.opening_bal) - Number(r.free_credit)); });
  res.json(req.query.due === '1' ? rows.filter(r => r.balance > 0.5) : rows);
}));
app.get('/api/bl/vendors', blBuy, wrap(async (req, res) => {
  const rows = (await q(`SELECT v.*, COALESCE((SELECT SUM(d.total-d.paid) FROM bl_docs d WHERE d.vendor_id=v.id AND d.type='purchase' AND d.status NOT IN ('Cancelled','Draft')),0)+COALESCE(v.opening_bal,0) balance,
    COALESCE((SELECT SUM(d.total) FROM bl_docs d WHERE d.vendor_id=v.id AND d.type='purchase' AND d.status NOT IN ('Cancelled','Draft')),0) purchases
    FROM bl_vendors v WHERE v.name ILIKE $1 OR v.phone ILIKE $1 OR v.company ILIKE $1 OR v.gstin ILIKE $1 ORDER BY lower(v.name) LIMIT 1000`, ['%' + String(req.query.q || '').trim() + '%'])).rows;
  res.json(rows);
}));
app.post('/api/bl/vendors', blBuy, wrap(async (req, res) => {
  const o = blCustIn(req.body || {}); delete o.city; delete o.pincode; for (const k of Object.keys(o)) if (k.startsWith('ship_')) delete o[k];
  o.name = o.name || o.company; if (!o.name) return res.status(400).json({ error: 'Enter the vendor name' });
  if (!blGstOk(o.gstin)) return res.status(400).json({ error: 'GSTIN should look like 33ABCDE1234F1Z5' });
  const ks = Object.keys(o), r = (await q(`INSERT INTO bl_vendors(${ks.join(',')}) VALUES(${ks.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`, ks.map(k => o[k]))).rows[0];
  res.json({ ok: true, id: r.id });
}));
app.patch('/api/bl/vendors/:id', blBuy, wrap(async (req, res) => {
  const o = blCustIn(req.body || {}); delete o.city; delete o.pincode; for (const k of Object.keys(o)) if (k.startsWith('ship_')) delete o[k]; if (o.name === null) delete o.name;
  if (!blGstOk(o.gstin)) return res.status(400).json({ error: 'GSTIN should look like 33ABCDE1234F1Z5' });
  const ks = Object.keys(o); if (ks.length) await q(`UPDATE bl_vendors SET ${ks.map((k, i) => `${k}=$${i + 2}`).join(',')} WHERE id=$1`, [+req.params.id, ...ks.map(k => o[k])]);
  res.json({ ok: true });
}));
app.delete('/api/bl/vendors/:id', blBuy, wrap(async (req, res) => {
  if ((await q('SELECT 1 FROM bl_docs WHERE vendor_id=$1 LIMIT 1', [+req.params.id])).rows.length) return res.status(400).json({ error: 'This vendor has purchases — it can’t be deleted' });
  await q('DELETE FROM bl_vendors WHERE id=$1', [+req.params.id]); res.json({ ok: true });
}));
// party ledger: opening balance, documents and payments with a running balance
app.get('/api/bl/ledger/:kind/:id', need('billing', 'purchases'), wrap(async (req, res) => {
  const vend = req.params.kind === 'vendor', id = +req.params.id;
  if (vend && !can(req.user, 'purchases')) return res.status(403).json({ error: 'Not allowed' });
  let party;
  if (vend) party = (await q('SELECT * FROM bl_vendors WHERE id=$1', [id])).rows[0];
  else { const p = [id], sc = custScope(req.user, p); party = (await q(`SELECT c.* FROM customers c WHERE c.id=$1 AND ${sc}`, p)).rows[0]; }
  if (!party) return res.status(404).json({ error: 'Not found' });
  const docs = (await q(`SELECT id, type, no, to_char(doc_date,'YYYY-MM-DD') d, total, paid, credited, status, against_id FROM bl_docs WHERE ${vend ? 'vendor_id' : 'customer_id'}=$1 AND type=ANY($2) AND status NOT IN ('Cancelled','Draft') ORDER BY doc_date, id`, [id, vend ? ['purchase'] : ['invoice', 'credit_note']])).rows;
  const pays = docs.length ? (await q(`SELECT p.*, to_char(p.pay_date,'YYYY-MM-DD') d, d.no FROM bl_payments p JOIN bl_docs d ON d.id=p.doc_id WHERE p.doc_id=ANY($1) ORDER BY p.pay_date, p.id`, [docs.map(d => d.id)])).rows : [];
  const ev = [];
  docs.forEach(d => ev.push({ d: d.d, doc_id: d.id, what: (BL_TYPES[d.type] || {}).l + ' ' + d.no, debit: d.type === 'credit_note' ? 0 : Number(d.total), credit: d.type === 'credit_note' ? Number(d.total) : 0 }));
  pays.forEach(p => ev.push({ d: p.d, doc_id: p.doc_id, what: `${vend ? 'Paid' : 'Received'} · ${p.mode || ''} · ${p.no}${p.note ? ' · ' + p.note : ''}`, debit: 0, credit: Number(p.amount) }));
  ev.sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : 0);
  let bal = Number(party.opening_bal || 0); const rows = [{ d: null, what: 'Opening balance', debit: bal > 0 ? bal : 0, credit: bal < 0 ? -bal : 0, bal }];
  ev.forEach(e => { bal = br2(bal + e.debit - e.credit); rows.push({ ...e, bal }); });
  res.json({ party, rows, balance: bal });
}));

// ---------- documents ----------
const blCalc = (items, inter, extraDisc, charges, roundOn, supply) => {
  const lines = (Array.isArray(items) ? items : []).slice(0, 200).map(i => {
    const qty = Math.max(0, +i.qty || 0), rate = Math.max(0, +i.rate || 0), dp = Math.max(0, Math.min(100, +i.disc || 0)), tax = supply ? 0 : Math.max(0, Math.min(40, +i.tax || 0)), incl = !supply && !!i.incl;
    const amtD = i.dtype === 'amt', gross = qty * rate, disc = amtD ? Math.min(gross, Math.max(0, +i.dval || 0)) : gross * dp / 100, net = gross - disc, taxable = incl ? net / (1 + tax / 100) : net, tx = taxable * tax / 100;
    return { pid: +i.pid || null, name: String(i.name || '').trim().slice(0, 300), desc: String(i.desc || '').trim().slice(0, 1000) || undefined, hsn: String(i.hsn || '').trim().slice(0, 12) || undefined,
      unit: String(i.unit || '').slice(0, 20) || undefined, cat: String(i.cat || '').trim().slice(0, 60) || undefined, qty, rate: br2(rate), disc: amtD ? (gross ? br2(disc / gross * 100) : 0) || undefined : dp || undefined, dtype: amtD && disc ? 'amt' : undefined, dval: amtD && disc ? br2(disc) : undefined, tax, incl: incl || undefined, taxable: br2(taxable), tax_amt: br2(tx), amount: br2(taxable + tx), disc_amt: br2(disc) || undefined };
  }).filter(l => l.name && l.qty > 0);
  const sub = br2(lines.reduce((t, l) => t + l.taxable, 0)), taxT = br2(lines.reduce((t, l) => t + l.tax_amt, 0)), ld = br2(lines.reduce((t, l) => t + (l.disc_amt || 0), 0));
  const ed = br2(Math.max(0, +extraDisc || 0)), ch = br2(Math.max(0, +charges || 0)), raw = sub + taxT + ch - ed, tot = roundOn ? Math.round(raw) : br2(raw);
  const half = br2(taxT / 2);
  return { lines, sub, line_disc: ld, tax_total: taxT, cgst: inter ? 0 : half, sgst: inter ? 0 : br2(taxT - half), igst: inter ? taxT : 0, charges: ch, extra_disc: ed, round_off: br2(tot - raw), total: br2(Math.max(0, tot)) };
};
// status tabs on the lists (old exact statuses like 'Paid' still work too)
const BL_GROUPS = { open: `d.status IN ('Open','Unpaid')`, closed: `d.status IN ('Paid','Converted','Accepted','Issued')`, partial: `d.status='Partial'`, due: `d.status IN ('Unpaid','Partial')`,
  overdue: `d.status IN ('Unpaid','Partial') AND d.due_date<CURRENT_DATE`, lost: `d.status='Declined'`, cancelled: `d.status='Cancelled'`, draft: `d.status='Draft'` };
const blStatus = d => {
  if (d.status === 'Cancelled') return 'Cancelled';
  if (d.status === 'Draft') return 'Draft';
  if (d.type === 'invoice' || d.type === 'purchase') { const due = br2(d.total - d.paid - (d.credited || 0)); return d.total > 0 && due <= 0.009 ? 'Paid' : (d.paid > 0 || d.credited > 0) ? 'Partial' : 'Unpaid'; }
  if (d.type === 'credit_note') return 'Issued';
  return ['Converted', 'Accepted', 'Declined'].includes(d.status) ? d.status : 'Open';
};
const blScopeDocs = (u, p, w) => { if (u.brand_id && !isSuper(u)) { p.push(u.brand_id); w.push(`d.brand_id=$${p.length}`); } };
const blLoad = async (req, res, id) => {
  const d = (await q(`SELECT d.*, to_char(d.doc_date,'YYYY-MM-DD') doc_date, to_char(d.due_date,'YYYY-MM-DD') due_date, b.name brand FROM bl_docs d LEFT JOIN brands b ON b.id=d.brand_id WHERE d.id=$1`, [id])).rows[0];
  if (!d) { res.status(404).json({ error: 'Document not found' }); return null; }
  if (!can(req.user, blTypeNeed(d.type))) { res.status(403).json({ error: 'Not allowed' }); return null; }
  if (req.user.brand_id && !isSuper(req.user) && d.brand_id !== req.user.brand_id) { res.status(403).json({ error: 'This belongs to another brand' }); return null; }
  ['sub', 'line_disc', 'tax_total', 'cgst', 'sgst', 'igst', 'charges', 'extra_disc', 'round_off', 'total', 'paid', 'credited'].forEach(k => d[k] = Number(d[k] || 0));
  return d;
};
const blNextNo = async (brandId, type) => {
  const b = await blBrand(brandId), pre = b ? b.prefix(type) : BL_TYPES[type].p;
  const last = (await q(`SELECT COALESCE(MAX(seq),0) n FROM bl_docs WHERE brand_id IS NOT DISTINCT FROM $1 AND type=$2`, [brandId, type])).rows[0].n;
  const start = +((b && b.next_no || {})[type]) || 1, seq = Math.max(last + 1, start);
  return { seq, no: pre + seq };
};
// stock effect of a document: invoice & challan take stock out (an invoice made from a challan doesn't take it twice), credit note & purchase bring it in
const blStockSign = async d => {
  if (d.status === 'Cancelled' || d.status === 'Draft') return 0;
  if (d.type === 'invoice') { if (d.ref_id) { const r = (await q('SELECT type FROM bl_docs WHERE id=$1', [d.ref_id])).rows[0]; if (r && r.type === 'challan') return 0; } return -1; }
  return { challan: -1, credit_note: 1, purchase: 1 }[d.type] || 0;
};
const blApplyStock = async (d, by) => {
  await (async () => { // undo what this document did before
    const old = (await q('SELECT product_id, SUM(qty) q FROM bl_stock WHERE doc_id=$1 GROUP BY product_id', [d.id])).rows;
    for (const o of old) if (Number(o.q)) await q('UPDATE bl_products SET stock=stock-$2 WHERE id=$1', [o.product_id, o.q]);
    await q('DELETE FROM bl_stock WHERE doc_id=$1', [d.id]);
  })();
  const sg = await blStockSign(d); if (!sg) return;
  const kind = { invoice: 'Sale', challan: 'Delivery', credit_note: 'Return', purchase: 'Purchase' }[d.type];
  for (const l of d.items || []) if (l.pid) await blStockMove(l.pid, sg * l.qty, kind, d.id, null, by);
};
const blParty = async (u, type, b) => {      // resolves / creates the customer or vendor for a document
  const pin = b.party || {}, vend = BL_TYPES[type].party === 'vendor';
  if (vend) {
    let v = b.vendor_id && (await q('SELECT * FROM bl_vendors WHERE id=$1', [+b.vendor_id])).rows[0];
    if (!v) { const name = String(pin.name || pin.company || '').trim(); if (!name) return { error: 'Choose or enter the vendor' };
      const o = blCustIn(pin); delete o.city; delete o.pincode; for (const k of Object.keys(o)) if (k.startsWith('ship_')) delete o[k]; o.name = o.name || o.company;
      v = (await q(`INSERT INTO bl_vendors(name,company,phone,email,gstin,state,address) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [o.name, o.company || null, o.phone || null, o.email || null, o.gstin || null, o.state || null, o.address || null])).rows[0]; }
    return { vendor_id: v.id, party: { name: v.name, company: v.company, phone: v.phone, email: v.email, gstin: v.gstin, state: v.state, address: v.address } };
  }
  let c = null;
  if (b.customer_id) { const p = [+b.customer_id], sc = custScope(u, p); c = (await q(`SELECT c.* FROM customers c WHERE c.id=$1 AND ${sc}`, p)).rows[0]; }
  const o = blCustIn(pin);
  if (!c && o.phone && digits(o.phone).length >= 7) c = (await q(`SELECT * FROM customers WHERE right(regexp_replace(COALESCE(phone,''),'\\D','','g'),10)=$1 ORDER BY id LIMIT 1`, [digits(o.phone).slice(-10)])).rows[0];
  if (!c) {
    const name = o.name || o.company; if (!name && !o.phone) return { error: 'Choose or enter the customer' };
    const nc = { name: name || 'Customer ' + digits(o.phone).slice(-4), company: o.company, phone: o.phone, email: o.email, gstin: o.gstin, state: o.state, address: o.address, city: o.city, pincode: o.pincode, ship_address: o.ship_address, ship_name: o.ship_name, ship_phone: o.ship_phone, ship_city: o.ship_city, ship_pincode: o.ship_pincode, ship_state: o.ship_state, brand_id: b.brand_id };
    const nk = Object.keys(nc); c = (await q(`INSERT INTO customers(${nk.join(',')}) VALUES(${nk.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`, nk.map(k => nc[k] ?? null))).rows[0];
  } else {   // fill in billing details we learnt (never overwrite what's there)
    const fill = {}; for (const k of ['gstin', 'state', 'email', 'address', 'company', 'pincode', 'city']) if (o[k] && !c[k]) fill[k] = o[k];
    for (const k of ['ship_name', 'ship_phone', 'ship_address', 'ship_city', 'ship_pincode', 'ship_state']) if (o[k] !== undefined && (o[k] || null) !== (c[k] || null)) fill[k] = o[k] || null;   // shipping follows the latest bill
    const ks = Object.keys(fill); if (ks.length) { await q(`UPDATE customers SET ${ks.map((k, i) => `${k}=$${i + 2}`).join(',')} WHERE id=$1`, [c.id, ...ks.map(k => fill[k])]); Object.assign(c, fill); }
  }
  const pick = (k) => o[k] !== undefined && o[k] !== null ? o[k] : c[k];
  return { customer_id: c.id, party: { name: o.name || c.name, company: pick('company'), phone: pick('phone'), email: pick('email'), gstin: pick('gstin'), state: pick('state'), address: pick('address'), city: pick('city'), pincode: pick('pincode'), ship_address: pick('ship_address') , ship_name: pick('ship_name'), ship_phone: pick('ship_phone'), ship_city: pick('ship_city'), ship_pincode: pick('ship_pincode'), ship_state: pick('ship_state') } };
};
const BL_KINDABLE = ['invoice', 'quotation', 'proforma', 'challan', 'purchase', 'credit_note'];   // Regular (GST) or Bill of Supply (no GST)
const BL_DRAFTABLE = ['invoice', 'quotation', 'proforma', 'challan', 'purchase', 'credit_note'];
// bank shown on a bill: index into the brand's accounts, 'none' to hide, or keep what the bill had
const blDocBank = (brand, want, old) => {
  const list = brand.banks || [];
  if (want === 'none' || want === -1) return { none: true };
  if (want && typeof want === 'object') return want.none ? { none: true } : blBankIn([want])[0] || { none: true };
  if (want !== undefined && want !== null && want !== '' && list[+want]) return list[+want];
  if (old && old.bank) return old.bank;
  return list[0] || null;
};
const blSave = async (req, res, old) => {
  const b = req.body || {}, type = old ? old.type : b.type;
  if (!BL_TYPES[type]) return res.status(400).json({ error: 'Unknown document type' });
  if (!can(req.user, blTypeNeed(type))) return res.status(403).json({ error: 'Not allowed' });
  if (old && old.status === 'Cancelled') return res.status(400).json({ error: 'This document is cancelled' });
  const brandId = old ? old.brand_id : (blUserBrand(req.user, b.brand_id) || await blDefBrand(req.user));
  const brand = await blBrand(brandId); if (!brand) return res.status(400).json({ error: 'Choose the brand' });
  b.brand_id = brandId;
  const draft = BL_DRAFTABLE.includes(type) && !!b.draft && (!old || old.status === 'Draft');
  let pr = await blParty(req.user, type, b); if (pr.error) { if (!draft) return res.status(400).json({ error: pr.error }); pr = { party: {} }; }   // a draft may be saved before the customer is chosen
  if (!draft && BL_CREDIT_TYPES.includes(type) && (!old || old.status === 'Draft') && pr.customer_id) {
    const chk = await blCreditCheck(pr.customer_id);
    if (chk.blocked && !(isSuper(req.user) && b.md_override)) return res.status(423).json({ error: `This customer has ${chk.n} overdue bill${chk.n > 1 ? 's' : ''} (₹${chk.amount}). Collect the payment first, or ask the MD to approve.`, credit_block: true, ...chk, customer_id: pr.customer_id });
    if (chk.blocked && b.md_override) await q(`INSERT INTO bl_credit_ok(customer_id,customer_name,doc_type,amount,note,status,requested_by,req_name,decided_by,decided_at,valid_until) VALUES($1,$2,$3,$4,'Approved while saving','approved',$5,$6,$6,now(),now())`,
      [pr.customer_id, chk.customer, type, chk.amount, req.user.id, req.user.name]);
  }
  const pos = blState(b.pos) || (pr.party.ship_address && pr.party.ship_state) || pr.party.state || brand.state || null;   // goods: place of supply = where they are delivered
  const inter = !!(brand.state && pos && pos !== brand.state);
  const pids = [...new Set((Array.isArray(b.items) ? b.items : []).map(i => +i.pid).filter(Boolean))];   // fill HSN / unit from the product when missing
  if (pids.length) { const pm = Object.fromEntries((await q('SELECT id, hsn, unit FROM bl_products WHERE id=ANY($1)', [pids])).rows.map(r => [r.id, r]));
    b.items = b.items.map(i => { const p = pm[+i.pid]; return p ? { ...i, hsn: i.hsn || p.hsn, unit: i.unit || p.unit } : i; }); }
  const kind = BL_KINDABLE.includes(type) && b.bill_kind === 'supply' ? 'supply' : 'regular';
  const c = blCalc(b.items, inter, b.extra_disc, b.charges, b.round_off !== undefined ? !!b.round_off : brand.round_off, kind === 'supply');
  if (!c.lines.length && !draft) return res.status(400).json({ error: 'Add at least one item with a quantity' });
  if (old && (type === 'invoice' || type === 'purchase') && c.total + 0.009 < old.paid + old.credited) return res.status(400).json({ error: `₹${old.paid + old.credited} is already received / credited — the total can’t be less than that` });
  const dd = /^\d{4}-\d{2}-\d{2}$/.test(b.doc_date) ? b.doc_date : null;
  let due = /^\d{4}-\d{2}-\d{2}$/.test(b.due_date) ? b.due_date : null;
  if (!due && type === 'invoice' && pr.customer_id) {   // due date from the customer's credit period
    const cd = (await q('SELECT credit_days FROM customers WHERE id=$1', [pr.customer_id])).rows[0], cfg = await blCreditCfg(), days = cd && cd.credit_days !== null ? cd.credit_days : cfg.default_days;
    if (days > 0) { const base = new Date((dd || await todayIST()) + 'T00:00:00Z'); base.setUTCDate(base.getUTCDate() + days); due = base.toISOString().slice(0, 10); }
  }
  let against = null;
  if (type === 'credit_note' && b.against_id) { const a = (await q(`SELECT * FROM bl_docs WHERE id=$1 AND type='invoice' AND status NOT IN ('Cancelled','Draft')`, [+b.against_id])).rows[0];
    if (a) { const room = br2(Number(a.total) - Number(a.paid) - Number(a.credited) + (old && old.against_id === a.id ? old.total : 0)); if (c.total > room + 0.009) return res.status(400).json({ error: `This credit note (₹${c.total}) is more than what’s still due on ${a.no} (₹${room}). Record a refund for the rest.` }); against = a.id; } }
  const vals = { brand_id: brandId, customer_id: pr.customer_id || null, vendor_id: pr.vendor_id || null, party: JSON.stringify(pr.party), pos, inter, items: JSON.stringify(c.lines),
    sub: c.sub, line_disc: c.line_disc, tax_total: c.tax_total, cgst: c.cgst, sgst: c.sgst, igst: c.igst, charges: c.charges, charges_label: String(b.charges_label || '').slice(0, 60) || null,
    extra_disc: c.extra_disc, round_off: c.round_off, total: c.total, notes: String(b.notes ?? '').slice(0, 4000) || null, terms: String(b.terms ?? '').slice(0, 4000) || null,
    ref_no: String(b.ref_no || '').slice(0, 60) || null, template: ['modern', 'classic', 'thermal'].includes(b.template) ? b.template : null, due_date: due,
    bill_kind: kind, show_seal: b.show_seal !== false, bank: JSON.stringify(blDocBank(brand, b.bank, old)) };
  if (dd) vals.doc_date = dd;
  const draftAgainst = draft ? against : null; if (draft) against = null;   // a draft credits nothing until it is saved for real
  const pickNo = async () => {   // number for a new document or a draft being finalised
    let nn = await blNextNo(brandId, type);
    if (b.no && String(b.no).trim() && String(b.no).trim() !== 'Draft') { const want = String(b.no).trim().slice(0, 40); if ((await q('SELECT 1 FROM bl_docs WHERE brand_id IS NOT DISTINCT FROM $1 AND type=$2 AND no=$3 AND id<>$4', [brandId, type, want, old ? old.id : 0])).rows.length) return { error: `${want} is already used` }; nn = { no: want, seq: +(/(\d+)\s*$/.exec(want) || [])[1] || nn.seq }; }
    return nn;
  };
  const afterMade = async (no, v) => {
    if (v.ref_id) await q(`UPDATE bl_docs SET status='Converted', updated_at=now() WHERE id=$1 AND type IN ('quotation','proforma','challan')`, [v.ref_id]);
    if (v.lead_id) await q('INSERT INTO lead_activity(lead_id,by_name,text) VALUES($1,$2,$3)', [v.lead_id, req.user.name, `🧾 ${BL_TYPES[type].l} ${no} made · ₹${c.total}`]).catch(() => {});
    if (v.service_id) await log(v.service_id, req.user.name, `🧾 ${BL_TYPES[type].l} ${no} made · ₹${c.total}`);
  };
  const openSt = type === 'quotation' || type === 'proforma' || type === 'challan' ? 'Open' : null;
  let id;
  if (old) {
    if (old.against_id && old.status !== 'Draft') await q('UPDATE bl_docs SET credited=GREATEST(0,credited-$2) WHERE id=$1', [old.against_id, old.total]);
    const finalise = old.status === 'Draft' && !draft;
    if (finalise) { const nn = await pickNo(); if (nn.error) return res.status(409).json({ error: nn.error }); Object.assign(vals, { no: nn.no, seq: nn.seq, status: openSt }); }
    else if (draft) vals.status = 'Draft';
    const ks = Object.keys(vals); await q(`UPDATE bl_docs SET ${ks.map((k, i) => `${k}=$${i + 2}`).join(',')}, against_id=$${ks.length + 2}, updated_at=now() WHERE id=$1`, [old.id, ...ks.map(k => vals[k]), draft ? draftAgainst : against]);
    id = old.id;
    if (finalise) await afterMade(vals.no, { ref_id: old.ref_id, lead_id: old.lead_id, service_id: old.service_id });
  } else {
    const nn = draft ? { no: 'Draft', seq: null } : await pickNo(); if (nn.error) return res.status(409).json({ error: nn.error });
    Object.assign(vals, { type, no: nn.no, seq: nn.seq, against_id: draft ? draftAgainst : against, ref_id: +b.ref_id || null, lead_id: +b.lead_id || null, service_id: +b.service_id || null, status: draft ? 'Draft' : openSt,
      created_by: req.user.id, created_by_name: req.user.name, share_token: crypto.randomBytes(12).toString('base64url') });
    const ks = Object.keys(vals); id = (await q(`INSERT INTO bl_docs(${ks.join(',')}) VALUES(${ks.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`, ks.map(k => vals[k]))).rows[0].id;
    if (!draft) await afterMade(nn.no, vals);
  }
  if (against) await q('UPDATE bl_docs SET credited=credited+$2 WHERE id=$1', [against, c.total]);
  const d = await blLoad(req, res, id); if (!d) return;
  await blApplyStock(d, req.user.name);
  for (const x of [d.id, against, old && old.against_id].filter(Boolean)) { const z = await blLoad(req, res, x); if (z) await q('UPDATE bl_docs SET status=$2 WHERE id=$1', [z.id, blStatus(z)]); }
  const fin = await blLoad(req, res, id); res.json({ ok: true, id, no: fin.no, total: fin.total, status: fin.status });
};
app.post('/api/bl/docs', need('billing', 'purchases'), wrap((req, res) => blSave(req, res, null)));
app.put('/api/bl/docs/:id', need('billing', 'purchases'), wrap(async (req, res) => { const d = await blLoad(req, res, +req.params.id); if (d) await blSave(req, res, d); }));
app.get('/api/bl/docs', need('billing', 'purchases'), wrap(async (req, res) => {
  const p = [], w = [], Q = req.query, add = (sql, v) => { p.push(v); w.push(sql.replace('?', '$' + p.length)); };
  const types = String(Q.type || '').split(',').filter(t => BL_TYPES[t] && can(req.user, blTypeNeed(t)));
  if (!types.length) return res.json({ items: [], totals: {} });
  add('d.type=ANY(?)', types); blScopeDocs(req.user, p, w);
  if (Q.brand) add('d.brand_id=?', +Q.brand);
  if (Q.customer_id) add('d.customer_id=?', +Q.customer_id);
  if (Q.vendor_id) add('d.vendor_id=?', +Q.vendor_id);
  if (Q.lead_id) add('d.lead_id=?', +Q.lead_id);
  if (Q.service_id) add('d.service_id=?', +Q.service_id);
  if (Q.from) add('d.doc_date>=?', Q.from); if (Q.to) add('d.doc_date<=?', Q.to);
  if (Q.q) { p.push('%' + Q.q + '%'); const n = '$' + p.length; w.push(`(d.no ILIKE ${n} OR d.party->>'name' ILIKE ${n} OR d.party->>'company' ILIKE ${n} OR d.party->>'phone' ILIKE ${n} OR d.ref_no ILIKE ${n})`); }
  if (Q.amin !== undefined && Q.amin !== '' && !isNaN(+Q.amin)) add('d.total>=?', +Q.amin);
  if (Q.amax !== undefined && Q.amax !== '' && !isNaN(+Q.amax)) add('d.total<=?', +Q.amax);
  if (Q.no) add('d.no ILIKE ?', '%' + String(Q.no).trim() + '%');
  if (Q.cust) { p.push('%' + String(Q.cust).trim() + '%'); const n = '$' + p.length; w.push(`(d.party->>'name' ILIKE ${n} OR d.party->>'company' ILIKE ${n} OR d.party->>'phone' ILIKE ${n})`); }
  if (Q.delivery === 'pending') w.push(`d.type IN ('invoice','challan') AND d.delivery IS NULL`); else if (['transport', 'collected'].includes(Q.delivery)) add(`d.delivery->>'mode'=?`, Q.delivery);
  const wsAll = w.join(' AND '), pAll = p.slice();   // everything except the status tab → used for the tab counts
  if (Q.status) { const g = BL_GROUPS[Q.status]; if (g) w.push(g); else add('d.status=?', Q.status); }
  const ws = w.join(' AND ');
  const lim = Math.min(1000, +Q.limit || 300), off = Math.max(0, +Q.offset || 0);
  const items = (await q(`SELECT d.id, d.type, d.no, to_char(d.doc_date,'YYYY-MM-DD') doc_date, to_char(d.due_date,'YYYY-MM-DD') due_date, d.party->>'name' party, d.party->>'company' company, d.party->>'phone' phone,
    d.total, d.paid, d.credited, d.status, d.brand_id, b.name brand, d.customer_id, d.vendor_id, d.lead_id, d.service_id, d.ref_no, d.share_token, d.created_by_name, d.created_at, d.bill_kind, jsonb_array_length(d.items) lines, d.delivery
    FROM bl_docs d LEFT JOIN brands b ON b.id=d.brand_id WHERE ${ws} ORDER BY ${BL_SORT[Q.sort] || 'd.doc_date DESC, d.id DESC'} LIMIT ${lim} OFFSET ${off}`, p)).rows;
  const t = (await q(`SELECT COUNT(*)::int n, COALESCE(SUM(total) FILTER (WHERE status NOT IN ('Cancelled','Draft')),0) total, COALESCE(SUM(paid) FILTER (WHERE status NOT IN ('Cancelled','Draft')),0) paid,
    COALESCE(SUM(total-paid-credited) FILTER (WHERE status IN ('Unpaid','Partial')),0) due, COALESCE(SUM(total) FILTER (WHERE ${BL_GROUPS.closed.replace(/d\./g, '')}),0) closed FROM bl_docs d WHERE ${ws}`, p)).rows[0];
  const cr = (await q(`SELECT COUNT(*)::int "all", ${Object.entries(BL_GROUPS).map(([k, v]) => `COUNT(*) FILTER (WHERE ${v})::int "${k}"`).join(', ')} FROM bl_docs d WHERE ${wsAll}`, pAll)).rows[0];
  res.json({ items, totals: t, counts: cr, offset: off, limit: lim });
}));
app.get('/api/bl/docs/:id', need('billing', 'purchases'), wrap(async (req, res) => {
  const d = await blLoad(req, res, +req.params.id); if (!d) return;
  d.payments = (await q(`SELECT id, doc_id, amount, mode, account, to_char(pay_date,'YYYY-MM-DD') pay_date, note, by_name, created_at FROM bl_payments p WHERE doc_id=$1 ORDER BY p.pay_date, p.id`, [d.id])).rows;
  d.related = (await q(`SELECT id, type, no, total, status FROM bl_docs WHERE (ref_id=$1 OR against_id=$1 OR id=$2 OR id=$3) AND id<>$1 ORDER BY id`, [d.id, d.ref_id || 0, d.against_id || 0])).rows;
  d.due = br2(d.total - d.paid - d.credited);
  res.json(d);
}));
app.post('/api/bl/docs/:id/convert', need('billing'), wrap(async (req, res) => {   // quotation / proforma / challan → invoice (or quotation → proforma / challan)
  const d = await blLoad(req, res, +req.params.id); if (!d) return;
  const to = (req.body || {}).to, mdOk = !!(req.body || {}).md_override;
  const ok = { quotation: ['invoice', 'proforma', 'challan'], proforma: ['invoice', 'challan'], challan: ['invoice'] }[d.type] || [];
  if (!ok.includes(to)) return res.status(400).json({ error: 'This can’t be converted to that' });
  if (d.status === 'Cancelled') return res.status(400).json({ error: 'This document is cancelled' });
  if (d.status === 'Draft') return res.status(400).json({ error: 'Save this draft first' });
  req.body = { type: to, brand_id: d.brand_id, customer_id: d.customer_id, party: d.party, pos: d.pos, items: d.items, extra_disc: d.extra_disc, charges: d.charges, charges_label: d.charges_label, notes: d.notes, terms: d.terms, ref_id: d.id, lead_id: d.lead_id, service_id: d.service_id, template: d.template,
    bill_kind: d.bill_kind, show_seal: d.show_seal, bank: d.bank || undefined, md_override: mdOk };
  await blSave(req, res, null);
}));
app.post('/api/bl/docs/:id/status', need('billing', 'purchases'), wrap(async (req, res) => {   // quotation accepted / declined / reopened, or cancel any document
  const d = await blLoad(req, res, +req.params.id); if (!d) return;
  const st = (req.body || {}).status;
  if (st === 'Cancelled') {
    if (d.status === 'Cancelled') return res.json({ ok: true });
    if (d.paid > 0) return res.status(400).json({ error: 'Delete the payments on this first' });
    if ((await q(`SELECT 1 FROM bl_docs WHERE against_id=$1 AND status NOT IN ('Cancelled','Draft')`, [d.id])).rows.length) return res.status(400).json({ error: 'Cancel the credit notes made against this first' });
    await q(`UPDATE bl_docs SET status='Cancelled', updated_at=now() WHERE id=$1`, [d.id]);
    if (d.against_id) { await q('UPDATE bl_docs SET credited=GREATEST(0,credited-$2) WHERE id=$1', [d.against_id, d.total]); const a = await blLoad(req, res, d.against_id); if (a) await q('UPDATE bl_docs SET status=$2 WHERE id=$1', [a.id, blStatus(a)]); }
    if (d.ref_id) await q(`UPDATE bl_docs SET status='Open' WHERE id=$1 AND status='Converted' AND NOT EXISTS (SELECT 1 FROM bl_docs x WHERE x.ref_id=$1 AND x.status<>'Cancelled')`, [d.ref_id]);
    d.status = 'Cancelled'; await blApplyStock(d, req.user.name);
    return res.json({ ok: true });
  }
  if (d.status === 'Draft' || !['quotation', 'proforma', 'challan'].includes(d.type) || !['Open', 'Accepted', 'Declined'].includes(st)) return res.status(400).json({ error: 'Not possible' });
  await q('UPDATE bl_docs SET status=$2, updated_at=now() WHERE id=$1', [d.id, st]); res.json({ ok: true });
}));
app.delete('/api/bl/docs/:id', need('billing', 'purchases'), wrap(async (req, res) => {   // only drafts can be deleted
  const d = await blLoad(req, res, +req.params.id); if (!d) return;
  if (d.status !== 'Draft') return res.status(400).json({ error: 'Only drafts can be deleted — cancel it instead' });
  await q('DELETE FROM bl_docs WHERE id=$1', [d.id]); res.json({ ok: true });
}));
app.post('/api/bl/docs/:id/payments', need('billing', 'purchases'), wrap(async (req, res) => {
  const d = await blLoad(req, res, +req.params.id); if (!d) return;
  if (!['invoice', 'purchase'].includes(d.type)) return res.status(400).json({ error: 'Payments are recorded on invoices and purchases' });
  if (d.status === 'Cancelled') return res.status(400).json({ error: 'This document is cancelled' });
  if (d.status === 'Draft') return res.status(400).json({ error: 'Save this draft first' });
  const b = req.body || {}, amt = br2(+b.amount || 0), due = br2(d.total - d.paid - d.credited);
  if (amt <= 0) return res.status(400).json({ error: 'Enter the amount' });
  if (amt > due + 0.009) return res.status(400).json({ error: `Only ₹${due} is due on this` });
  const mode = BL_MODES.includes(b.mode) ? b.mode : 'Cash';
  await q(`INSERT INTO bl_payments(doc_id,amount,mode,account,pay_date,note,by_name) VALUES($1,$2,$3,$4,COALESCE($5::date,CURRENT_DATE),$6,$7)`,
    [d.id, amt, mode, BANKS.includes(b.account) ? b.account : (String(b.account || '').slice(0, 60) || null), /^\d{4}-\d{2}-\d{2}$/.test(b.pay_date) ? b.pay_date : null, String(b.note || '').slice(0, 300) || null, req.user.name]);
  await q('UPDATE bl_docs SET paid=paid+$2, updated_at=now() WHERE id=$1', [d.id, amt]);
  const z = await blLoad(req, res, d.id); await q('UPDATE bl_docs SET status=$2 WHERE id=$1', [d.id, blStatus(z)]);
  res.json({ ok: true, status: blStatus(z), due: br2(z.total - z.paid - z.credited) });
}));
app.delete('/api/bl/payments/:id', need('billing', 'purchases'), wrap(async (req, res) => {
  const p = (await q('SELECT * FROM bl_payments WHERE id=$1', [+req.params.id])).rows[0]; if (!p) return res.status(404).json({ error: 'Not found' });
  const d = await blLoad(req, res, p.doc_id); if (!d) return;
  await q('DELETE FROM bl_payments WHERE id=$1', [p.id]); await q('UPDATE bl_docs SET paid=GREATEST(0,paid-$2) WHERE id=$1', [d.id, p.amount]);
  const z = await blLoad(req, res, d.id); await q('UPDATE bl_docs SET status=$2 WHERE id=$1', [d.id, blStatus(z)]); res.json({ ok: true });
}));
// a ticket's office bill was paid → the GST invoice made for that ticket gets the same payment
async function blTicketPaid(serviceId, amount, mode, account, by) {
  try {
    const d = (await q(`SELECT * FROM bl_docs WHERE service_id=$1 AND type='invoice' AND status IN ('Unpaid','Partial') ORDER BY id DESC LIMIT 1`, [serviceId])).rows[0]; if (!d) return;
    const amt = br2(Math.min(+amount || 0, Number(d.total) - Number(d.paid) - Number(d.credited))); if (amt <= 0) return;
    await q(`INSERT INTO bl_payments(doc_id,amount,mode,account,note,by_name) VALUES($1,$2,$3,$4,'From the service ticket',$5)`, [d.id, amt, BL_MODES.includes(mode) ? mode : 'Cash', account || null, by]);
    const t = br2(Number(d.paid) + amt), st = t + Number(d.credited) >= Number(d.total) - 0.009 ? 'Paid' : 'Partial';
    await q('UPDATE bl_docs SET paid=$2, status=$3 WHERE id=$1', [d.id, t, st]);
  } catch (e) { console.error('blTicketPaid', e.message); }
}

// ---------- print / share (one HTML template for the app and the customer link) ----------
const blWords = n => {
  const a = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const t = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = x => x < 20 ? a[x] : t[Math.floor(x / 10)] + (x % 10 ? ' ' + a[x % 10] : '');
  const three = x => (x >= 100 ? a[Math.floor(x / 100)] + ' Hundred' + (x % 100 ? ' ' : '') : '') + (x % 100 ? two(x % 100) : '');
  const w = x => { if (!x) return 'Zero'; let s = ''; const cr = Math.floor(x / 1e7), la = Math.floor(x / 1e5) % 100, th = Math.floor(x / 1e3) % 100, re = x % 1000;
    if (cr) s += w(cr) + ' Crore '; if (la) s += two(la) + ' Lakh '; if (th) s += two(th) + ' Thousand '; if (re) s += three(re); return s.trim(); };
  const r = Math.floor(n), p = Math.round((n - r) * 100);
  return 'Rupees ' + w(r) + (p ? ' and ' + two(p) + ' Paise' : '') + ' Only';
};
const bhe = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const binr = v => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const bdIN = s => s ? new Date(s + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
const blHTML = (d, b, opts = {}) => {
  const tpl = opts.template || d.template || b.template || 'modern', col = b.color || '#1f6f5c', P = d.party || {}, vend = d.type === 'purchase';
  const supply = d.bill_kind === 'supply';
  const title = d.type === 'invoice' ? (supply ? 'Bill of Supply' : !Number(d.tax_total) && !b.gstin ? 'Invoice' : BL_TYPES[d.type].l) : BL_TYPES[d.type].l;
  const hasDisc = (d.items || []).some(l => l.disc), hasHsn = (d.items || []).some(l => l.hsn), hasCat = (d.items || []).some(l => l.cat);
  const nCols = 5 + (hasHsn ? 1 : 0) + (hasDisc ? 1 : 0) + (supply ? 0 : 2);
  let prevCat = null; const catRow = l => { if (!hasCat || (l.cat || '') === prevCat) return ''; prevCat = l.cat || ''; return l.cat ? `<tr class="cat"><td colspan="${thermal ? 3 : nCols}">${bhe(l.cat)}</td></tr>` : ''; };
  const rateRows = {}; (d.items || []).forEach(l => { const k = l.tax; rateRows[k] = rateRows[k] || { taxable: 0, tax: 0 }; rateRows[k].taxable += l.taxable; rateRows[k].tax += l.tax_amt; });
  const thermal = tpl === 'thermal';
  const rows = (d.items || []).map((l, i) => catRow(l) + (thermal
    ? `<tr><td colspan="3"><b>${bhe(l.name)}</b></td></tr><tr class="sm"><td>${l.qty} ${bhe(l.unit || '')} × ${binr(l.rate)}${l.disc ? ` −${l.disc}%` : ''}</td><td>${supply ? '' : l.tax + '%'}</td><td class="r">${binr(l.amount)}</td></tr>`
    : `<tr><td class="c">${i + 1}</td><td><b>${bhe(l.name)}</b>${l.desc ? `<div class="ds">${bhe(l.desc).replace(/\n/g, '<br>')}</div>` : ''}</td>${hasHsn ? `<td class="c">${bhe(l.hsn || '')}</td>` : ''}<td class="r">${l.qty} ${bhe(l.unit || '')}</td><td class="r">${binr(l.rate)}${l.incl ? '<div class="ds">incl. tax</div>' : ''}</td>${hasDisc ? `<td class="r">${l.dtype === 'amt' ? '₹' + binr(l.dval) : l.disc ? l.disc + '%' : '—'}</td>` : ''}${supply ? '' : `<td class="r hm">${binr(l.taxable)}</td><td class="r">${l.tax}%<div class="ds">${binr(l.tax_amt)}</div></td>`}<td class="r"><b>${binr(l.amount)}</b></td></tr>`)).join('');
  const taxLines = d.inter ? (Number(d.igst) ? `<tr><td>IGST</td><td class="r">${binr(d.igst)}</td></tr>` : '') : (Number(d.cgst) ? `<tr><td>CGST</td><td class="r">${binr(d.cgst)}</td></tr><tr><td>SGST</td><td class="r">${binr(d.sgst)}</td></tr>` : '');
  const due = br2(d.total - d.paid - d.credited);
  const logo = b.has_logo ? `<img class="logo" src="${opts.base || ''}/bl-logo/${b.id}?v=${b.v || 0}" alt="">` : '';
  const from = `<div class="fromn">${bhe(b.legal_name || b.name)}</div><div>${bhe(b.address || '').replace(/\n/g, '<br>')}</div>${b.state ? `<div>State: ${bhe(b.state)} (${blStateCode(b.state)})</div>` : ''}${b.gstin ? `<div><b>GSTIN:</b> ${bhe(b.gstin)}</div>` : ''}${b.phone ? `<div>📞 ${bhe(b.phone)}</div>` : ''}${b.email ? `<div>✉ ${bhe(b.email)}</div>` : ''}`;
  const to = `<div class="lbl">${vend ? 'Vendor' : 'Bill to · billing address'}</div><div class="fromn">${bhe(P.company || P.name || '')}</div>${P.company && P.name && P.company !== P.name ? `<div>${bhe(P.name)}</div>` : ''}<div>${bhe(P.address || '').replace(/\n/g, '<br>')}${P.city ? ', ' + bhe(P.city) : ''}${P.pincode ? ' - ' + bhe(P.pincode) : ''}</div>${P.phone ? `<div>📞 ${bhe(P.phone)}</div>` : ''}${P.state ? `<div>State: ${bhe(P.state)} (${blStateCode(P.state)})</div>` : ''}${P.gstin ? `<div><b>GSTIN:</b> ${bhe(P.gstin)}</div>` : ''}${d.pos ? `<div>Place of supply: ${bhe(d.pos)} (${blStateCode(d.pos)})</div>` : ''}`;
  const shipOn = !vend && (P.ship_address || P.ship_name || P.ship_city);
  const ship = vend ? '' : shipOn ? `<div><div class="lbl">Ship to</div><div class="fromn">${bhe(P.ship_name || P.company || P.name || '')}</div><div>${bhe(P.ship_address || '').replace(/\n/g, '<br>')}${P.ship_city ? ', ' + bhe(P.ship_city) : ''}${P.ship_pincode ? ' - ' + bhe(P.ship_pincode) : ''}</div>${P.ship_state ? `<div>State: ${bhe(P.ship_state)} (${blStateCode(P.ship_state)})</div>` : ''}${P.ship_phone ? `<div>📞 ${bhe(P.ship_phone)}</div>` : ''}</div>`
    : `<div><div class="lbl">Ship to</div><div class="fromn">${bhe(P.company || P.name || '')}</div><div>${bhe(P.address || '').replace(/\n/g, '<br>')}${P.city ? ', ' + bhe(P.city) : ''}${P.pincode ? ' - ' + bhe(P.pincode) : ''}</div>${P.state ? `<div>State: ${bhe(P.state)} (${blStateCode(P.state)})</div>` : ''}<div class="ds">Same as billing address</div></div>`;
  const meta = `<table class="meta"><tr><td>${title} #</td><td><b>${bhe(d.no)}</b></td></tr><tr><td>Date</td><td>${bdIN(d.doc_date)}</td></tr>${d.due_date ? `<tr><td>${d.type === 'quotation' ? 'Valid till' : 'Due date'}</td><td>${bdIN(d.due_date)}</td></tr>` : ''}${d.ref_no ? `<tr><td>${vend ? 'Vendor bill #' : 'Reference'}</td><td>${bhe(d.ref_no)}</td></tr>` : ''}</table>`;
  const tot = `<table class="tot"><tr><td>${supply ? 'Sub total' : 'Taxable amount'}</td><td class="r">${binr(d.sub)}</td></tr>${taxLines}${Number(d.charges) ? `<tr><td>${bhe(d.charges_label || 'Other charges')}</td><td class="r">${binr(d.charges)}</td></tr>` : ''}${Number(d.extra_disc) ? `<tr><td>Discount</td><td class="r">− ${binr(d.extra_disc)}</td></tr>` : ''}${Number(d.round_off) ? `<tr><td>Round off</td><td class="r">${d.round_off > 0 ? '' : '− '}${binr(Math.abs(d.round_off))}</td></tr>` : ''}<tr class="grand"><td>Total</td><td class="r">₹ ${binr(d.total)}</td></tr>${(d.type === 'invoice' || vend) && (d.paid || d.credited) ? `<tr><td>${vend ? 'Paid' : 'Received'}</td><td class="r">${binr(d.paid)}</td></tr>${d.credited ? `<tr><td>Credit notes</td><td class="r">${binr(d.credited)}</td></tr>` : ''}<tr class="due"><td>Balance due</td><td class="r">₹ ${binr(due)}</td></tr>` : ''}</table>`;
  const gstTab = !thermal && Number(d.tax_total) ? `<table class="gst"><tr><th>Tax rate</th><th class="r">Taxable</th>${d.inter ? '<th class="r">IGST</th>' : '<th class="r">CGST</th><th class="r">SGST</th>'}<th class="r">Total tax</th></tr>${Object.entries(rateRows).filter(([k]) => +k > 0).map(([k, v]) => `<tr><td>${k}%</td><td class="r">${binr(v.taxable)}</td>${d.inter ? `<td class="r">${binr(v.tax)}</td>` : `<td class="r">${binr(v.tax / 2)}</td><td class="r">${binr(v.tax / 2)}</td>`}<td class="r">${binr(v.tax)}</td></tr>`).join('')}</table>` : '';
  const bk = d.bank && typeof d.bank === 'object' ? d.bank : ((b.banks || [])[0] || {});   // the account chosen on this bill (older bills: the brand's first account)
  const bank = !vend && !bk.none && (bk.bank_account || bk.upi) ? `<div class="bank"><div class="lbl">Bank details</div>${bk.holder ? `<div>A/c name: <b>${bhe(bk.holder)}</b></div>` : ''}${bk.bank_name ? `<div>Bank: <b>${bhe(bk.bank_name)}</b></div>` : ''}${bk.bank_account ? `<div>A/c no: <b>${bhe(bk.bank_account)}</b></div>` : ''}${bk.bank_ifsc ? `<div>IFSC: <b>${bhe(bk.bank_ifsc)}</b>${bk.bank_branch ? ' · ' + bhe(bk.bank_branch) : ''}</div>` : ''}${bk.upi ? `<div>UPI: <b>${bhe(bk.upi)}</b></div>` : ''}${opts.pay && bk.upi && due > 0 && d.type === 'invoice' ? `<a class="paybtn noprint" href="upi://pay?pa=${encodeURIComponent(bk.upi)}&pn=${encodeURIComponent(b.legal_name || b.name)}&am=${due.toFixed(2)}&cu=INR&tn=${encodeURIComponent(d.no)}">Pay ₹${binr(due)} by UPI</a>` : ''}</div>` : '';
  const sealOn = d.show_seal !== false && !vend;
  const sealImg = sealOn && b.has_seal ? `<img class="seal" src="${opts.base || ''}/bl-seal/${b.id}?v=${b.v || 0}" alt="Seal">` : '';
  const signImg = sealOn && b.has_sign ? `<img class="signi" src="${opts.base || ''}/bl-sign/${b.id}?v=${b.v || 0}" alt="Signature">` : '';
  const notes = [d.notes && `<div class="lbl">Notes</div><div>${bhe(d.notes).replace(/\n/g, '<br>')}</div>`, (d.terms || (!vend && b.terms)) && `<div class="lbl">Terms & conditions</div><div>${bhe(d.terms || b.terms).replace(/\n/g, '<br>')}</div>`].filter(Boolean).join('');
  const css = `*{box-sizing:border-box}body{margin:0;background:#f2f2f2;font:13px/1.45 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1d1d1f}.pg{max-width:820px;margin:16px auto;background:#fff;padding:34px 36px;box-shadow:0 2px 14px rgba(0,0,0,.08)}
  .hd{display:flex;gap:18px;align-items:flex-start;justify-content:space-between}.logo{max-height:64px;max-width:180px;object-fit:contain;margin-bottom:6px}.fromn{font-weight:700;font-size:15px}.ttl{font-size:22px;font-weight:800;letter-spacing:.5px;color:${col};text-transform:uppercase;text-align:right}
  .lbl{font-size:10.5px;text-transform:uppercase;letter-spacing:1px;color:#888;font-weight:700;margin-top:6px}.meta td{padding:1px 0 1px 12px;text-align:right}.meta td:first-child{color:#777}.parties{display:flex;gap:24px;margin:20px 0 14px;padding:14px 0;border-top:2px solid ${col};border-bottom:1px solid #e5e5e5}.parties>div{flex:1}
  table{border-collapse:collapse;width:100%}.it th{background:${tpl === 'classic' ? '#fff' : col};color:${tpl === 'classic' ? '#111' : '#fff'};font-size:11px;text-transform:uppercase;letter-spacing:.4px;padding:8px 6px;text-align:left;${tpl === 'classic' ? 'border:1px solid #333;' : ''}}.it td{padding:8px 6px;border-bottom:1px solid #eee;vertical-align:top;${tpl === 'classic' ? 'border:1px solid #333;' : ''}}
  .r{text-align:right}.c{text-align:center}.ds{color:#777;font-size:11.5px;white-space:normal}.foot{display:flex;gap:24px;margin-top:16px}.foot>div{flex:1}.tot td{padding:4px 0}.tot .grand td{font-size:16px;font-weight:800;border-top:2px solid #222;padding-top:8px}.tot .due td{font-weight:700;color:#c0392b}
  .words{margin-top:8px;font-style:italic;color:#444}.gst{margin-top:14px;font-size:11.5px}.gst th,.gst td{border:1px solid #ddd;padding:4px 6px;text-align:left}.bank{margin-top:12px}.sig{text-align:right;margin-top:40px}.sig div{display:inline-block;border-top:1px solid #333;padding-top:4px;min-width:180px;text-align:center}
  .paybtn{display:inline-block;margin-top:8px;background:${col};color:#fff;border-radius:999px;padding:9px 16px;text-decoration:none;font-weight:700}.bar{max-width:820px;margin:12px auto 0;display:flex;gap:8px;justify-content:flex-end;padding:0 12px}.bar button,.bar a{background:#111;color:#fff;border:0;border-radius:999px;padding:9px 16px;font:600 13px inherit;text-decoration:none;cursor:pointer}
  .it tr.cat td{background:#f4f4f5;font-weight:800;font-size:11.5px;text-transform:uppercase;letter-spacing:.6px;color:#333;padding:6px}
  .sig.hasimg{margin-top:16px}.sig .sigimgs{display:flex;justify-content:flex-end;align-items:flex-end;gap:4px;margin-bottom:-10px;position:relative;z-index:1;border-top:0;padding-top:0;min-width:0}.sigimgs .seal{width:92px;height:92px;object-fit:contain;opacity:.95}.sigimgs .signi{max-height:56px;max-width:160px;object-fit:contain;margin-bottom:8px}
  .supply{font-size:11px;color:#777;text-align:right}
  .stamp{display:inline-block;border:2px solid #c0392b;color:#c0392b;font-weight:800;padding:2px 10px;border-radius:6px;transform:rotate(-6deg);margin-top:6px}.stamp.ok{border-color:#1f9255;color:#1f9255}
  ${thermal ? `.pg{max-width:320px;padding:14px;font-size:12px}.hd{display:block;text-align:center}.ttl{text-align:center;font-size:15px}.parties{display:block;margin:8px 0;padding:8px 0}.foot{display:block}.it td{padding:3px 2px;border:0}.it .sm td{border-bottom:1px dashed #bbb;padding-bottom:5px}.meta td{text-align:left;padding-left:0}` : ''}
  .itw{overflow-x:auto;-webkit-overflow-scrolling:touch}
  @media (max-width:640px){.pg{margin:0;padding:18px 12px;box-shadow:none}.parties,.foot{flex-direction:column;gap:10px}.it{font-size:11px}.it th{font-size:9.5px;letter-spacing:0;padding:6px 3px}.it td{padding:6px 3px}.it .hm{display:none}.hd{flex-direction:column}.ttl{text-align:left}.foot>div{max-width:none!important}}
  @media print{body{background:#fff}.pg{box-shadow:none;margin:0;max-width:none;padding:10mm}.noprint,.bar{display:none!important}@page{size:${thermal ? '80mm auto' : 'A4'};margin:${thermal ? '2mm' : '8mm'}}}`;
  const stamp = d.status === 'Draft' ? '<div class="stamp">DRAFT</div>' : d.status === 'Cancelled' ? '<div class="stamp">CANCELLED</div>' : (d.type === 'invoice' && d.status === 'Paid') ? '<div class="stamp ok">PAID</div>' : '';
  const head = thermal
    ? `<div class="hd">${logo}<div>${from}</div><div class="ttl" style="margin-top:8px">${title}</div>${meta}${stamp}</div>`
    : `<div class="hd"><div>${logo}${from}</div><div><div class="ttl">${title}</div>${supply && d.type !== 'invoice' ? '<div class="supply">Bill of Supply · without GST</div>' : ''}${meta}${stamp}</div></div>`;
  const itHead = thermal ? '<tr><th colspan="2">Item</th><th class="r">Amount</th></tr>' : `<tr><th class="c">#</th><th>Item</th>${hasHsn ? '<th class="c">HSN/SAC</th>' : ''}<th class="r">Qty</th><th class="r">Rate</th>${hasDisc ? '<th class="r">Disc</th>' : ''}${supply ? '' : '<th class="r hm">Taxable</th><th class="r">GST</th>'}<th class="r">Amount</th></tr>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${bhe(title + ' ' + d.no)}</title><style>${css}</style></head><body>
  ${opts.bar && !opts.embed ? `<div class="bar noprint"><button onclick="print()">🖨 Print / Save PDF</button></div>` : ''}${opts.embed ? '<style>body{background:#fff}.pg{margin:0 auto;box-shadow:none}</style>' : ''}
  <div class="pg">${head}<div class="parties"><div>${to}</div>${ship}</div>${blDelivHTML(d)}
  <div class="itw"><table class="it">${itHead}${rows}</table></div>
  <div class="foot"><div>${gstTab}<div class="words">${blWords(Number(d.total))}</div>${bank}${notes ? `<div style="margin-top:10px">${notes}</div>` : ''}</div><div style="max-width:${thermal ? 'none' : '300px'}">${tot}<div class="sig${sealImg || signImg ? ' hasimg' : ''}">${sealImg || signImg ? `<div class="sigimgs">${sealImg}${signImg}</div>` : ''}<div>For ${bhe(b.legal_name || b.name)}${b.sign_name ? `<br><small>${bhe(b.sign_name)}</small>` : ''}<br><small>Authorised signatory</small></div></div></div></div>
  </div>${opts.auto ? '<script>setTimeout(()=>print(),400)</script>' : ''}</body></html>`;
};
app.get('/api/bl/docs/:id/print', need('billing', 'purchases'), wrap(async (req, res) => {
  const d = await blLoad(req, res, +req.params.id); if (!d) return;
  const b = await blBrand(d.brand_id) || { name: '', id: 0 };
  res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(blHTML(d, b, { template: req.query.t, bar: true, auto: req.query.auto === '1', embed: req.query.embed === '1' }));
}));
app.get('/d/:token', wrap(async (req, res) => {     // the link sent to the customer (no login)
  const d = (await q(`SELECT d.*, to_char(d.doc_date,'YYYY-MM-DD') doc_date, to_char(d.due_date,'YYYY-MM-DD') due_date FROM bl_docs d WHERE share_token=$1 AND type<>'purchase'`, [String(req.params.token)])).rows[0];
  if (!d) return res.status(404).send('<h3 style="font-family:sans-serif;padding:30px">This link is not valid any more.</h3>');
  ['sub', 'line_disc', 'tax_total', 'cgst', 'sgst', 'igst', 'charges', 'extra_disc', 'round_off', 'total', 'paid', 'credited'].forEach(k => d[k] = Number(d[k] || 0));
  const b = await blBrand(d.brand_id) || { name: '', id: 0 };
  res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('X-Robots-Tag', 'noindex'); res.end(blHTML(d, b, { bar: true, pay: true }));
}));

// ---------- expenses ----------
app.get('/api/bl/expenses', blBuy, wrap(async (req, res) => {
  const p = [], w = ['true'], add = (s, v) => { p.push(v); w.push(s.replace('?', '$' + p.length)); };
  if (req.user.brand_id && !isSuper(req.user)) add('e.brand_id=?', req.user.brand_id);
  else if (+req.query.brand) add('e.brand_id=?', +req.query.brand);
  if (req.query.from) add('e.exp_date>=?', req.query.from); if (req.query.to) add('e.exp_date<=?', req.query.to);
  if (req.query.category) add('e.category=?', req.query.category);
  const items = (await q(`SELECT e.*, to_char(e.exp_date,'YYYY-MM-DD') exp_date, b.name brand FROM bl_expenses e LEFT JOIN brands b ON b.id=e.brand_id WHERE ${w.join(' AND ')} ORDER BY e.exp_date DESC, e.id DESC LIMIT 500`, p)).rows;
  res.json({ items, total: br2(items.reduce((t, e) => t + Number(e.amount), 0)) });
}));
app.post('/api/bl/expenses', blBuy, wrap(async (req, res) => {
  const b = req.body || {}, amt = br2(+b.amount || 0); if (amt <= 0) return res.status(400).json({ error: 'Enter the amount' });
  const r = (await q(`INSERT INTO bl_expenses(brand_id,category,amount,tax,exp_date,mode,paid_to,note,by_name) VALUES($1,$2,$3,$4,COALESCE($5::date,CURRENT_DATE),$6,$7,$8,$9) RETURNING id`,
    [blUserBrand(req.user, b.brand_id) || await blDefBrand(req.user), String(b.category || 'Other').slice(0, 60), amt, br2(+b.tax || 0), /^\d{4}-\d{2}-\d{2}$/.test(b.exp_date) ? b.exp_date : null, BL_MODES.includes(b.mode) ? b.mode : 'Cash', String(b.paid_to || '').slice(0, 120) || null, String(b.note || '').slice(0, 500) || null, req.user.name])).rows[0];
  res.json({ ok: true, id: r.id });
}));
app.delete('/api/bl/expenses/:id', blBuy, wrap(async (req, res) => { await q('DELETE FROM bl_expenses WHERE id=$1', [+req.params.id]); res.json({ ok: true }); }));

// ---------- dashboard & reports ----------
const blRange = Q => { const t = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10); return { from: /^\d{4}-\d{2}-\d{2}$/.test(Q.from) ? Q.from : t.slice(0, 8) + '01', to: /^\d{4}-\d{2}-\d{2}$/.test(Q.to) ? Q.to : t }; };
const blBrandW = (u, Q, p, alias = 'd') => { const b = u.brand_id && !isSuper(u) ? u.brand_id : +Q.brand || 0; if (!b) return 'true'; p.push(b); return `${alias}.brand_id=$${p.length}`; };
app.get('/api/bl/counts', need('billing', 'purchases'), wrap(async (req, res) => {
  const u = req.user, out = {}, p = [], w = [`d.status NOT IN ('Cancelled','Draft')`]; blScopeDocs(u, p, w);
  if (req.query.brand) { p.push(+req.query.brand); w.push(`d.brand_id=$${p.length}`); }
  for (const r of (await q(`SELECT d.type, COUNT(*)::int n FROM bl_docs d WHERE ${w.join(' AND ')} GROUP BY d.type`, p)).rows) if (can(u, blTypeNeed(r.type))) out[r.type] = r.n;
  const pb = [], wb = ['true']; blProdBrand(u, req.query, pb, wb);
  out.products = (await q(`SELECT COUNT(*)::int n FROM bl_products p WHERE active AND ${wb.join(' AND ')}`, pb)).rows[0].n;
  out.inventory = (await q(`SELECT COUNT(*)::int n FROM bl_products p WHERE active AND kind='product' AND ${wb.join(' AND ')}`, pb)).rows[0].n;
  if (can(u, 'billing')) { const cp = []; let sc = custScope(u, cp); if (+req.query.brand) { cp.push(+req.query.brand); sc += ` AND c.brand_id=$${cp.length}`; } out.bcust = (await q(`SELECT COUNT(*)::int n FROM customers c WHERE ${sc}`, cp)).rows[0].n; }
  if (can(u, 'purchases')) {
    out.vendors = (await q(`SELECT COUNT(*)::int n FROM bl_vendors`)).rows[0].n;
    const ep = [], ew = [`e.exp_date>=date_trunc('month',CURRENT_DATE)`]; if (u.brand_id && !isSuper(u)) { ep.push(u.brand_id); ew.push(`e.brand_id=$1`); } else if (+req.query.brand) { ep.push(+req.query.brand); ew.push(`e.brand_id=$1`); }
    out.expenses = (await q(`SELECT COUNT(*)::int n FROM bl_expenses e WHERE ${ew.join(' AND ')}`, ep)).rows[0].n;
  }
  res.json(out);
}));
// ---------- insights (Swipe-style analytics for a date range, compared with the period just before) ----------
const blDay = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
app.get('/api/bl/insights', need('billing', 'purchases'), wrap(async (req, res) => {
  const u = req.user, Q = req.query, today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10), ok = x => /^\d{4}-\d{2}-\d{2}$/.test(x);
  const to = ok(Q.to) ? Q.to : today, from = ok(Q.from) ? Q.from : blDay(to, -29);
  const days = Math.max(1, Math.round((new Date(to) - new Date(from)) / 864e5) + 1), pto = blDay(from, -1), pfrom = blDay(from, -days);
  const buy = can(u, 'purchases'), sell = can(u, 'billing');
  const B = (p, a = 'd') => blBrandW(u, Q, p, a);
  const N = v => Number(v || 0), LIVE = `d.status NOT IN ('Cancelled','Draft')`;
  // 1. daily sales / purchases / expenses for both periods
  let p = [pfrom, to]; let bw = B(p);
  const dd = (await q(`SELECT to_char(doc_date,'YYYY-MM-DD') d, COALESCE(SUM(total) FILTER (WHERE type='invoice'),0) s, COALESCE(SUM(total) FILTER (WHERE type='credit_note'),0) cn, COALESCE(SUM(total) FILTER (WHERE type='purchase'),0) pu
    FROM bl_docs d WHERE ${LIVE} AND doc_date BETWEEN $1 AND $2 AND ${bw} GROUP BY 1`, p)).rows;
  p = [pfrom, to]; bw = B(p, 'e');
  const ed = buy ? (await q(`SELECT to_char(exp_date,'YYYY-MM-DD') d, SUM(amount) x FROM bl_expenses e WHERE exp_date BETWEEN $1 AND $2 AND ${bw} GROUP BY 1`, p)).rows : [];
  const day = {}; dd.forEach(r => day[r.d] = { s: N(r.s) - N(r.cn), pu: N(r.pu), x: 0 }); ed.forEach(r => (day[r.d] = day[r.d] || { s: 0, pu: 0, x: 0 }).x = N(r.x));
  const step = days <= 45 ? 1 : days <= 200 ? 7 : 30, buckets = [];
  for (let i = 0; i < days; i += step) {
    const b = { from: blDay(from, i), to: blDay(from, Math.min(days - 1, i + step - 1)), s: 0, pu: 0, x: 0, ps: 0, ppu: 0, px: 0 };
    for (let k = i; k < Math.min(days, i + step); k++) { const c = day[blDay(from, k)], pv = day[blDay(pfrom, k)]; if (c) { b.s += c.s; b.pu += c.pu; b.x += c.x; } if (pv) { b.ps += pv.s; b.ppu += pv.pu; b.px += pv.x; } }
    buckets.push(b);
  }
  const sum = (k, a, z) => br2(Object.entries(day).filter(([d]) => d >= a && d <= z).reduce((t, [, v]) => t + v[k], 0));
  const overview = { sales: sum('s', from, to), purchases: buy ? sum('pu', from, to) : 0, expenses: buy ? sum('x', from, to) : 0, prev: { sales: sum('s', pfrom, pto), purchases: buy ? sum('pu', pfrom, pto) : 0, expenses: buy ? sum('x', pfrom, pto) : 0 } };
  overview.net = br2(overview.sales - overview.purchases - overview.expenses);
  // 2. receivables / payables with aging
  const owed = async type => {
    const pp = [type, today]; const w = B(pp);
    const r = (await q(`SELECT COALESCE(SUM(total-paid-credited),0) amt, COUNT(*) FILTER (WHERE due_date<$2)::int overdue, COUNT(DISTINCT ${type === 'purchase' ? 'vendor_id' : 'customer_id'})::int parties, COALESCE(MAX($2::date-doc_date),0)::int oldest,
      COALESCE(SUM(total-paid-credited) FILTER (WHERE $2::date-doc_date<=5),0) a0, COALESCE(SUM(total-paid-credited) FILTER (WHERE $2::date-doc_date BETWEEN 6 AND 10),0) a1,
      COALESCE(SUM(total-paid-credited) FILTER (WHERE $2::date-doc_date BETWEEN 11 AND 20),0) a2, COALESCE(SUM(total-paid-credited) FILTER (WHERE $2::date-doc_date>20),0) a3
      FROM bl_docs d WHERE type=$1 AND status IN ('Unpaid','Partial') AND ${w}`, pp)).rows[0];
    return { amount: N(r.amt), overdue: r.overdue, parties: r.parties, oldest: r.oldest, aging: [['0–5 days', N(r.a0)], ['6–10 days', N(r.a1)], ['11–20 days', N(r.a2)], ['20+ days', N(r.a3)]] };
  };
  const receivables = sell ? await owed('invoice') : null, payables = buy ? await owed('purchase') : null;
  // 3. cash flow: money received on invoices vs paid on purchases + expenses
  const flow = async (a, z) => {
    const pp = [a, z]; const w = B(pp);
    const rows = (await q(`SELECT d.type, COALESCE(pm.mode,'Other') mode, COALESCE(NULLIF(pm.account,''),CASE WHEN pm.mode='Cash' THEN 'Cash in hand' ELSE 'Not set' END) acc, SUM(pm.amount) amt
      FROM bl_payments pm JOIN bl_docs d ON d.id=pm.doc_id WHERE pm.pay_date BETWEEN $1 AND $2 AND ${w} GROUP BY 1,2,3`, pp)).rows;
    const ep = [a, z]; const ew = B(ep, 'e');
    const ex = buy ? N((await q(`SELECT COALESCE(SUM(amount),0) x FROM bl_expenses e WHERE exp_date BETWEEN $1 AND $2 AND ${ew}`, ep)).rows[0].x) : 0;
    const inR = rows.filter(r => r.type === 'invoice'), outR = rows.filter(r => r.type === 'purchase');
    const grp = (L, k) => Object.entries(L.reduce((m, r) => (m[r[k]] = (m[r[k]] || 0) + N(r.amt), m), {})).sort((x, y) => y[1] - x[1]);
    const inflow = br2(inR.reduce((t, r) => t + N(r.amt), 0)), outflow = br2(outR.reduce((t, r) => t + N(r.amt), 0) + ex);
    return { inflow, outflow, net: br2(inflow - outflow), by_mode: grp(inR, 'mode'), by_bank: grp(inR, 'acc') };
  };
  const cash = await flow(from, to), cashPrev = await flow(pfrom, pto);
  cash.prev = { inflow: cashPrev.inflow, outflow: cashPrev.outflow, net: cashPrev.net };
  // 4. expenses by category
  let expenses = null;
  if (buy) { const ep = [from, to]; const ew = B(ep, 'e');
    const cats = (await q(`SELECT COALESCE(category,'Other') c, SUM(amount) x FROM bl_expenses e WHERE exp_date BETWEEN $1 AND $2 AND ${ew} GROUP BY 1 ORDER BY 2 DESC`, ep)).rows.map(r => [r.c, N(r.x)]);
    expenses = { total: overview.expenses, prev: overview.prev.expenses, top: cats }; }
  // 5. customers
  let customers = null;
  if (sell) {
    const cp = []; let sc = custScope(u, cp); const bb = u.brand_id && !isSuper(u) ? 0 : +Q.brand || 0; if (bb) { cp.push(bb); sc += ` AND c.brand_id=$${cp.length}`; }
    const total = (await q(`SELECT COUNT(*)::int n FROM customers c WHERE ${sc}`, cp)).rows[0].n;
    const act = async (a, z) => { const pp = [a, z]; const w = B(pp); return (await q(`SELECT COUNT(DISTINCT customer_id)::int active, COUNT(*) FILTER (WHERE k>1)::int rep FROM (SELECT customer_id, COUNT(*) k FROM bl_docs d WHERE type='invoice' AND ${LIVE} AND doc_date BETWEEN $1 AND $2 AND ${w} GROUP BY customer_id) t`, pp)).rows[0]; };
    const c1 = await act(from, to), c0 = await act(pfrom, pto);
    const pp = [from, to]; const w = B(pp);
    const top = (await q(`SELECT d.customer_id id, COALESCE(MAX(d.party->>'company'),MAX(d.party->>'name')) name, COUNT(*)::int orders, SUM(d.total) amt FROM bl_docs d WHERE type='invoice' AND ${LIVE} AND doc_date BETWEEN $1 AND $2 AND ${w} GROUP BY d.customer_id ORDER BY amt DESC LIMIT 10`, pp)).rows.map(r => ({ id: r.id, name: r.name, orders: r.orders, amount: N(r.amt) }));
    customers = { total, active: c1.active, prev_active: c0.active, repeat: c1.rep, prev_repeat: c0.rep, with_dues: receivables.parties, top };
  }
  // 6. vendors
  let vendors = null;
  if (buy) {
    const total = (await q(`SELECT COUNT(*)::int n FROM bl_vendors`)).rows[0].n;
    const act = async (a, z) => { const pp = [a, z]; const w = B(pp); return (await q(`SELECT COUNT(DISTINCT vendor_id)::int n FROM bl_docs d WHERE type='purchase' AND ${LIVE} AND doc_date BETWEEN $1 AND $2 AND ${w}`, pp)).rows[0].n; };
    const pp = [from, to]; const w = B(pp);
    const top = (await q(`SELECT d.vendor_id id, COALESCE(MAX(d.party->>'company'),MAX(d.party->>'name')) name, COUNT(*)::int orders, SUM(d.total) amt FROM bl_docs d WHERE type='purchase' AND ${LIVE} AND doc_date BETWEEN $1 AND $2 AND ${w} GROUP BY d.vendor_id ORDER BY amt DESC LIMIT 10`, pp)).rows.map(r => ({ id: r.id, name: r.name, orders: r.orders, amount: N(r.amt) }));
    vendors = { total, active: await act(from, to), prev_active: await act(pfrom, pto), with_dues: payables.parties, top };
  }
  // 7. products & categories from invoice lines (credit notes taken off)
  let products = null, categories = null;
  if (sell) {
    const lines = async (a, z) => { const pp = [a, z]; const w = B(pp);
      return (await q(`SELECT d.id doc, d.type, (l->>'pid')::int pid, l->>'name' name, COALESCE(NULLIF(l->>'cat',''), p.category, 'No category') cat, (l->>'qty')::numeric qty, (l->>'taxable')::numeric amt
        FROM bl_docs d CROSS JOIN LATERAL jsonb_array_elements(d.items) l LEFT JOIN bl_products p ON p.id=(l->>'pid')::int
        WHERE d.type IN ('invoice','credit_note') AND ${LIVE} AND d.doc_date BETWEEN $1 AND $2 AND ${w}`, pp)).rows; };
    const L1 = await lines(from, to), L0 = await lines(pfrom, pto), sg = r => r.type === 'credit_note' ? -1 : 1;
    const units = L => br2(L.reduce((t, r) => t + sg(r) * N(r.qty), 0));
    const pm = {}; L1.forEach(r => { const k = r.pid ? 'p' + r.pid : 'n' + String(r.name).toLowerCase(); const x = pm[k] = pm[k] || { name: r.name, units: 0, amount: 0 }; x.units += sg(r) * N(r.qty); x.amount += sg(r) * N(r.amt); });
    const act = (await q(`SELECT COUNT(*)::int n FROM bl_products WHERE active`)).rows[0].n;
    products = { active: act, units: units(L1), prev_units: units(L0), top: Object.values(pm).sort((x, y) => y.amount - x.amount).slice(0, 10).map(x => ({ ...x, units: br2(x.units), amount: br2(x.amount) })) };
    const cm = {}; L1.forEach(r => { const x = cm[r.cat] = cm[r.cat] || { name: r.cat, units: 0, amount: 0, docs: new Set() }; x.units += sg(r) * N(r.qty); x.amount += sg(r) * N(r.amt); if (sg(r) > 0) x.docs.add(r.doc); });
    const cl = Object.values(cm).map(x => ({ name: x.name, units: br2(x.units), amount: br2(x.amount), orders: x.docs.size })).sort((x, y) => y.amount - x.amount);
    const tot = cl.reduce((t, x) => t + Math.max(0, x.amount), 0);
    categories = { active: cl.filter(x => x.amount > 0).length, top_share: tot && cl[0] ? Math.round(cl[0].amount / tot * 100) : 0, avg: cl.length ? br2(tot / cl.length) : 0, list: cl.slice(0, 15) };
  }
  // 8. inventory health
  const inv = (await q(`SELECT COUNT(*) FILTER (WHERE stock<=0)::int out, COUNT(*) FILTER (WHERE stock>0 AND stock<=low_stock)::int low, COUNT(*) FILTER (WHERE stock>low_stock AND stock>0)::int ok FROM bl_products WHERE active AND kind='product'`)).rows[0];
  res.json({ from, to, pfrom, pto, days, step, buckets, overview, receivables, payables, cash, expenses, customers, vendors, products, categories, inventory: inv });
}));
app.get('/api/bl/summary', need('billing', 'purchases'), wrap(async (req, res) => {
  const { from, to } = blRange(req.query), p = [from, to], bw = blBrandW(req.user, req.query, p);
  const s = (await q(`SELECT
    COALESCE(SUM(total) FILTER (WHERE type='invoice'),0) sales, COUNT(*) FILTER (WHERE type='invoice')::int invoices,
    COALESCE(SUM(total) FILTER (WHERE type='credit_note'),0) returns, COALESCE(SUM(total) FILTER (WHERE type='purchase'),0) purchases,
    COALESCE(SUM(total) FILTER (WHERE type='quotation'),0) quoted, COUNT(*) FILTER (WHERE type='quotation')::int quotes, COUNT(*) FILTER (WHERE type='quotation' AND status IN ('Converted','Accepted'))::int quotes_won
    FROM bl_docs d WHERE status NOT IN ('Cancelled','Draft') AND doc_date BETWEEN $1 AND $2 AND ${bw}`, p)).rows[0];
  const p2 = [from, to], bw2 = blBrandW(req.user, req.query, p2);
  const rc = (await q(`SELECT COALESCE(SUM(pm.amount) FILTER (WHERE d.type='invoice'),0) received, COALESCE(SUM(pm.amount) FILTER (WHERE d.type='purchase'),0) paid_out FROM bl_payments pm JOIN bl_docs d ON d.id=pm.doc_id WHERE pm.pay_date BETWEEN $1 AND $2 AND ${bw2}`, p2)).rows[0];
  const p3 = [], bw3 = blBrandW(req.user, req.query, p3);
  const due = (await q(`SELECT COALESCE(SUM(total-paid-credited) FILTER (WHERE type='invoice'),0) receivable, COALESCE(SUM(total-paid) FILTER (WHERE type='purchase'),0) payable,
    COALESCE(SUM(total-paid-credited) FILTER (WHERE type='invoice' AND due_date<CURRENT_DATE),0) overdue FROM bl_docs d WHERE status IN ('Unpaid','Partial') AND ${bw3}`, p3)).rows[0];
  const p4 = [from, to], bw4 = blBrandW(req.user, req.query, p4, 'e');
  const ex = (await q(`SELECT COALESCE(SUM(amount),0) expenses FROM bl_expenses e WHERE exp_date BETWEEN $1 AND $2 AND ${bw4}`, p4)).rows[0];
  const p5 = [], bw5 = blBrandW(req.user, req.query, p5);
  const trend = (await q(`SELECT to_char(date_trunc('month',doc_date),'YYYY-MM') m, COALESCE(SUM(total) FILTER (WHERE type='invoice'),0) sales, COALESCE(SUM(total) FILTER (WHERE type='purchase'),0) purchases
    FROM bl_docs d WHERE status NOT IN ('Cancelled','Draft') AND doc_date>=date_trunc('month',CURRENT_DATE)-interval '5 months' AND ${bw5} GROUP BY 1 ORDER BY 1`, p5)).rows;
  const low = (await q(`SELECT id, name, stock, low_stock, unit FROM bl_products WHERE active AND kind='product' AND stock<=low_stock ORDER BY stock LIMIT 8`)).rows;
  const p6 = [], bw6 = blBrandW(req.user, req.query, p6);
  const top = (await q(`SELECT d.customer_id id, MAX(d.party->>'name') name, MAX(d.party->>'phone') phone, SUM(d.total-d.paid-d.credited) due, MIN(d.due_date) oldest FROM bl_docs d WHERE d.type='invoice' AND d.status IN ('Unpaid','Partial') AND ${bw6} GROUP BY d.customer_id ORDER BY due DESC LIMIT 6`, p6)).rows;
  const n = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' && !['phone', 'name', 'm', 'oldest'].includes(k) && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v]));
  res.json({ from, to, ...n(s), ...n(rc), ...n(due), ...n(ex), trend: trend.map(n), low, top: top.map(n) });
}));
app.get('/api/bl/reports/:kind', need('billing', 'purchases'), wrap(async (req, res) => {
  const { from, to } = blRange(req.query), k = req.params.kind, p = [from, to], bw = blBrandW(req.user, req.query, p);
  const buyK = ['purchases', 'expenses', 'pnl', 'gst_purchase', 'vendors'];
  if (buyK.includes(k) && !can(req.user, 'purchases')) return res.status(403).json({ error: 'Not allowed' });
  let cols, rows;
  if (k === 'sales' || k === 'purchases') {
    cols = [['doc_date', 'Date'], ['no', 'No'], ['party', k === 'sales' ? 'Customer' : 'Vendor'], ['gstin', 'GSTIN'], ['sub', 'Taxable', 'n'], ['cgst', 'CGST', 'n'], ['sgst', 'SGST', 'n'], ['igst', 'IGST', 'n'], ['total', 'Total', 'n'], ['paid', 'Paid', 'n'], ['due', 'Due', 'n'], ['status', 'Status']];
    rows = (await q(`SELECT to_char(doc_date,'YYYY-MM-DD') doc_date, no, COALESCE(party->>'company',party->>'name') party, party->>'gstin' gstin, sub, cgst, sgst, igst, total, paid, total-paid-credited due, status, id FROM bl_docs d WHERE type=$${p.length + 1} AND status NOT IN ('Cancelled','Draft') AND doc_date BETWEEN $1 AND $2 AND ${bw} ORDER BY doc_date, id`, [...p, k === 'sales' ? 'invoice' : 'purchase'])).rows;
  } else if (k === 'gst_sales' || k === 'gst_purchase') {   // GST summary by tax rate (GSTR-1 / 3B helper)
    cols = [['rate', 'GST rate'], ['taxable', 'Taxable', 'n'], ['cgst', 'CGST', 'n'], ['sgst', 'SGST', 'n'], ['igst', 'IGST', 'n'], ['tax', 'Total tax', 'n'], ['b2b', 'B2B invoices'], ['b2c', 'B2C invoices']];
    const docs = (await q(`SELECT d.inter, d.items, d.type, d.party->>'gstin' gstin FROM bl_docs d WHERE type=ANY($${p.length + 1}) AND status NOT IN ('Cancelled','Draft') AND doc_date BETWEEN $1 AND $2 AND ${bw}`, [...p, k === 'gst_sales' ? ['invoice', 'credit_note'] : ['purchase']])).rows;
    const m = {}; docs.forEach(d => { const sg = d.type === 'credit_note' ? -1 : 1, b2b = !!d.gstin; (d.items || []).forEach(l => { const x = m[l.tax] = m[l.tax] || { rate: l.tax + '%', taxable: 0, cgst: 0, sgst: 0, igst: 0, tax: 0, b2b: 0, b2c: 0, _r: +l.tax };
      x.taxable += sg * l.taxable; x.tax += sg * l.tax_amt; if (d.inter) x.igst += sg * l.tax_amt; else { x.cgst += sg * l.tax_amt / 2; x.sgst += sg * l.tax_amt / 2; } }); const rs = new Set((d.items || []).map(l => l.tax)); rs.forEach(r => { m[r][b2b ? 'b2b' : 'b2c']++; }); });
    rows = Object.values(m).sort((a, b) => a._r - b._r).map(x => { ['taxable', 'cgst', 'sgst', 'igst', 'tax'].forEach(kk => x[kk] = br2(x[kk])); delete x._r; return x; });
  } else if (k === 'hsn') {
    cols = [['hsn', 'HSN/SAC'], ['name', 'Description'], ['qty', 'Qty', 'n'], ['taxable', 'Taxable', 'n'], ['tax', 'Tax', 'n'], ['amount', 'Total', 'n']];
    const docs = (await q(`SELECT d.items, d.type FROM bl_docs d WHERE type IN ('invoice','credit_note') AND status NOT IN ('Cancelled','Draft') AND doc_date BETWEEN $1 AND $2 AND ${bw}`, p)).rows, m = {};
    docs.forEach(d => (d.items || []).forEach(l => { const sg = d.type === 'credit_note' ? -1 : 1, key = (l.hsn || '—') + '|' + l.tax, x = m[key] = m[key] || { hsn: (l.hsn || '—') + ` @${l.tax}%`, name: l.name, qty: 0, taxable: 0, tax: 0, amount: 0 }; x.qty += sg * l.qty; x.taxable += sg * l.taxable; x.tax += sg * l.tax_amt; x.amount += sg * l.amount; }));
    rows = Object.values(m).map(x => ({ ...x, qty: br2(x.qty), taxable: br2(x.taxable), tax: br2(x.tax), amount: br2(x.amount) }));
  } else if (k === 'items') {   // item-wise sales with profit (selling taxable − purchase price)
    cols = [['name', 'Item'], ['qty', 'Qty sold', 'n'], ['taxable', 'Sales (taxable)', 'n'], ['cost', 'Cost', 'n'], ['profit', 'Profit', 'n']];
    const docs = (await q(`SELECT d.items, d.type FROM bl_docs d WHERE type IN ('invoice','credit_note') AND status NOT IN ('Cancelled','Draft') AND doc_date BETWEEN $1 AND $2 AND ${bw}`, p)).rows, m = {};
    const pp = Object.fromEntries((await q('SELECT id, purchase_price FROM bl_products')).rows.map(r => [r.id, Number(r.purchase_price)]));
    docs.forEach(d => (d.items || []).forEach(l => { const sg = d.type === 'credit_note' ? -1 : 1, key = l.pid || l.name, x = m[key] = m[key] || { name: l.name, qty: 0, taxable: 0, cost: 0 }; x.qty += sg * l.qty; x.taxable += sg * l.taxable; x.cost += sg * l.qty * (pp[l.pid] || 0); }));
    rows = Object.values(m).map(x => ({ name: x.name, qty: br2(x.qty), taxable: br2(x.taxable), cost: br2(x.cost), profit: br2(x.taxable - x.cost) })).sort((a, b) => b.taxable - a.taxable);
  } else if (k === 'parties') {
    cols = [['name', 'Customer'], ['phone', 'Phone'], ['invoices', 'Invoices', 'n'], ['total', 'Billed', 'n'], ['paid', 'Received', 'n'], ['due', 'Due', 'n']];
    rows = (await q(`SELECT COALESCE(MAX(party->>'company'),MAX(party->>'name')) name, MAX(party->>'phone') phone, COUNT(*)::int invoices, SUM(total) total, SUM(paid) paid, SUM(total-paid-credited) due, customer_id id FROM bl_docs d WHERE type='invoice' AND status NOT IN ('Cancelled','Draft') AND doc_date BETWEEN $1 AND $2 AND ${bw} GROUP BY customer_id ORDER BY total DESC`, p)).rows;
  } else if (k === 'payments') {
    cols = [['pay_date', 'Date'], ['no', 'Document'], ['party', 'Party'], ['kind', 'Type'], ['mode', 'Mode'], ['account', 'Account'], ['amount', 'Amount', 'n'], ['by_name', 'By']];
    rows = (await q(`SELECT to_char(pm.pay_date,'YYYY-MM-DD') pay_date, d.no, COALESCE(d.party->>'company',d.party->>'name') party, CASE WHEN d.type='purchase' THEN 'Paid out' ELSE 'Received' END kind, pm.mode, pm.account, pm.amount, pm.by_name, d.id FROM bl_payments pm JOIN bl_docs d ON d.id=pm.doc_id WHERE pm.pay_date BETWEEN $1 AND $2 AND ${bw} ${can(req.user, 'purchases') ? '' : "AND d.type<>'purchase'"} ORDER BY pm.pay_date, pm.id`, p)).rows;
  } else if (k === 'stock') {
    cols = [['name', 'Item'], ['sku', 'Code'], ['category', 'Category'], ['stock', 'In stock', 'n'], ['unit', 'Unit'], ['purchase_price', 'Cost price', 'n'], ['value', 'Stock value', 'n'], ['low', 'Low stock']];
    rows = (await q(`SELECT name, sku, category, stock, unit, purchase_price, stock*purchase_price value, CASE WHEN stock<=low_stock THEN 'Low' ELSE '' END low, id FROM bl_products WHERE active AND kind='product' ORDER BY lower(name)`)).rows;
  } else if (k === 'expenses') {
    cols = [['category', 'Category'], ['count', 'Entries', 'n'], ['amount', 'Amount', 'n']];
    const pe = [from, to], bwe = blBrandW(req.user, req.query, pe, 'e');
    rows = (await q(`SELECT category, COUNT(*)::int count, SUM(amount) amount FROM bl_expenses e WHERE exp_date BETWEEN $1 AND $2 AND ${bwe} GROUP BY category ORDER BY amount DESC`, pe)).rows;
  } else if (k === 'pnl') {
    cols = [['line', 'Item'], ['amount', 'Amount', 'n']];
    const s = (await q(`SELECT COALESCE(SUM(sub) FILTER (WHERE type='invoice'),0) sales, COALESCE(SUM(sub) FILTER (WHERE type='credit_note'),0) ret, COALESCE(SUM(sub) FILTER (WHERE type='purchase'),0) pur FROM bl_docs d WHERE status NOT IN ('Cancelled','Draft') AND doc_date BETWEEN $1 AND $2 AND ${bw}`, p)).rows[0];
    const pe = [from, to], bwe = blBrandW(req.user, req.query, pe, 'e');
    const ex = Number((await q(`SELECT COALESCE(SUM(amount-tax),0) e FROM bl_expenses e WHERE exp_date BETWEEN $1 AND $2 AND ${bwe}`, pe)).rows[0].e);
    const net = br2(+s.sales - +s.ret), gp = br2(net - +s.pur);
    rows = [{ line: 'Sales (before tax)', amount: br2(s.sales) }, { line: '− Sales returns (credit notes)', amount: br2(s.ret) }, { line: 'Net sales', amount: net, b: 1 }, { line: '− Purchases (before tax)', amount: br2(s.pur) }, { line: 'Gross profit', amount: gp, b: 1 }, { line: '− Expenses', amount: br2(ex) }, { line: 'Net profit', amount: br2(gp - ex), b: 1 }];
  } else return res.status(404).json({ error: 'Unknown report' });
  rows.forEach(r => cols.forEach(c => { if (c[2] === 'n') r[c[0]] = Number(r[c[0]] || 0); }));
  const sums = Object.fromEntries(cols.filter(c => c[2] === 'n' && !['purchase_price', 'stock', 'rate'].includes(c[0]) && k !== 'pnl').map(c => [c[0], br2(rows.reduce((t, r) => t + r[c[0]], 0))]));
  if (req.query.format === 'xlsx') {
    const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet(k);
    ws.columns = cols.map(c => ({ header: c[1], key: c[0], width: c[2] === 'n' ? 14 : 24 }));
    rows.forEach(r => ws.addRow(r)); if (Object.keys(sums).length) ws.addRow({ [cols[0][0]]: 'TOTAL', ...sums });
    ws.getRow(1).font = { bold: true };
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.setHeader('Content-Disposition', `attachment; filename="${k}_${from}_${to}.xlsx"`);
    return wb.xlsx.write(res).then(() => res.end());
  }
  res.json({ from, to, cols, rows, sums });
}));

// ---------- import (Swipe / any Excel or CSV) & export ----------
const BL_FIELDS = {
  products: { name: ['item name', 'product name', 'name', 'item', 'product', 'item description', 'particulars'], sku: ['item code', 'product code', 'sku', 'code', 'barcode', 'item id'], hsn: ['hsn', 'hsn sac', 'hsn code', 'sac', 'hsn sac code', 'hsnsac'],
    unit: ['unit', 'units', 'uqc', 'unit of measurement', 'measuring unit', 'uom'], price: ['selling price', 'sale price', 'sales price', 'price', 'unit price', 'rate', 'mrp', 'selling rate', 'price per unit'], purchase_price: ['purchase price', 'cost price', 'buying price', 'purchase rate', 'cost'],
    tax: ['tax', 'gst', 'tax rate', 'gst rate', 'tax percent', 'gst percent', 'tax percentage', 'gst percentage', 'igst', 'igst rate'], category: ['category', 'group', 'item category', 'product category'], description: ['description', 'product description', 'details', 'notes'],
    stock: ['opening stock', 'stock', 'quantity', 'qty', 'opening quantity', 'current stock', 'available stock', 'stock quantity', 'closing stock'], low_stock: ['low stock', 'alert quantity', 'low stock alert', 'reorder level', 'min stock', 'minimum stock'],
    kind: ['type', 'item type', 'product type', 'product or service'], price_incl: ['price includes tax', 'tax inclusive', 'inclusive of tax', 'with tax', 'price with tax', 'tax included'] },
  customers: { name: ['name', 'customer name', 'party name', 'contact name', 'contact person', 'customer'], company: ['company', 'company name', 'business name', 'firm name', 'organisation', 'organization', 'trade name'],
    phone: ['phone', 'mobile', 'phone number', 'mobile number', 'contact', 'contact number', 'whatsapp', 'mobile no', 'phone no', 'contact no'], email: ['email', 'email id', 'email address', 'mail'],
    gstin: ['gstin', 'gst', 'gst number', 'gstin uin', 'gst no', 'gstin number', 'gst in'], address: ['address', 'billing address', 'address line 1', 'billing address line 1', 'address 1', 'street'], city: ['city', 'billing city', 'town'],
    state: ['state', 'billing state', 'place of supply', 'state name'], pincode: ['pincode', 'pin', 'zip', 'postal code', 'pin code', 'billing pincode'], ship_address: ['shipping address', 'shipping address line 1', 'delivery address', 'ship to address'], ship_name: ['shipping name', 'ship to name', 'delivery name', 'shipping contact'], ship_phone: ['shipping phone', 'shipping mobile', 'delivery phone', 'shipping contact number'],
    ship_city: ['shipping city', 'delivery city'], ship_state: ['shipping state', 'delivery state'], ship_pincode: ['shipping pincode', 'shipping pin code', 'shipping zip', 'delivery pincode'],
    opening_bal: ['opening balance', 'balance', 'closing balance', 'outstanding', 'balance due', 'receivable'] },
};
BL_FIELDS.vendors = { ...BL_FIELDS.customers, name: ['name', 'vendor name', 'supplier name', 'party name', 'contact name', 'vendor', 'supplier'], opening_bal: ['opening balance', 'balance', 'payable', 'closing balance', 'outstanding'] };
const blNorm = s => String(s || '').toLowerCase().replace(/[%()\/_.\-:#]/g, ' ').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const blAutoMap = (what, headers) => {
  const F = BL_FIELDS[what], H = headers.map(blNorm), map = {}, used = new Set();
  for (const pass of [0, 1]) for (const [f, syn] of Object.entries(F)) {
    if (map[f] !== undefined) continue;
    const i = H.findIndex((h, j) => !used.has(j) && (pass === 0 ? syn.includes(h) : syn.some(s => s.length > 3 && (h.startsWith(s + ' ') || h.endsWith(' ' + s) || h.includes(' ' + s + ' ')))));
    if (i >= 0) { map[f] = i; used.add(i); }
  }
  return map;
};
const blCsv = txt => {     // RFC-4180-ish CSV / TSV
  const sep = (txt.split('\n')[0].match(/\t/g) || []).length > (txt.split('\n')[0].match(/,/g) || []).length ? '\t' : ',';
  const rows = []; let row = [], cur = '', qd = false;
  for (let i = 0; i < txt.length; i++) { const c = txt[i];
    if (qd) { if (c === '"') { if (txt[i + 1] === '"') { cur += '"'; i++; } else qd = false; } else cur += c; }
    else if (c === '"') qd = true; else if (c === sep) { row.push(cur); cur = ''; } else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; } else if (c !== '\r') cur += c; }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
};
const blCell = v => { if (v == null) return ''; if (typeof v === 'object') { if (v.richText) return v.richText.map(t => t.text).join(''); if (v.text) return String(v.text); if (v.result !== undefined) return String(v.result); if (v instanceof Date) return v.toISOString().slice(0, 10); return ''; } return String(v); };
const blReadSheet = async (dataUrl, fname) => {
  const m = /^data:([^;]*);base64,(.+)$/.exec(String(dataUrl || '')); if (!m) throw new Error('Choose an Excel (.xlsx) or CSV file');
  const buf = Buffer.from(m[2], 'base64'), ext = String(fname || '').toLowerCase().split('.').pop();
  if (buf.length > 15e6) throw new Error('File is too big (max 15 MB)');
  let rows;
  if (ext === 'csv' || ext === 'txt' || ext === 'tsv' || /csv|text\/plain/.test(m[1])) rows = blCsv(buf.toString('utf8').replace(/^﻿/, ''));
  else if (ext === 'xls') throw new Error('Old .xls files aren’t supported — open it in Excel / Google Sheets and save as .xlsx or CSV');
  else { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); const ws = wb.worksheets.find(w => w.actualRowCount > 1) || wb.worksheets[0]; if (!ws) throw new Error('The file has no sheets');
    rows = []; ws.eachRow({ includeEmpty: false }, r => { const a = []; for (let i = 1; i <= r.cellCount; i++) a.push(blCell(r.getCell(i).value).trim()); rows.push(a); }); }
  rows = rows.filter(r => r.some(c => String(c).trim()));
  // header row = the first row (within the first 10) that matches the most known column names
  let best = 0, bi = 0; rows.slice(0, 10).forEach((r, i) => { const n = r.filter(c => Object.values(BL_FIELDS).some(F => Object.values(F).some(s => s.includes(blNorm(c))))).length; if (n > best) { best = n; bi = i; } });
  return { headers: (rows[bi] || []).map(String), rows: rows.slice(bi + 1) };
};
const BL_IMP = new Map();
app.post('/api/bl/import/preview', need('billing', 'purchases'), wrap(async (req, res) => {
  const b = req.body || {}, what = b.what; if (!BL_FIELDS[what]) return res.status(400).json({ error: 'Choose what to import' });
  if (what === 'vendors' && !can(req.user, 'purchases')) return res.status(403).json({ error: 'Not allowed' });
  let s; try { s = await blReadSheet(b.file, b.fname); } catch (e) { return res.status(400).json({ error: e.message || 'Could not read the file' }); }
  if (!s.rows.length) return res.status(400).json({ error: 'No rows found in the file' });
  const token = crypto.randomBytes(9).toString('hex'); BL_IMP.set(token, { what, ...s, at: Date.now(), uid: req.user.id });
  for (const [k, v] of BL_IMP) if (Date.now() - v.at > 1800e3) BL_IMP.delete(k);
  res.json({ token, headers: s.headers, sample: s.rows.slice(0, 5), count: s.rows.length, map: blAutoMap(what, s.headers), fields: Object.keys(BL_FIELDS[what]) });
}));
const blNum = v => { const n = parseFloat(String(v ?? '').replace(/[₹,\s%]/g, '').replace(/^rs\.?/i, '')); return isFinite(n) ? n : 0; };
const blYes = v => /^(y|yes|true|1|inclusive|incl|with tax)/i.test(String(v || '').trim());
app.post('/api/bl/import/commit', need('billing', 'purchases'), wrap(async (req, res) => {
  const b = req.body || {}, job = BL_IMP.get(b.token);
  if (!job || job.uid !== req.user.id) return res.status(400).json({ error: 'Please choose the file again' });
  const map = b.map || {}, upd = b.mode !== 'skip', R = { created: 0, updated: 0, skipped: 0, errors: [] };
  const get = (row, f) => map[f] === undefined || map[f] === null || map[f] === '' ? undefined : String(row[+map[f]] ?? '').trim();
  if (map.name === undefined && job.what === 'products') return res.status(400).json({ error: 'Choose which column has the product name' });
  const brandId = blUserBrand(req.user, b.brand_id) || await blDefBrand(req.user);
  for (let i = 0; i < job.rows.length; i++) {
    const row = job.rows[i], ln = i + 2;
    try {
      if (job.what === 'products') {
        const name = get(row, 'name'); if (!name) { R.skipped++; continue; }
        const o = blProdIn({ name, sku: get(row, 'sku'), hsn: get(row, 'hsn'), unit: get(row, 'unit'), category: get(row, 'category'), description: get(row, 'description') });
        Object.keys(o).forEach(k => o[k] === undefined && delete o[k]); if (get(row, 'unit') === undefined || !o.unit) delete o.unit;
        for (const k of ['price', 'purchase_price', 'low_stock']) { const v = get(row, k); if (v !== undefined && v !== '') o[k] = Math.max(0, blNum(v)); }
        const tx = get(row, 'tax'); if (tx !== undefined && tx !== '') { let t = blNum(tx); if (t > 0 && t < 1) t = t * 100; o.tax = Math.min(40, t); }
        const kd = get(row, 'kind'); if (kd) o.kind = /serv/i.test(kd) ? 'service' : 'product';
        const inc = get(row, 'price_incl'); if (inc !== undefined) o.price_incl = blYes(inc);
        else if (map.price !== undefined && /incl|with tax/i.test(job.headers[+map.price] || '')) o.price_incl = true;
        const ex = (o.sku && (await q('SELECT * FROM bl_products WHERE lower(sku)=lower($1)', [o.sku])).rows[0]) || (await q('SELECT * FROM bl_products WHERE lower(name)=lower($1) ORDER BY active DESC, id LIMIT 1', [o.name])).rows[0];
        const stv = get(row, 'stock'), st = stv !== undefined && stv !== '' ? blNum(stv) : null;
        if (ex) { if (!upd) { R.skipped++; continue; }
          o.active = true; const ks = Object.keys(o); await q(`UPDATE bl_products SET ${ks.map((k, j) => `${k}=$${j + 2}`).join(',')}, updated_at=now() WHERE id=$1`, [ex.id, ...ks.map(k => o[k])]);
          if (st !== null && st !== Number(ex.stock) && (o.kind || ex.kind) !== 'service') await blStockMove(ex.id, st - Number(ex.stock), 'Adjust', null, 'Import', req.user.name);
          R.updated++;
        } else { const ks = Object.keys(o); const r = (await q(`INSERT INTO bl_products(${ks.join(',')}) VALUES(${ks.map((_, j) => '$' + (j + 1)).join(',')}) RETURNING id`, ks.map(k => o[k]))).rows[0];
          if (st) await blStockMove(r.id, st, 'Opening', null, 'Import', req.user.name); R.created++; }
      } else {
        const raw = {}; for (const f of Object.keys(BL_FIELDS[job.what])) { const v = get(row, f); if (v !== undefined) raw[f] = v; }
        if (raw.opening_bal !== undefined) raw.opening_bal = blNum(raw.opening_bal);
        const o = blCustIn(raw); Object.keys(o).forEach(k => (o[k] === undefined || o[k] === null) && delete o[k]);
        if (o.gstin && !blGstOk(o.gstin)) { R.errors.push(`Row ${ln}: GSTIN ${o.gstin} looks wrong — saved without it`); delete o.gstin; }
        o.name = o.name || o.company; if (!o.name && !o.phone) { R.skipped++; continue; }
        const ph = digits(o.phone).slice(-10);
        if (job.what === 'vendors') {
          delete o.city; delete o.pincode; for (const k of Object.keys(o)) if (k.startsWith('ship_')) delete o[k];
          const ex = (ph.length >= 7 && (await q(`SELECT id FROM bl_vendors WHERE right(regexp_replace(COALESCE(phone,''),'\\D','','g'),10)=$1`, [ph])).rows[0]) || (o.gstin && (await q('SELECT id FROM bl_vendors WHERE gstin=$1', [o.gstin])).rows[0]) || (await q('SELECT id FROM bl_vendors WHERE lower(name)=lower($1)', [o.name])).rows[0];
          if (ex) { if (!upd) { R.skipped++; continue; } const ks = Object.keys(o); await q(`UPDATE bl_vendors SET ${ks.map((k, j) => `${k}=$${j + 2}`).join(',')} WHERE id=$1`, [ex.id, ...ks.map(k => o[k])]); R.updated++; }
          else { const ks = Object.keys(o); await q(`INSERT INTO bl_vendors(${ks.join(',')}) VALUES(${ks.map((_, j) => '$' + (j + 1)).join(',')})`, ks.map(k => o[k])); R.created++; }
        } else {
          o.name = o.name || 'Customer ' + ph.slice(-4);
          const ex = (ph.length >= 7 && (await q(`SELECT id FROM customers WHERE right(regexp_replace(COALESCE(phone,''),'\\D','','g'),10)=$1 ORDER BY id LIMIT 1`, [ph])).rows[0]) || (o.gstin && (await q('SELECT id FROM customers WHERE gstin=$1 ORDER BY id LIMIT 1', [o.gstin])).rows[0]) || (!ph && (await q('SELECT id FROM customers WHERE lower(name)=lower($1) AND phone IS NULL ORDER BY id LIMIT 1', [o.name])).rows[0]);
          if (ex) { if (!upd) { R.skipped++; continue; } const ks = Object.keys(o); await q(`UPDATE customers SET ${ks.map((k, j) => `${k}=$${j + 2}`).join(',')} WHERE id=$1`, [ex.id, ...ks.map(k => o[k])]); R.updated++; }
          else { o.brand_id = brandId; const ks = Object.keys(o); await q(`INSERT INTO customers(${ks.join(',')}) VALUES(${ks.map((_, j) => '$' + (j + 1)).join(',')})`, ks.map(k => o[k])); R.created++; }
        }
      }
    } catch (e) { R.errors.push(`Row ${ln}: ${e.message}`); }
  }
  BL_IMP.delete(b.token); R.errors = R.errors.slice(0, 50); res.json({ ok: true, ...R });
}));
app.get('/api/bl/import/template/:what', need('billing', 'purchases'), wrap(async (req, res) => {
  const what = req.params.what; if (!BL_FIELDS[what]) return res.status(404).end();
  const heads = { products: ['Item Name', 'Item Code', 'HSN/SAC', 'Unit', 'Selling Price', 'Purchase Price', 'GST %', 'Category', 'Opening Stock', 'Low Stock Alert', 'Description', 'Type (Product/Service)'],
    customers: ['Name', 'Company Name', 'Phone', 'Email', 'GSTIN', 'Billing Address', 'City', 'State', 'Pincode', 'Shipping Name', 'Shipping Phone', 'Shipping Address', 'Shipping City', 'Shipping State', 'Shipping Pincode', 'Opening Balance'],
    vendors: ['Name', 'Company Name', 'Phone', 'Email', 'GSTIN', 'Address', 'State', 'Opening Balance'] }[what];
  const ex = { products: ['CCTV Camera 2MP', 'CAM-2MP', '8525', 'Nos', 2400, 1650, 18, 'CCTV', 10, 2, 'Dome camera with night vision', 'Product'], customers: ['Ravi Kumar', 'Ravi Traders', '9876543210', 'ravi@example.com', '33ABCDE1234F1Z5', '12 Anna Salai', 'Chennai', 'Tamil Nadu', '600002', 'Site supervisor', '9876500011', 'Plot 4, OMR', 'Chennai', 'Tamil Nadu', '600097', 0], vendors: ['Suresh', 'ABC Distributors', '9876500000', '', '33AAACA1234B1Z2', 'Ambattur, Chennai', 'Tamil Nadu', 0] }[what];
  const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet(what); ws.addRow(heads); ws.addRow(ex); ws.getRow(1).font = { bold: true }; ws.columns.forEach(c => c.width = 18);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.setHeader('Content-Disposition', `attachment; filename="rago_${what}_template.xlsx"`);
  await wb.xlsx.write(res); res.end();
}));
app.get('/api/bl/export/:what', need('billing', 'purchases'), wrap(async (req, res) => {
  const what = req.params.what, wb = new ExcelJS.Workbook(), ws = wb.addWorksheet(what);
  let cols, rows;
  if (what === 'products') { cols = [['name', 'Item Name'], ['sku', 'Item Code'], ['hsn', 'HSN/SAC'], ['unit', 'Unit'], ['price', 'Selling Price'], ['price_incl', 'Price includes tax'], ['purchase_price', 'Purchase Price'], ['tax', 'GST %'], ['category', 'Category'], ['stock', 'Stock'], ['low_stock', 'Low Stock Alert'], ['kind', 'Type'], ['description', 'Description']];
    rows = (await q('SELECT * FROM bl_products WHERE active ORDER BY lower(name)')).rows.map(r => ({ ...r, price_incl: r.price_incl ? 'Yes' : 'No', price: +r.price, purchase_price: +r.purchase_price, tax: +r.tax, stock: +r.stock, low_stock: +r.low_stock })); }
  else if (what === 'customers') { const p = ['%'], sc = custScope(req.user, p); cols = [['name', 'Name'], ['company', 'Company Name'], ['phone', 'Phone'], ['email', 'Email'], ['gstin', 'GSTIN'], ['address', 'Billing Address'], ['city', 'City'], ['state', 'State'], ['pincode', 'Pincode'], ['ship_name', 'Shipping Name'], ['ship_phone', 'Shipping Phone'], ['ship_address', 'Shipping Address'], ['ship_city', 'Shipping City'], ['ship_state', 'Shipping State'], ['ship_pincode', 'Shipping Pincode'], ['opening_bal', 'Opening Balance']];
    rows = (await q(`SELECT c.* FROM customers c WHERE c.name ILIKE $1 AND ${sc} ORDER BY lower(c.name)`, p)).rows.map(r => ({ ...r, opening_bal: +r.opening_bal || 0 })); }
  else if (what === 'vendors' && can(req.user, 'purchases')) { cols = [['name', 'Name'], ['company', 'Company Name'], ['phone', 'Phone'], ['email', 'Email'], ['gstin', 'GSTIN'], ['address', 'Address'], ['state', 'State'], ['opening_bal', 'Opening Balance']]; rows = (await q('SELECT * FROM bl_vendors ORDER BY lower(name)')).rows.map(r => ({ ...r, opening_bal: +r.opening_bal || 0 })); }
  else return res.status(404).json({ error: 'Unknown export' });
  ws.columns = cols.map(c => ({ header: c[1], key: c[0], width: 20 })); rows.forEach(r => ws.addRow(r)); ws.getRow(1).font = { bold: true };
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.setHeader('Content-Disposition', `attachment; filename="rago_${what}.xlsx"`);
  await wb.xlsx.write(res); res.end();
}));

// ===================== V29: branch-wise products, bill filters, delivery, call leads, email =====================
const blProdBrand = (u, Q, p, w, a = 'p') => { const b = +Q.brand || (u.brand_id && !isSuper(u) ? u.brand_id : 0); if (!b) return; p.push(b); w.push(`(${a}.brand_id IS NULL OR ${a}.brand_id=$${p.length})`); };
const BL_SORT = { amount: 'd.total, d.id', '-amount': 'd.total DESC, d.id DESC', no: 'd.seq, d.id', '-no': 'd.seq DESC, d.id DESC', customer: `lower(COALESCE(NULLIF(d.party->>'company',''),d.party->>'name')), d.id`,
  '-customer': `lower(COALESCE(NULLIF(d.party->>'company',''),d.party->>'name')) DESC, d.id DESC`, status: 'd.status, d.doc_date DESC', '-status': 'd.status DESC, d.doc_date DESC', date: 'd.doc_date, d.id', '-date': 'd.doc_date DESC, d.id DESC' };
async function initV29() {
  await q(`ALTER TABLE bl_products ADD COLUMN IF NOT EXISTS brand_id INT;
  ALTER TABLE bl_docs ADD COLUMN IF NOT EXISTS delivery JSONB;
  ALTER TABLE wc_cases ADD COLUMN IF NOT EXISTS transport JSONB DEFAULT '[]';
  CREATE TABLE IF NOT EXISTS bl_media (id SERIAL PRIMARY KEY, doc_id INT REFERENCES bl_docs(id) ON DELETE CASCADE, kind TEXT, data BYTEA, mime TEXT, created_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS call_devices (id SERIAL PRIMARY KEY, user_id INT NOT NULL, token_hash TEXT UNIQUE NOT NULL, name TEXT, sim_label TEXT, sim_slot INT, active BOOLEAN DEFAULT true, last_seen TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS calls (id SERIAL PRIMARY KEY, user_id INT NOT NULL, user_name TEXT, brand_id INT, device_id INT, phone TEXT NOT NULL, contact TEXT, direction TEXT, duration INT DEFAULT 0, sim_label TEXT,
    started_at TIMESTAMPTZ NOT NULL, status TEXT DEFAULT 'pending', lead_id INT, decided_by TEXT, decided_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now(), UNIQUE(user_id, phone, started_at));
  CREATE INDEX IF NOT EXISTS idx_calls_st ON calls(status, started_at DESC);
  CREATE TABLE IF NOT EXISTS user_mail (user_id INT PRIMARY KEY, email TEXT NOT NULL, from_name TEXT, signature TEXT, smtp_host TEXT, smtp_port INT, imap_host TEXT, imap_port INT, pass_enc TEXT NOT NULL, sent_folder TEXT, ok_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS mail_log (id SERIAL PRIMARY KEY, user_id INT, user_name TEXT, from_email TEXT, to_email TEXT, cc TEXT, subject TEXT, body TEXT, lead_id INT, customer_id INT, doc_id INT, service_id INT, created_at TIMESTAMPTZ DEFAULT now());
  CREATE INDEX IF NOT EXISTS idx_mail_lead ON mail_log(lead_id); CREATE INDEX IF NOT EXISTS idx_mail_cust ON mail_log(customer_id);`);
}
// one-time: give products a branch in bulk (empty = shared by all branches)
app.post('/api/bl/products/brand', blNeed, wrap(async (req, res) => {
  const b = req.body || {}, bid = +b.brand_id || null, ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Boolean);
  if (bid && !(await q('SELECT 1 FROM brands WHERE id=$1', [bid])).rows.length) return res.status(404).json({ error: 'Branch not found' });
  let r;
  if (ids.length) r = await q('UPDATE bl_products SET brand_id=$1, updated_at=now() WHERE id=ANY($2)', [bid, ids]);
  else if (b.category !== undefined) r = await q(`UPDATE bl_products SET brand_id=$1, updated_at=now() WHERE ${b.category ? 'category=$2' : 'true'} ${b.only_shared ? 'AND brand_id IS NULL' : ''}`, b.category ? [bid, String(b.category)] : [bid]);
  else return res.status(400).json({ error: 'Choose the products' });
  res.json({ ok: true, n: r.rowCount });
}));
// billing customer box: customers AND open leads of the branch
app.get('/api/bl/parties', need('billing'), wrap(async (req, res) => {
  const v = String(req.query.q || '').trim(), bid = +req.query.brand || 0, like = '%' + v + '%';
  const p = [like]; let sc = custScope(req.user, p); if (bid) { p.push(bid); sc += ` AND (c.brand_id=$${p.length} OR c.brand_id IS NULL)`; }
  const cust = (await q(`SELECT c.id, c.name, c.company, c.phone, c.email, c.gstin, c.state, c.city, c.address, c.pincode, c.ship_address, c.ship_name, c.ship_phone, c.ship_city, c.ship_pincode, c.ship_state, c.brand_id,
    COALESCE((SELECT SUM(d.total-d.paid-d.credited) FROM bl_docs d WHERE d.customer_id=c.id AND d.type='invoice' AND d.status NOT IN ('Cancelled','Draft')),0)+COALESCE(c.opening_bal,0) balance
    FROM customers c WHERE (c.name ILIKE $1 OR c.phone ILIKE $1 OR c.company ILIKE $1 OR c.gstin ILIKE $1) AND ${sc} ORDER BY lower(c.name) LIMIT 12`, p)).rows;
  let leads = [];
  if (can(req.user, 'leads')) {
    const lp = [like]; let ls = leadScope(req.user, lp); if (bid) { lp.push(bid); ls += ` AND l.brand_id=$${lp.length}`; }
    leads = (await q(`SELECT l.id lead_id, l.name, l.company, l.phone, l.email, l.address, l.stage, l.source, l.brand_id FROM leads l WHERE l.customer_id IS NULL AND COALESCE(l.stage,'') NOT IN ('Won','Lost')
      AND (l.name ILIKE $1 OR l.phone ILIKE $1 OR l.company ILIKE $1) AND ${ls} ORDER BY l.last_contact DESC NULLS LAST LIMIT 8`, lp)).rows;
  }
  res.json({ customers: cust, leads });
}));
// delivery: collected by the customer, or sent by transport (tracking no., details, photo)
const blDelivHTML = d => {
  const v = d.delivery; if (!v || !v.mode || !['invoice', 'challan'].includes(d.type)) return '';
  const e = x => bhe(String(x || ''));
  const rows = v.mode === 'transport'
    ? [['Delivery', 'By transport'], ['Transport', v.transporter], ['Tracking / LR no.', v.tracking], ['Vehicle no.', v.vehicle], ['Date', v.date ? bdIN(v.date) : ''], ['Details', v.info]]
    : [['Delivery', 'Collected by customer'], ['Collected by', v.person], ['Date', v.date ? bdIN(v.date) : ''], ['Details', v.info]];
  return `<div style="margin:-4px 0 14px;padding:10px 12px;border:1px dashed #ccc;border-radius:8px;font-size:12px"><b>🚚 ${rows[0][1]}</b>${rows.slice(1).filter(r => r[1]).map(r => ` · ${r[0]}: <b>${e(r[1])}</b>`).join('')}</div>`;
};
app.post('/api/bl/docs/:id/delivery', need('billing'), wrap(async (req, res) => {
  const d = await blLoad(req, res, +req.params.id); if (!d) return;
  if (!['invoice', 'challan'].includes(d.type)) return res.status(400).json({ error: 'Delivery is only for invoices and delivery challans' });
  const b = req.body || {}, t = (k, n = 200) => String(b[k] || '').trim().slice(0, n) || null;
  if (b.clear) { await q('UPDATE bl_docs SET delivery=NULL, updated_at=now() WHERE id=$1', [d.id]); await q(`DELETE FROM bl_media WHERE doc_id=$1 AND kind='delivery'`, [d.id]); return res.json({ ok: true }); }
  if (!['transport', 'collected'].includes(b.mode)) return res.status(400).json({ error: 'Choose transport or collected' });
  const v = { mode: b.mode, date: /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : (await todayIST()), info: t('info', 1000), by: req.user.name, at: new Date().toISOString() };
  if (b.mode === 'transport') { Object.assign(v, { transporter: t('transporter'), tracking: t('tracking', 80), vehicle: t('vehicle', 30) }); if (!v.transporter && !v.tracking) return res.status(400).json({ error: 'Enter the transport name or tracking number' }); }
  else v.person = t('person');
  if (b.photo) {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(String(b.photo)); if (!m) return res.status(400).json({ error: 'Photo must be an image' });
    const buf = Buffer.from(m[2], 'base64'); if (buf.length > 6e6) return res.status(400).json({ error: 'Photo is too big' });
    await q(`DELETE FROM bl_media WHERE doc_id=$1 AND kind='delivery'`, [d.id]);
    v.photo = (await q(`INSERT INTO bl_media(doc_id,kind,data,mime) VALUES($1,'delivery',$2,$3) RETURNING id`, [d.id, buf, m[1]])).rows[0].id;
  } else if (b.keep_photo && d.delivery && d.delivery.photo) v.photo = d.delivery.photo;
  else await q(`DELETE FROM bl_media WHERE doc_id=$1 AND kind='delivery'`, [d.id]);
  await q('UPDATE bl_docs SET delivery=$2, updated_at=now() WHERE id=$1', [d.id, JSON.stringify(v)]);
  res.json({ ok: true, delivery: v });
}));
app.get('/api/bl/media/:id', need('billing', 'purchases'), wrap(async (req, res) => {
  const m = (await q('SELECT m.*, d.brand_id FROM bl_media m JOIN bl_docs d ON d.id=m.doc_id WHERE m.id=$1', [+req.params.id])).rows[0];
  if (!m || (req.user.brand_id && !isSuper(req.user) && m.brand_id !== req.user.brand_id)) return res.status(404).end();
  res.setHeader('Content-Type', m.mime); res.setHeader('Cache-Control', 'private, max-age=86400'); res.end(m.data);
}));

// warranty & service: transport details for each trip of the material (to vendor, back from vendor, to customer, from customer)
const WC_LEGS = { to_vendor: 'Sent to vendor', from_vendor: 'Back from vendor', to_customer: 'Sent to customer', from_customer: 'Received from customer' };
app.post('/api/wc/:id/transport', wrap(async (req, res) => {
  const c = await wcLoad(req, res); if (!c) return;
  if (!wcCan(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const b = req.body || {}, t = (k, n = 200) => String(b[k] || '').trim().slice(0, n) || null;
  if (!WC_LEGS[b.leg]) return res.status(400).json({ error: 'Choose which trip this is' });
  let legs = Array.isArray(c.transport) ? c.transport : [];
  const old = legs.find(x => x.leg === b.leg);
  if (b.clear) {
    legs = legs.filter(x => x.leg !== b.leg); if (old && old.photo) await q('DELETE FROM wc_media WHERE id=$1 AND case_id=$2', [old.photo, c.id]);
    await q('UPDATE wc_cases SET transport=$2, updated_at=now() WHERE id=$1', [c.id, JSON.stringify(legs)]); await wcLog(c.id, req.user.name, '🚚 Transport removed: ' + WC_LEGS[b.leg]); return res.json({ ok: true, transport: legs });
  }
  if (!['transport', 'collected'].includes(b.mode)) return res.status(400).json({ error: 'Choose transport or hand delivery' });
  const v = { leg: b.leg, mode: b.mode, date: /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : (await todayIST()), info: t('info', 1000), by: req.user.name, at: new Date().toISOString() };
  if (b.mode === 'transport') { Object.assign(v, { transporter: t('transporter'), tracking: t('tracking', 80), vehicle: t('vehicle', 30) }); if (!v.transporter && !v.tracking) return res.status(400).json({ error: 'Enter the transport name or tracking number' }); }
  else v.person = t('person');
  if (b.photo) {
    const ph = wcMedia(b.photo, /^image\//); if (!ph) return res.status(400).json({ error: 'Photo must be an image' });
    if (old && old.photo) await q('DELETE FROM wc_media WHERE id=$1 AND case_id=$2', [old.photo, c.id]);
    v.photo = (await q(`INSERT INTO wc_media(case_id,kind,mime,data,uploaded_by) VALUES($1,'transport',$2,$3,$4) RETURNING id`, [c.id, ph.mime, ph.buf, req.user.name])).rows[0].id;
  } else if (b.keep_photo && old && old.photo) v.photo = old.photo;
  else if (old && old.photo) await q('DELETE FROM wc_media WHERE id=$1 AND case_id=$2', [old.photo, c.id]);
  legs = [...legs.filter(x => x.leg !== b.leg), v];
  await q('UPDATE wc_cases SET transport=$2, updated_at=now() WHERE id=$1', [c.id, JSON.stringify(legs)]);
  await wcLog(c.id, req.user.name, `🚚 ${WC_LEGS[b.leg]}: ${b.mode === 'transport' ? [v.transporter, v.tracking ? 'tracking ' + v.tracking : '', v.vehicle].filter(Boolean).join(' · ') : 'by hand' + (v.person ? ' (' + v.person + ')' : '')}`);
  res.json({ ok: true, transport: legs });
}));

// ---------- call leads (Rago Calls Android app) ----------
const callCfg = async () => Object.assign({ min_sec: 300, incoming: true, outgoing: true }, (await q(`SELECT v FROM settings WHERE k='call_cfg'`)).rows.map(r => { try { return JSON.parse(r.v); } catch (e) { return {}; } })[0] || {});
const callAdmin = u => isSuper(u) || u.role === 'Admin';
const callSee = (u, p) => { if (isSuper(u)) return 'true'; if (callAdmin(u) || can(u, 'leads_all')) { if (!u.brand_id) return 'true'; p.push(u.brand_id); return `c.brand_id=$${p.length}`; } p.push(u.id); return `c.user_id=$${p.length}`; };
app.post('/api/calls/device-login', wrap(async (req, res) => {    // the phone app signs in once with the CRM username + password
  const ip = req.ip, t = tries[ip] || { n: 0, at: Date.now() }; if (Date.now() - t.at > 600000) { t.n = 0; t.at = Date.now(); }
  if (t.n >= 8) return res.status(429).json({ error: 'Too many attempts. Try again in 10 minutes.' });
  const { username, password } = req.body || {}, uk = 'u:' + String(username || '').trim().toLowerCase(), tu = tries[uk] || { n: 0, at: Date.now() };
  if (Date.now() - tu.at > 900000) { tu.n = 0; tu.at = Date.now(); }
  if (tu.n >= 10) return res.status(429).json({ error: 'This account is locked for 15 minutes after many wrong passwords.' });
  const u = (await q('SELECT * FROM users WHERE lower(username)=lower($1)', [String(username || '').trim()])).rows[0];
  if (!u || !verify(String(password || ''), u.password_hash)) { tries[ip] = { n: t.n + 1, at: t.at }; if (u) tries[uk] = { n: tu.n + 1, at: tu.at }; return res.status(401).json({ error: 'Wrong username or password' }); }
  delete tries[ip]; delete tries[uk];
  if (!u.active) return res.status(403).json({ error: 'Your account has been disabled.' });
  if (!isSuper(u) && !(u.permissions || []).includes('calls')) return res.status(403).json({ error: 'Call leads is not turned on for you. Ask the Super Admin to enable “Call leads” on your user.' });
  const tok = 'rgd_' + crypto.randomBytes(30).toString('base64url');
  const r = (await q(`INSERT INTO call_devices(user_id,token_hash,name,last_seen) VALUES($1,$2,$3,now()) RETURNING id`, [u.id, crypto.createHash('sha256').update(tok).digest('hex'), String((req.body || {}).device || 'Android phone').slice(0, 80)])).rows[0];
  res.json({ ok: true, token: tok, device_id: r.id, name: u.name, cfg: await callCfg() });
}));
app.post('/api/calls/device-token', wrap(async (req, res) => {    // the Rago CRM Android app: the logged-in user turns on call leads on this phone
  if (!isSuper(req.user) && !can(req.user, 'calls')) return res.status(403).json({ error: 'Call leads is not turned on for you' });
  const name = String((req.body || {}).device || 'Android phone').slice(0, 80), tok = 'rgd_' + crypto.randomBytes(30).toString('base64url');
  await q(`UPDATE call_devices SET active=false WHERE user_id=$1 AND name=$2 AND active`, [req.user.id, name]);
  const r = (await q(`INSERT INTO call_devices(user_id,token_hash,name,last_seen) VALUES($1,$2,$3,now()) RETURNING id`, [req.user.id, crypto.createHash('sha256').update(tok).digest('hex'), name])).rows[0];
  res.json({ ok: true, token: tok, device_id: r.id, name: req.user.name, cfg: await callCfg() });
}));
app.get('/api/calls/device/cfg', wrap(async (req, res) => {
  await q('UPDATE call_devices SET last_seen=now() WHERE id=$1', [req.user.device_id]);
  const d = (await q('SELECT sim_label, sim_slot FROM call_devices WHERE id=$1', [req.user.device_id])).rows[0] || {};
  const us = (await q('SELECT call_sim FROM users WHERE id=$1', [req.user.id])).rows[0] || {};
  res.json({ name: req.user.name, cfg: await callCfg(), sim_label: d.sim_label, sim_slot: d.sim_slot, sim: us.call_sim || 'all', managed: true });
}));
app.post('/api/calls/device/sim', wrap(async (req, res) => {
  const b = req.body || {}; await q('UPDATE call_devices SET sim_label=$2, sim_slot=$3, last_seen=now() WHERE id=$1', [req.user.device_id, String(b.sim_label || '').slice(0, 60) || null, Number.isInteger(+b.sim_slot) ? +b.sim_slot : null]);
  res.json({ ok: true });
}));
app.post('/api/calls/device/sync', wrap(async (req, res) => {    // calls from the chosen SIM; only those of the set length or longer are kept
  const b = req.body || {}, cfg = await callCfg(), u = req.user, list = (Array.isArray(b.calls) ? b.calls : []).slice(0, 500);
  await q('UPDATE call_devices SET last_seen=now() WHERE id=$1', [u.device_id]);
  let added = 0, onLead = 0, skipped = 0;
  for (const c of list) {
    const ph = String(c.phone || '').replace(/[^\d+]/g, '').slice(0, 20), dg = digits(ph), dur = Math.max(0, Math.round(+c.duration || 0)), at = new Date(c.started_at);
    const dir = ['incoming', 'outgoing'].includes(c.direction) ? c.direction : 'incoming';
    if (dg.length < 7 || isNaN(at) || dur < cfg.min_sec || (dir === 'incoming' && !cfg.incoming) || (dir === 'outgoing' && !cfg.outgoing)) { skipped++; continue; }
    const lead = (await q(`SELECT id FROM leads WHERE right(regexp_replace(COALESCE(phone,''),'\\D','','g'),10)=$1 ${u.brand_id ? 'AND brand_id=$2' : ''} ORDER BY id DESC LIMIT 1`, u.brand_id ? [dg.slice(-10), u.brand_id] : [dg.slice(-10)])).rows[0];
    const r = await q(`INSERT INTO calls(user_id,user_name,brand_id,device_id,phone,contact,direction,duration,sim_label,started_at,status,lead_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (user_id,phone,started_at) DO NOTHING RETURNING id`,
      [u.id, u.name, u.brand_id || null, u.device_id, ph, String(c.name || '').slice(0, 120) || null, dir, dur, String(b.sim_label || c.sim || '').slice(0, 60) || null, at, lead ? 'existing' : 'pending', lead ? lead.id : null]);
    if (!r.rows.length) { skipped++; continue; }
    if (lead) { onLead++; await leadLog(lead.id, u.name, `📞 ${dir === 'outgoing' ? 'Called' : 'Call from'} ${ph} · ${Math.floor(dur / 60)} min ${dur % 60} s`); await q('UPDATE leads SET last_contact=now() WHERE id=$1', [lead.id]); }
    else added++;
  }
  if (added) notifyLink([u.id], 'New call leads', `${added} call${added > 1 ? 's' : ''} of ${Math.round(cfg.min_sec / 60)}+ min waiting — tap to add to Leads`, 'calls').catch(() => {});
  res.json({ ok: true, added, on_lead: onLead, skipped, min_sec: cfg.min_sec });
}));
app.get('/api/calls', need('calls'), wrap(async (req, res) => {
  const p = [], st = ['pending', 'accepted', 'ignored', 'existing'].includes(req.query.status) ? req.query.status : 'pending';
  let sc = callSee(req.user, p); if (+req.query.user) { p.push(+req.query.user); sc += ` AND c.user_id=$${p.length}`; }
  const p2 = p.slice(), sc2 = sc; p.push(st);
  const items = (await q(`SELECT c.*, l.name lead_name FROM calls c LEFT JOIN leads l ON l.id=c.lead_id WHERE ${sc} AND c.status=$${p.length} ORDER BY c.started_at DESC LIMIT 300`, p)).rows;
  const cnt = (await q(`SELECT status, COUNT(*)::int n FROM calls c WHERE ${sc2} GROUP BY status`, p2)).rows.reduce((o, r) => (o[r.status] = r.n, o), {});
  const p4 = [], sc4 = callSee(req.user, p4);
  const staff = sc4 === `c.user_id=$1` ? [] : (await q(`SELECT DISTINCT c.user_id id, c.user_name name FROM calls c WHERE ${sc4} ORDER BY 2`, p4)).rows;
  const p3 = [req.user.id], devs = (await q(`SELECT id, name, sim_label, sim_slot, last_seen, created_at FROM call_devices WHERE user_id=$1 AND active ORDER BY id DESC`, p3)).rows;
  res.json({ items, counts: cnt, cfg: await callCfg(), devices: devs, staff, admin: callAdmin(req.user), apk: fs.existsSync(path.join(__dirname, 'public', 'app', 'rago-calls.apk')) });
}));
const callGet = async (req, res) => { const p = [+req.params.id], sc = callSee(req.user, p); const c = (await q(`SELECT c.* FROM calls c WHERE c.id=$1 AND ${sc}`, p)).rows[0]; if (!c) res.status(404).json({ error: 'Call not found' }); return c; };
app.post('/api/calls/:id/accept', need('calls'), wrap(async (req, res) => {
  const c = await callGet(req, res); if (!c) return; if (c.status === 'accepted') return res.status(400).json({ error: 'Already added to leads' });
  const b = req.body || {}, o = cleanLead({ name: b.name || c.contact || c.phone, company: b.company, phone: c.phone, interest: b.interest, notes: b.notes, source: 'Call', priority: b.priority, assigned_to: c.user_id });
  o.source = 'Call'; o.assigned_to = c.user_id;
  const ex = (await q(`SELECT id, name FROM leads WHERE right(regexp_replace(COALESCE(phone,''),'\\D','','g'),10)=$1 ${c.brand_id ? 'AND brand_id=$2' : ''} LIMIT 1`, c.brand_id ? [digits(c.phone).slice(-10), c.brand_id] : [digits(c.phone).slice(-10)])).rows[0];
  const id = ex ? ex.id : await insLead(o, req.user.id, c.brand_id || await leadBrand(req.user));
  await leadLog(id, req.user.name, ex ? `📞 Call ${c.phone} (${Math.round(c.duration / 60)} min) linked` : `Lead created from a ${Math.round(c.duration / 60)} min call (${c.direction}) on ${c.sim_label || 'phone'}`);
  await q(`UPDATE calls SET status='accepted', lead_id=$2, decided_by=$3, decided_at=now() WHERE id=$1`, [c.id, id, req.user.name]);
  if (c.user_id !== req.user.id && !ex) notify([c.user_id], 'Call added to leads', `${o.name} (${c.phone})`, null).catch(() => {});
  res.json({ ok: true, lead_id: id, existing: !!ex });
}));
app.post('/api/calls/:id/ignore', need('calls'), wrap(async (req, res) => {
  const c = await callGet(req, res); if (!c) return;
  await q(`UPDATE calls SET status=$2, decided_by=$3, decided_at=now() WHERE id=$1`, [c.id, (req.body || {}).undo ? 'pending' : 'ignored', req.user.name]); res.json({ ok: true });
}));
app.post('/api/calls/settings', wrap(async (req, res) => {
  if (!isSuper(req.user) && req.user.role !== 'Admin') return res.status(403).json({ error: 'Only the Super Admin or Admin can change this' });
  const b = req.body || {}, v = { min_sec: Math.max(10, Math.min(3600, Math.round((+b.min_min || 5) * 60))), incoming: b.incoming !== false, outgoing: b.outgoing !== false };
  await q(`INSERT INTO settings(k,v) VALUES('call_cfg',$1) ON CONFLICT (k) DO UPDATE SET v=excluded.v`, [JSON.stringify(v)]); res.json({ ok: true, cfg: v });
}));
app.delete('/api/calls/devices/:id', wrap(async (req, res) => {
  if (!callAdmin(req.user)) return res.status(403).json({ error: 'Only the Admin or Super Admin can remove a phone' });
  await q(`UPDATE call_devices SET active=false WHERE id=$1`, [+req.params.id]); res.json({ ok: true });
}));
app.get(['/rago-calls.apk', '/rago-crm.apk'], (req, res) => { const f = path.join(__dirname, 'public', 'app', 'rago-calls.apk'); if (!fs.existsSync(f)) return res.status(404).send('The Android app file is not uploaded yet.'); res.download(f, 'rago-crm.apk'); });

// ---------- email: each user connects their own mailbox once (Hostinger by default) ----------
let MAIL_KEY = null;
const mailKey = async () => {
  if (MAIL_KEY) return MAIL_KEY;
  if (process.env.MAIL_KEY) return (MAIL_KEY = crypto.createHash('sha256').update(process.env.MAIL_KEY).digest());
  let k = (await q(`SELECT v FROM settings WHERE k='mail_key'`)).rows[0];
  if (!k) { const v = crypto.randomBytes(32).toString('hex'); await q(`INSERT INTO settings(k,v) VALUES('mail_key',$1) ON CONFLICT (k) DO NOTHING`, [v]); k = (await q(`SELECT v FROM settings WHERE k='mail_key'`)).rows[0]; }
  return (MAIL_KEY = Buffer.from(k.v, 'hex'));
};
const mailEnc = async t => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', await mailKey(), iv), e = Buffer.concat([c.update(String(t), 'utf8'), c.final()]); return [iv, c.getAuthTag(), e].map(x => x.toString('base64')).join('.'); };
const mailDec = async s => { const [iv, tag, e] = String(s).split('.').map(x => Buffer.from(x, 'base64')); const d = crypto.createDecipheriv('aes-256-gcm', await mailKey(), iv); d.setAuthTag(tag); return Buffer.concat([d.update(e), d.final()]).toString('utf8'); };
const MAIL_TLS = process.env.MAIL_TEST_INSECURE === '1' ? { rejectUnauthorized: false } : undefined;   // only for local tests
const mailCfgOf = (b, old = {}) => ({ smtp_host: String(b.smtp_host || old.smtp_host || 'smtp.hostinger.com').trim(), smtp_port: +b.smtp_port || old.smtp_port || 465, imap_host: String(b.imap_host || old.imap_host || 'imap.hostinger.com').trim(), imap_port: +b.imap_port || old.imap_port || 993 });
const smtpOf = (c, user, pass) => require('nodemailer').createTransport({ host: c.smtp_host, port: c.smtp_port, secure: c.smtp_port === 465, auth: { user, pass }, tls: MAIL_TLS, connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 30000 });
const imapOf = (c, user, pass) => new (require('imapflow').ImapFlow)({ host: c.imap_host, port: c.imap_port, secure: c.imap_port === 993, auth: { user, pass }, logger: false, tls: MAIL_TLS, socketTimeout: 30000, emitLogs: false });
const mailAcc = async uid => { const m = (await q('SELECT * FROM user_mail WHERE user_id=$1', [uid])).rows[0]; if (!m) return null; m.pass = await mailDec(m.pass_enc); return m; };
const mailErr = e => /auth|login|credential|535|invalid/i.test(String(e && (e.message || e.response) || '')) ? 'Email or password is wrong' : /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|timeout/i.test(String(e && e.message)) ? 'Could not reach the mail server' : 'Mail server error: ' + String(e && e.message || e).slice(0, 120);
app.get('/api/mail/me', wrap(async (req, res) => {
  const m = (await q('SELECT email, from_name, signature, smtp_host, smtp_port, imap_host, imap_port, ok_at, smtp_ok FROM user_mail WHERE user_id=$1', [req.user.id])).rows[0];
  const relay = !!(await mailRelay());
  res.json(m ? { connected: true, ...m, relay, can_send: relay || m.smtp_ok !== false, blocked_note: relay || m.smtp_ok !== false ? null : MAIL_BLOCKED } : { connected: false, email: req.user.email || '', relay });
}));
app.post('/api/mail/connect', wrap(async (req, res) => {
  const b = req.body || {}, email = String(b.email || '').trim().toLowerCase(), old = (await q('SELECT * FROM user_mail WHERE user_id=$1', [req.user.id])).rows[0] || {};
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter your email address' });
  let pass = String(b.password || ''); if (!pass && old.pass_enc && old.email === email) pass = await mailDec(old.pass_enc);
  if (!pass) return res.status(400).json({ error: 'Enter your email password' });
  const c = mailCfgOf(b, old);
  const st = await smtpTry(c, email, pass);   // tries 465 and 587
  if (st.err && !st.net) return res.status(400).json({ error: 'Sending check failed — ' + mailErr(st.err) });
  const relay = await mailRelay(); let smtpOk = !st.err;
  if (st.port) c.smtp_port = st.port;
  let sent = old.sent_folder || null;
  try { const im = imapOf(c, email, pass); await im.connect(); const L = await im.list(); const f = L.find(x => x.specialUse === '\\Sent') || L.find(x => /^(INBOX\.)?Sent$/i.test(x.path)); sent = f ? f.path : null; await im.logout(); }
  catch (e) { return res.status(400).json({ error: (st.err ? 'Could not reach the mail server for sending or for the inbox — check the server names. ' : 'Inbox check failed — ') + mailErr(e) }); }
  await q(`INSERT INTO user_mail(user_id,email,from_name,signature,smtp_host,smtp_port,imap_host,imap_port,pass_enc,sent_folder,ok_at,smtp_ok) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11)
    ON CONFLICT (user_id) DO UPDATE SET email=$2, from_name=$3, signature=$4, smtp_host=$5, smtp_port=$6, imap_host=$7, imap_port=$8, pass_enc=$9, sent_folder=$10, ok_at=now(), smtp_ok=$11`,
    [req.user.id, email, String(b.from_name || req.user.name || '').slice(0, 80), String(b.signature || '').slice(0, 1000) || null, c.smtp_host, c.smtp_port, c.imap_host, c.imap_port, await mailEnc(pass), sent, smtpOk]);
  res.json({ ok: true, email, smtp_ok: smtpOk, relay: !!relay, warn: smtpOk || relay ? null : MAIL_BLOCKED });
}));
app.patch('/api/mail/me', wrap(async (req, res) => {
  const b = req.body || {}; await q('UPDATE user_mail SET from_name=COALESCE($2,from_name), signature=$3 WHERE user_id=$1', [req.user.id, b.from_name ? String(b.from_name).slice(0, 80) : null, String(b.signature || '').slice(0, 1000) || null]); res.json({ ok: true });
}));
app.delete('/api/mail/me', wrap(async (req, res) => { await q('DELETE FROM user_mail WHERE user_id=$1', [req.user.id]); res.json({ ok: true }); }));
const mailEsc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
app.post('/api/mail/send', wrap(async (req, res) => {
  const m = await mailAcc(req.user.id); if (!m) return res.status(400).json({ error: 'Connect your email first (Mail → Connect email)' });
  const b = req.body || {}, list = x => String(x || '').split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
  const to = list(b.to), cc = list(b.cc); if (!to.length) return res.status(400).json({ error: 'Enter who to send to' });
  if ([...to, ...cc].some(e => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))) return res.status(400).json({ error: 'One of the email addresses is not valid' });
  const subject = String(b.subject || '').slice(0, 250), text = String(b.body || '').slice(0, 20000); if (!subject && !text) return res.status(400).json({ error: 'Write a subject or message' });
  let link = '', doc = null;
  if (+b.doc_id) {
    doc = await blLoad(req, res, +b.doc_id); if (!doc) return;
    if (!doc.share_token) { doc.share_token = crypto.randomBytes(12).toString('base64url'); await q('UPDATE bl_docs SET share_token=$2 WHERE id=$1', [doc.id, doc.share_token]); }
    link = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}/d/${doc.share_token}`;
  }
  const sig = m.signature ? '\n\n' + m.signature : '';
  const html = `<div style="font:14px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#222">${mailEsc(text).replace(/\n/g, '<br>')}${link ? `<p><a href="${link}" style="display:inline-block;background:#e0a92b;color:#111;padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:700">View ${mailEsc(BL_TYPES[doc.type].l)} ${mailEsc(doc.no)}</a></p>` : ''}${sig ? `<p style="color:#555">${mailEsc(m.signature).replace(/\n/g, '<br>')}</p>` : ''}</div>`;
  const msg = { from: { name: m.from_name || req.user.name, address: m.email }, to, cc: cc.length ? cc : undefined, subject, text: text + (link ? '\n\n' + link : '') + sig, html };
  const relay = await mailRelay();
  try { if (relay) await relaySend(relay, msg); else await smtpOf(m, m.email, m.pass).sendMail(msg); }
  catch (e) { const net = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|timeout|Greeting/i.test(String(e && e.message)); return res.status(400).json({ error: relay ? 'Not sent — Brevo: ' + String(e.message || e).slice(0, 160) : net ? MAIL_BLOCKED : 'Not sent — ' + mailErr(e), blocked: !relay && net }); }
  if (m.sent_folder) (async () => {   // keep a copy in the mailbox's Sent folder
    try { const raw = await new Promise((ok, no) => new (require('nodemailer/lib/mail-composer'))(msg).compile().build((e, r) => e ? no(e) : ok(r))); const im = imapOf(m, m.email, m.pass); await im.connect(); await im.append(m.sent_folder, raw, ['\\Seen']); await im.logout(); } catch (e) { console.error('mail sent copy', e.message); }
  })();
  const ids = { lead_id: +b.lead_id || (doc && doc.lead_id) || null, customer_id: +b.customer_id || (doc && doc.customer_id) || null, service_id: +b.service_id || (doc && doc.service_id) || null };
  if (!ids.lead_id && !ids.customer_id) { const l = (await q(`SELECT id FROM leads WHERE lower(email)=ANY($1) ORDER BY id DESC LIMIT 1`, [to.map(x => x.toLowerCase())])).rows[0]; if (l) ids.lead_id = l.id; }
  await q(`INSERT INTO mail_log(user_id,user_name,from_email,to_email,cc,subject,body,lead_id,customer_id,doc_id,service_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [req.user.id, req.user.name, m.email, to.join(', '), cc.join(', ') || null, subject, text, ids.lead_id, ids.customer_id, doc ? doc.id : null, ids.service_id]);
  if (ids.lead_id) await leadLog(ids.lead_id, req.user.name, `✉ Email sent to ${to.join(', ')}: ${subject}`);
  res.json({ ok: true });
}));
app.get('/api/mail/log', wrap(async (req, res) => {
  const p = [], w = []; for (const k of ['lead_id', 'customer_id', 'doc_id', 'service_id']) if (+req.query[k]) { p.push(+req.query[k]); w.push(`${k}=$${p.length}`); }
  if (!w.length) { if (isSuper(req.user) && req.query.all === '1') w.push('true'); else if (isSuper(req.user) && +req.query.user) { p.push(+req.query.user); w.push(`user_id=$${p.length}`); } else { p.push(req.user.id); w.push(`user_id=$${p.length}`); } } else if (!isSuper(req.user)) { p.push(req.user.id); w.push(`(user_id=$${p.length} OR ${can(req.user, 'leads_all') || can(req.user, 'billing') ? 'true' : 'false'})`); }
  res.json((await q(`SELECT id, user_name, from_email, to_email, cc, subject, body, lead_id, customer_id, doc_id, service_id, created_at FROM mail_log WHERE ${w.join(' AND ')} ORDER BY id DESC LIMIT 100`, p)).rows);
}));
app.get('/api/mail/inbox', wrap(async (req, res) => {
  const A = await mailFor(req); if (A.err) return res.status(A.need ? 400 : 403).json({ error: A.err, need_connect: !!A.need }); const m = A.m;
  const folder = req.query.folder === 'sent' ? (m.sent_folder || 'INBOX.Sent') : 'INBOX', lim = Math.min(50, +req.query.limit || 30), before = +req.query.before || 0;
  const im = imapOf(m, m.email, m.pass), out = [];
  try {
    await im.connect(); const lock = await im.getMailboxLock(folder);
    try {
      const total = im.mailbox.exists || 0;
      if (total) { const end = before ? Math.min(before - 1, total) : total, start = Math.max(1, end - lim + 1);
        if (end >= 1) for await (const x of im.fetch(`${start}:${end}`, { envelope: true, flags: true, uid: true })) out.push({ uid: x.uid, seq: x.seq, subject: x.envelope.subject || '(no subject)', from: (x.envelope.from || [])[0] || {}, to: (x.envelope.to || []).map(a => a.address).join(', '), date: x.envelope.date, seen: x.flags && x.flags.has('\\Seen') }); }
      res.json({ folder: req.query.folder === 'sent' ? 'sent' : 'inbox', total, items: out.reverse(), email: m.email });
    } finally { lock.release(); }
    await im.logout();
  } catch (e) { try { im.close(); } catch (x) {} if (!res.headersSent) res.status(400).json({ error: mailErr(e) }); }
}));
app.get('/api/mail/msg/:uid', wrap(async (req, res) => {
  const A = await mailFor(req); if (A.err) return res.status(A.need ? 400 : 403).json({ error: A.err, need_connect: !!A.need }); const m = A.m, other = !!A.other;
  const folder = req.query.folder === 'sent' ? (m.sent_folder || 'INBOX.Sent') : 'INBOX', im = imapOf(m, m.email, m.pass);
  try {
    await im.connect(); const lock = await im.getMailboxLock(folder); let src;
    try { const x = await im.fetchOne(String(+req.params.uid), { source: true }, { uid: true }); src = x && x.source; if (src && !other) await im.messageFlagsAdd(String(+req.params.uid), ['\\Seen'], { uid: true }); } finally { lock.release(); }
    await im.logout(); if (!src) return res.status(404).json({ error: 'Message not found' });
    const P = await require('mailparser').simpleParser(src), from = (P.from && P.from.value[0]) || {};
    const addr = String(from.address || '').toLowerCase(), pl = [addr];
    const lead = addr ? (await q(`SELECT l.id, l.name FROM leads l WHERE lower(l.email)=$1 AND ${leadScope(req.user, pl)} ORDER BY l.id DESC LIMIT 1`, pl)).rows[0] : null;
    const cust = addr ? (await q(`SELECT id, name, company FROM customers WHERE lower(email)=$1 LIMIT 1`, [addr])).rows[0] : null;
    res.json({ uid: +req.params.uid, subject: P.subject || '', from, to: P.to ? P.to.text : '', cc: P.cc ? P.cc.text : '', date: P.date, text: P.text || '', html: P.html || null,
      attachments: (P.attachments || []).map(a => ({ name: a.filename, size: a.size, type: a.contentType })), lead, customer: cust });
  } catch (e) { try { im.close(); } catch (x) {} if (!res.headersSent) res.status(400).json({ error: mailErr(e) }); }
}));

// ---------- credit control: credit period per customer; no new invoice / quotation while a bill is overdue (unless paid or the MD approves) ----------
const BL_CREDIT_TYPES = ['invoice', 'quotation'];
const blCreditCfg = async () => Object.assign({ block: false, default_days: 0, grace_days: 0 }, (await q(`SELECT v FROM settings WHERE k='bl_credit'`)).rows.map(r => { try { return JSON.parse(r.v); } catch (e) { return {}; } })[0] || {});
const blCreditCheck = async (cid) => {
  const cfg = await blCreditCfg(), today = await todayIST();
  const c = (await q('SELECT id, name, company, credit_days FROM customers WHERE id=$1', [cid])).rows[0]; if (!c) return { blocked: false };
  const days = c.credit_days !== null && c.credit_days !== undefined ? c.credit_days : cfg.default_days;
  const bills = (await q(`SELECT d.id, d.no, to_char(d.doc_date,'YYYY-MM-DD') doc_date, to_char(COALESCE(d.due_date, d.doc_date + $2::int),'YYYY-MM-DD') due, br.name brand, (d.total-d.paid-d.credited)::float bal
    FROM bl_docs d LEFT JOIN brands br ON br.id=d.brand_id WHERE d.customer_id=$1 AND d.type='invoice' AND d.status IN ('Unpaid','Partial') AND d.total-d.paid-d.credited>0.5
    AND COALESCE(d.due_date, d.doc_date + $2::int) + $3::int < $4::date ORDER BY COALESCE(d.due_date, d.doc_date + $2::int) LIMIT 20`, [cid, days, cfg.grace_days, today])).rows;
  const amount = br2(bills.reduce((t, x) => t + x.bal, 0));
  const pass = (await q(`SELECT id, decided_by, valid_until FROM bl_credit_ok WHERE customer_id=$1 AND status='approved' AND valid_until>now() ORDER BY id DESC LIMIT 1`, [cid])).rows[0] || null;
  const pending = (await q(`SELECT id, req_name, created_at FROM bl_credit_ok WHERE customer_id=$1 AND status='pending' ORDER BY id DESC LIMIT 1`, [cid])).rows[0] || null;
  return { on: cfg.block, credit_days: days, n: bills.length, amount, bills, approved: pass, pending, customer: c.company || c.name, blocked: cfg.block && bills.length > 0 && !pass };
};
async function initV30() {
  await q(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS credit_days INT;
  CREATE TABLE IF NOT EXISTS bl_credit_ok (id SERIAL PRIMARY KEY, customer_id INT NOT NULL, customer_name TEXT, doc_type TEXT, amount NUMERIC(14,2), note TEXT, status TEXT DEFAULT 'pending',
    requested_by INT, req_name TEXT, decided_by TEXT, decided_at TIMESTAMPTZ, decide_note TEXT, valid_until TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now());`);
}
const endOfDayIST = () => { const d = new Date(Date.now() + 5.5 * 3600e3); d.setUTCHours(23, 59, 59, 0); return new Date(d.getTime() - 5.5 * 3600e3); };
app.get('/api/bl/credit-settings', need('billing'), wrap(async (req, res) => res.json(await blCreditCfg())));
app.post('/api/bl/credit-settings', superOnly, wrap(async (req, res) => {
  const b = req.body || {}, v = { block: !!b.block, default_days: Math.max(0, Math.min(365, Math.round(+b.default_days || 0))), grace_days: Math.max(0, Math.min(90, Math.round(+b.grace_days || 0))) };
  await q(`INSERT INTO settings(k,v) VALUES('bl_credit',$1) ON CONFLICT (k) DO UPDATE SET v=excluded.v`, [JSON.stringify(v)]); res.json({ ok: true, cfg: v });
}));
app.get('/api/bl/credit-check', need('billing'), wrap(async (req, res) => {
  const p = [+req.query.customer_id], sc = custScope(req.user, p);
  if (!(await q(`SELECT 1 FROM customers c WHERE c.id=$1 AND ${sc}`, p)).rows.length) return res.status(404).json({ error: 'Customer not found' });
  res.json(await blCreditCheck(+req.query.customer_id));
}));
app.post('/api/bl/credit-approvals', need('billing'), wrap(async (req, res) => {    // staff asks the MD (Super Admin) to allow a new bill
  const b = req.body || {}, p = [+b.customer_id], sc = custScope(req.user, p);
  if (!(await q(`SELECT 1 FROM customers c WHERE c.id=$1 AND ${sc}`, p)).rows.length) return res.status(404).json({ error: 'Customer not found' });
  const chk = await blCreditCheck(+b.customer_id);
  if (!chk.blocked) return res.json({ ok: true, not_needed: true });
  if (chk.pending) return res.json({ ok: true, id: chk.pending.id, already: true });
  const r = (await q(`INSERT INTO bl_credit_ok(customer_id,customer_name,doc_type,amount,note,requested_by,req_name) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [+b.customer_id, chk.customer, BL_CREDIT_TYPES.includes(b.doc_type) ? b.doc_type : 'invoice', chk.amount, String(b.note || '').slice(0, 500) || null, req.user.id, req.user.name])).rows[0];
  const supers = (await q(`SELECT id FROM users WHERE role=$1 AND active`, [SUPER])).rows.map(x => x.id).filter(id => id !== req.user.id);
  await notifyLink(supers, '🔒 Approval needed: new bill', `${req.user.name} wants to make a ${b.doc_type === 'quotation' ? 'quotation' : 'invoice'} for ${chk.customer} — ₹${chk.amount} overdue (${chk.n} bill${chk.n > 1 ? 's' : ''})${b.note ? ' · ' + String(b.note).slice(0, 80) : ''}`, 'credit').catch(() => {});
  res.json({ ok: true, id: r.id });
}));
app.get('/api/bl/credit-approvals', need('billing'), wrap(async (req, res) => {
  const p = [], w = [];
  if (!isSuper(req.user)) { p.push(req.user.id); w.push(`requested_by=$${p.length}`); }
  if (req.query.status === 'pending') w.push(`status='pending'`);
  res.json((await q(`SELECT id, customer_id, customer_name, doc_type, amount::float amount, note, status, req_name, decided_by, decided_at, decide_note, valid_until, created_at FROM bl_credit_ok ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY (status='pending') DESC, id DESC LIMIT 100`, p)).rows);
}));
app.post('/api/bl/credit-approvals/:id/decide', superOnly, wrap(async (req, res) => {
  const a = (await q(`SELECT * FROM bl_credit_ok WHERE id=$1`, [+req.params.id])).rows[0]; if (!a) return res.status(404).json({ error: 'Not found' });
  if (a.status !== 'pending') return res.status(400).json({ error: 'Already ' + a.status });
  const ok = !!(req.body || {}).approve, note = String((req.body || {}).note || '').slice(0, 300) || null;
  await q(`UPDATE bl_credit_ok SET status=$2, decided_by=$3, decided_at=now(), decide_note=$4, valid_until=$5 WHERE id=$1`, [a.id, ok ? 'approved' : 'rejected', req.user.name, note, ok ? endOfDayIST() : null]);
  if (a.requested_by) await notifyLink([a.requested_by], ok ? '✅ MD approved — you can make the bill' : '❌ MD did not approve the bill', `${a.customer_name}${ok ? ' · allowed till tonight' : ''}${note ? ' · ' + note : ''}`, 'credit').catch(() => {});
  res.json({ ok: true });
}));

// ---------- V32: call leads set up by Admin / Super Admin (SIM per staff), Super Admin can read every connected mailbox ----------
async function initV32() { await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS call_sim TEXT`); }
app.get('/api/calls/staff', wrap(async (req, res) => {
  if (!callAdmin(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const p = []; let w = `u.active AND (u.role=$1 OR 'calls'=ANY(u.permissions))`; p.push(SUPER);
  if (!isSuper(req.user) && req.user.brand_id) { p.push(req.user.brand_id); w += ` AND u.brand_id=$${p.length}`; }
  const rows = (await q(`SELECT u.id, u.name, u.role, COALESCE(u.call_sim,'all') sim, b.name brand,
    (SELECT json_agg(json_build_object('id',d.id,'name',d.name,'sim_label',d.sim_label,'last_seen',d.last_seen) ORDER BY d.id DESC) FROM call_devices d WHERE d.user_id=u.id AND d.active) devices
    FROM users u LEFT JOIN brands b ON b.id=u.brand_id WHERE ${w} AND u.role<>$1 ORDER BY lower(u.name)`, p)).rows;
  res.json(rows);
}));
app.post('/api/calls/staff/:id', wrap(async (req, res) => {
  if (!callAdmin(req.user)) return res.status(403).json({ error: 'Only the Admin or Super Admin can change this' });
  const sim = ['all', '1', '2'].includes(String((req.body || {}).sim)) ? String(req.body.sim) : 'all';
  const p = [+req.params.id]; let w = 'id=$1'; if (!isSuper(req.user) && req.user.brand_id) { p.push(req.user.brand_id); w += ` AND brand_id=$${p.length}`; }
  const r = await q(`UPDATE users SET call_sim=$${p.length + 1} WHERE ${w}`, [...p, sim]); if (!r.rowCount) return res.status(404).json({ error: 'Staff not found' });
  res.json({ ok: true, sim });
}));
// Super Admin: read the mailbox of any staff who connected their email (read-only)
const mailFor = async (req) => { if (+req.query.user && +req.query.user !== req.user.id) { if (!isSuper(req.user)) return { err: 'Not allowed' }; const m = await mailAcc(+req.query.user); return m ? { m, other: true } : { err: 'This staff has not connected their email' }; } const m = await mailAcc(req.user.id); return m ? { m } : { err: 'Connect your email first', need: true }; };
app.get('/api/mail/accounts', superOnly, wrap(async (req, res) => {
  res.json((await q(`SELECT m.user_id id, u.name, u.role, m.email, m.ok_at FROM user_mail m JOIN users u ON u.id=m.user_id ORDER BY lower(u.name)`)).rows);
}));

// ---------- email sending when the host blocks mail ports (Render free plan blocks 465 / 587): try both ports, or send through Brevo over HTTPS ----------
const MAIL_BLOCKED = 'Your server (Render) is blocking the email sending ports, so the CRM cannot reach Hostinger to send. Your inbox still works. To send: the Super Admin adds a Brevo key in Mail → Settings → Sending route, or moves the Render service to a paid plan.';
const smtpTry = async (c, email, pass) => {
  const ports = [c.smtp_port, c.smtp_port === 465 ? 587 : 465].filter((v, i, a) => a.indexOf(v) === i); let last = null;
  for (const port of ports) {
    try { await smtpOf({ ...c, smtp_port: port }, email, pass).verify(); return { port }; }
    catch (e) { last = e; const net = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|timeout|Greeting/i.test(String(e && e.message)); if (!net) return { err: e, net: false }; }
  }
  return { err: last, net: true };
};
async function initV32b() { await q(`ALTER TABLE user_mail ADD COLUMN IF NOT EXISTS smtp_ok BOOLEAN DEFAULT true`); }
const BREVO = () => (process.env.BREVO_URL || 'https://api.brevo.com').replace(/\/$/, '');
const mailRelay = async () => { const r = (await q(`SELECT v FROM settings WHERE k='mail_relay'`)).rows[0]; if (!r) return null; try { const v = JSON.parse(r.v); return v && v.key_enc ? { provider: 'brevo', key: await mailDec(v.key_enc), tail: v.tail } : null; } catch (e) { return null; } };
const relaySend = async (relay, msg) => {
  const addr = x => (typeof x === 'string' ? { email: x } : { email: x.address, name: x.name });
  const body = { sender: addr(msg.from), to: msg.to.map(e => ({ email: e })), subject: msg.subject || '(no subject)', htmlContent: msg.html, textContent: msg.text, replyTo: addr(msg.from) };
  if (msg.cc) body.cc = msg.cc.map(e => ({ email: e }));
  const r = await fetch(BREVO() + '/v3/smtp/email', { method: 'POST', headers: { 'api-key': relay.key, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) { let t = ''; try { t = (await r.json()).message || ''; } catch (e) {} throw new Error(t || 'error ' + r.status); }
};
app.get('/api/mail/relay', superOnly, wrap(async (req, res) => { const r = await mailRelay(); res.json(r ? { on: true, provider: 'brevo', tail: r.tail } : { on: false }); }));
app.post('/api/mail/relay', superOnly, wrap(async (req, res) => {
  const b = req.body || {};
  if (b.off) { await q(`DELETE FROM settings WHERE k='mail_relay'`); return res.json({ ok: true, on: false }); }
  const key = String(b.key || '').trim(); if (key.length < 20) return res.status(400).json({ error: 'Paste the Brevo API key (it starts with xkeysib-)' });
  let r; try { r = await fetch(BREVO() + '/v3/account', { headers: { 'api-key': key, accept: 'application/json' } }); } catch (e) { return res.status(400).json({ error: 'Could not reach Brevo' }); }
  if (r.status === 401) return res.status(400).json({ error: 'Brevo says this key is not valid' });
  if (!r.ok) return res.status(400).json({ error: 'Brevo error ' + r.status });
  const tail = '••••' + key.slice(-4);
  await q(`INSERT INTO settings(k,v) VALUES('mail_relay',$1) ON CONFLICT (k) DO UPDATE SET v=excluded.v`, [JSON.stringify({ provider: 'brevo', key_enc: await mailEnc(key), tail })]);
  res.json({ ok: true, on: true, tail });
}));

init().then(initGST).then(initChat).then(initProjects).then(initWA).then(initBL).then(initWC).then(initRoles).then(initFV).then(initV29).then(initV30).then(initV32).then(initV32b).then(() => { setInterval(remindDue, 30000); remindDue(); setInterval(holidayDue, 5 * 60000); holidayDue(); }).then(() => app.listen(process.env.PORT || 3000, () => console.log('Rago CRM running')))
  .catch(e => { console.error('DB init failed', e.message); process.exit(1); });
