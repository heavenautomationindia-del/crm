# Genzy – Heaven Automation
Node + Express + Postgres, installable as a phone app (PWA).

## Deploy
1. Push this folder to a GitHub repo.
2. Render → New → Blueprint → pick the repo (render.yaml creates the web service + Postgres).
3. Render → genzy service → Environment → copy ADMIN_PASSWORD. Sign in as **admin** with that password.

## Roles
- **Super Admin** – everything, and the only person who can delete anything (tickets, customers, leads, types, brands, members, to-dos, leave requests, old data). Adds brands (Heaven, G Media, …).
- **Admin staff** – works for one brand. Super Admin ticks what they can access. Services/jobs they create go to their brand automatically, and they only see their brand.
- **Sales staff** – menus/actions ticked by the Super Admin (optionally kept to one brand).
- **Technician staff** – shared by all brands; sees only jobs assigned to them. Once one brand allocates a technician, other brands can't assign them until that open job is done.

On first start after upgrading, the original `admin` login becomes Super Admin; any other old admins become Heaven admin staff.

## Attendance
- **Check in / check out only at the office**: Heaven Automation, Thillai Nagar, Trichy (10.8225698, 78.683858), within 150 m. Super Admin can change the location, distance and "late after" time in Profile → Office location.
- Outside the office or GPS off → the person sends an **Attendance request** (date, check-in and/or check-out time, reason). Super Admin / Admin staff get a bell + phone notification and a pop-up, approve it, and the time is marked.
- Admins can also type check-in / check-out times for anyone on any past day (Attendance → Team report → person → tap the date).
- Leave (dates) and Permission (Morning / Evening) are approved the same way.
- Dashboard (Super Admin & Admin staff): today's in-office count, who is on leave, who has permission, who hasn't checked in, and requests waiting for approval.
- All times and dates are India time (IST).
Calendar colours: Present green, Absent red, Leave purple, Morning permission blue, Evening permission orange, Half day amber, Week off grey, red dot = late in, dashed = waiting for approval.

New team member (name, email, phone, role) → username + password are generated and shown once (copy or send on WhatsApp).
Local run: `DATABASE_URL=postgres://... npm install && npm start` (first admin: admin / admin123 unless ADMIN_PASSWORD is set).

## Job flow
1. Admin creates ticket (optional Google Maps link) and assigns a technician → technician gets a notification (🔔).
2. Technician opens **My Jobs → To do**, taps Start work → admin is notified with time + name. If the customer has no map location, the technician's current GPS is saved and shown on a map for future jobs.
3. Pending (reason required, optional cash received) can be resumed later.
   Before **Work done** the technician must pick **Free service** or **Paid service**. Paid → **Cash** (enter amount) or **Bank** (enter amount + upload the transfer screenshot). Done → status **Awaiting Payment**.
   Call and WhatsApp buttons show on every open job (and are logged in the job history).
4. Admin taps **Payment received & complete work** → a sheet shows the cash handed over and/or the bank screenshot, admin picks the account, confirms → job becomes Resolved. Free services are confirmed the same way with nothing to record.

## Leads
When a lead's stage is **Site Visit** the form and detail screen show a location pin: paste a Google Maps link or tap **Pin my current location**; the lead detail shows the map and an **Open in Maps** button.

Notifications are in-app (checked every 20s); phone alerts show while the app is open/installed and notifications are allowed.
