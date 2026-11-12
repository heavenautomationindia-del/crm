# Rago CRM – Heaven Automation
Node + Express + Postgres, installable as a phone app (PWA).

## Deploy
1. Push this folder to a GitHub repo.
2. Render → New → Blueprint → pick the repo (render.yaml creates the web service + Postgres).
3. Sign in as **admin** / **Admin123**, then change the password in Profile → Change password.

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
Local run: `DATABASE_URL=postgres://... npm install && npm start` (first login: admin / Admin123 — change it in Profile).

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

## Calendar, Siri & Google Assistant
Profile → "Google Calendar · Siri & Google Assistant" → Set up.
- **Google Calendar:** "Add to Google Calendar" subscribes to your personal calendar link (reminders, lead follow-ups, technicians' open jobs). Google refreshes it every few hours; each reminder also has an instant "📅 Add to Google Calendar" button.
- **Siri:** make a Shortcut (Dictate Text → Get Contents of URL with your personal link + dictated text → Speak Text) named "Rago reminder". Say "Hey Siri, Rago reminder… tomorrow 10 am call Kumar".
- **Android / Google Assistant:** long-press the app icon → "Say a reminder", or To-do → 🗣 Say a reminder.


## Team chat (Version 9)
- **Chat** menu for everyone (including support staff). **All Staff** group has every active user automatically.
- Start a **1-to-1 chat** or a **group** (＋ New). The group creator or the Super Admin can rename, add or remove people.
- Type **@** to tag a person (or **@everyone**). Tagged people get a bell notification and a phone alert.
- Send **photos** (📎, shrunk on the phone before upload) and **voice messages** (tap the mic, then send).
- Reply, copy, or delete your own messages (long-press on a phone, right-click or ⋯ on a computer). The Super Admin can delete any message or chat.
- Unread counts show on the Chat icon. Direct messages show ✓✓ Seen. You can mute any chat.

## Holidays, festivals & the daily greeting
- **Holidays** page: Tamil Nadu government holidays for 2026 and 2027, plus festivals and special days. The Super Admin can add, edit or delete days.
- Office holidays show as **Holiday** in attendance, so no one is marked absent.
- Everyone gets a wish at 8 am on the day, and a reminder after 5 pm the day before an office holiday.
- The first time each person opens the app each day, they see a short greeting: the festival wish, work anniversary, holiday notice, a thought for the day, and their tasks for the day.

## Lead discussion
- Every lead has a **Discussion** inside its pop-up for the Super Admin (MD) and the staff who created the lead or are assigned to it. You can send messages, voice messages and photos there.
- Each message alerts the others on the lead. Tapping the alert opens the lead at the discussion. Lead discussions also appear in **Chat**.
- Voice notes recorded in the New lead form, and earlier voice notes on a lead, appear in that lead's discussion.

## Projects (Version 10)
- **Projects** menu (all except support staff). Open a lead and tap **📁 Convert to project**. The lead's details and its discussion move into the project. The Super Admin can also start a blank project.
- Each project has:
  - **Chat** with messages, @tags, voice messages, photos and **files** (PDF, Word, Excel and so on, up to 10 MB).
  - **Details**: customer, call, WhatsApp, map, value, dates and the original lead data.
  - **Tasks**: a checklist with an assigned person and a due date.
  - **Files**: every photo and document shared in the chat.
  - **Team**.
- Only the **Super Admin** adds or removes people (admin staff, technicians, anyone). Everyone in the team is notified about new messages, tasks and status changes.
- Status: Planning → In Progress → On Hold → Completed / Cancelled. The Super Admin and admin staff can change it.
- Files can now be sent in every chat, not only in projects.

## Brand for technicians and support staff
- When adding or editing a team member, technicians and support staff now have a **Brand** (their home brand, used for salary and lists). Any brand can still allocate a technician.

## Titles and company names
- New lead and New service both have a **title** (Mr. / Ms. / Mrs. / Miss / Dr. / M/s.) next to the name. New forms start with **Mr.**
- New service has a **Company name** for new customers. For an existing customer, the company can be added or changed when you create the ticket.
- The company shows on ticket cards, on the ticket, and on the Customers list. Customers can be searched by company.
- When a lead is won, its company is kept on the customer.

## Services created by the MD
- When the Super Admin (MD) creates a service or job, that brand's admin staff get a notification. The ticket shows a **👔 From MD** badge and "Created by".
- When the MD allocates a technician or helper, the brand's admin staff are notified too.
- The brand choice in New service starts on **Heaven**. The note under it says that brand's admin staff will handle the ticket.
