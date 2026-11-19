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

## Shift, week off, pay rules and overtime (Version 11)
- **Team → Add / Edit member** (Super Admin only) has *Attendance & pay rules* for each person. Each part has an on/off switch:
  - **Shift timing**: check-in time, check-out time and grace minutes. Late = after check-in + grace.
  - **Weekly off**: any day, Sunday by default. No check-in is needed and the person is never absent on that day.
  - **Leave & absent salary cut**: leave and absent days share the free days (default 1 a month). After that, 1 day's salary per day (loss of pay).
  - **Permission salary cut**: free permissions (default 2). Each extra one = half a day's salary.
  - **Overtime pay**: ₹ per hour. Time after the check-out time counts once it passes the set minutes. Working on the week off or a holiday counts in full. Overtime is shown in attendance and added to the salary.
- **Week off change**: staff can ask "this week I'll take Wednesday off" (Attendance → Change this week, or 🔄 Week off in Apply leave). Once admin approves, that day is off and that week's usual off day becomes a working day.
- **Disabling a member** (Status → Disabled) signs them out everywhere. They can't log in until they're set Active again, and the login page says the account is disabled.

## Notes (Version 12)
- **To-do → New note** opens an Apple Notes style editor:
  - The first line is a big bold title, and the note saves itself as you type.
  - 📌 pins a note, and the trash icon deletes it.
  - The checklist button adds ☐ boxes. Tap a box to tick it ☑, and Enter starts the next box.
- Each note has a **day** (📅 chip). It shows in that day's To-do, and the date strip shows a yellow dot.
- **All notes ›** opens the Notes list, with search, a Pinned group and notes grouped by day.
- The **Super Admin** can write a note for any staff member (👤 chip). They get a notification and the note shows on their chosen day, marked "From …". The Super Admin's Notes list can show *Notes I wrote for staff*, *Everyone's notes* or one person's notes.

## Version 13
- **Feature switches per person** (Team → Add / Edit member): team attendance (who came, leave, absent), approve leave & mark attendance, payroll, billing, edit customers, lead sources & interests, team chat, projects, sending voice messages / tasks to others. Existing Admin staff keep what they had.
- **Profile photo** can be added while creating a member. All profile pictures are round.
- **New service**: person name and company are optional; only the phone is needed.
- **Edit customer** (name, title, company, phone, email, address) from the ticket or the Customers list.
- **Customer history**: tap a customer to see tickets, payments received (with discounts), money outstanding, money still with the technician, and leads with the same phone.
- **Billing**: the technician can finish a job as **🧾 Billing**. It leaves their list and appears in the **Billing** tab for staff with the billing switch. Write the quotation (lines + notes), save it, print it, **Convert to bill**, then **Payment received** (Cash / UPI / Bank). The ticket is then Resolved.
- **Discount** on every payment confirmation: No / Yes. With Yes, enter the actual amount and the discount, and the final amount is calculated. It is saved on the customer's history.
- **Services month filter** starts on this month. Open tickets from earlier months stay visible. Pick any earlier month or All months.
- **Allocation**: technicians on leave, on their week off, on a holiday or on permission right now show as ⛔ and can't be picked. A permission later in the day is shown next to the name.
- **Lead sources & interests** can be edited (Leads → ⚙ Sources).
- **Won lead → New job**.
- **Give leave / permission** (Holidays page, Super Admin): a full-day leave or a time permission for everyone or chosen people. It's not counted in anyone's leave or permissions, and nobody is marked late or absent for it.
- **Voice messages & tasks** can be sent between admin staff (with the switch). The Super Admin sees who sent what to whom.

## Version 14 — WhatsApp (Sales & Service numbers)
A shared WhatsApp inbox inside the CRM, using Meta's official WhatsApp Cloud API.
- **WhatsApp menu**: a 💼 Sales tab and a 🛠 Service tab, each with its own unread count. Chats look like WhatsApp: green bubbles, photos, PDFs, voice notes, locations, replies to a message, and ✓ / ✓✓ / blue ✓✓ ticks.
- **Everyone with the WhatsApp switch** (Team → member → Features) can see and reply. The customer only sees your business number. Each reply shows which staff member sent it.
- **New number on the Sales number** becomes a new chat and a **New Enquiry lead** (source WhatsApp). This can be turned off in setup. A known number is linked to its lead or customer automatically.
- **New number on the Service number** becomes a new chat linked to the customer with that phone. ⋯ → *New service ticket* or *Make a lead* creates one from the chat.
- **Inside a lead pop-up** there is a WhatsApp chat on the Sales number. **Inside a ticket pop-up** there is one on the Service number.
- **24-hour rule (Meta)**: you can reply freely for 24 hours after the customer's last message (the chat header shows the time left). After that, or for a first message, send an approved **template** (📋 button). Its blanks are pre-filled with the name and shown in a preview.
- **Notifications**: a push notification for every incoming message, a bell notification for every new WhatsApp lead, and badges on the menu.
- **Voice notes** recorded in the app are converted to WhatsApp's format automatically (ffmpeg is included).
- **📊 This month**: messages sent, free replies left, and an estimated Meta bill with GST.
- Not supported yet: templates with a photo or video header.

### Meta setup (one time, Super Admin)
1. At business.facebook.com, complete **Business verification**.
2. At developers.facebook.com/apps, create an app of type **Business** and add the **WhatsApp** product.
3. Go to WhatsApp → API Setup → **Add phone number** and add the Sales number and the Service number. Copy each **Phone number ID** and the **WhatsApp Business Account ID**.
4. Go to Business settings → System users → add an Admin user. Assign the app and the WhatsApp account to it. Generate a token with `whatsapp_business_messaging` and `whatsapp_business_management` and expiry **Never**.
5. Go to App settings → Basic and copy the **App secret**.
6. In the CRM: Profile → 🟢 WhatsApp numbers → **Set up**. Paste the token, the app secret, the WABA ID and both Phone number IDs, then press **Save** and **Test connection**.
7. In Meta: WhatsApp → Configuration → Webhook. Paste the **Callback URL** (`https://YOUR-APP.onrender.com/webhook/whatsapp`) and the **Verify token** shown in the CRM setup, verify, then subscribe to **messages**.
8. In WhatsApp Manager, add a payment method and create message templates.

Instead of step 6 you can put the keys in Render → Environment: `WA_TOKEN`, `WA_APP_SECRET`, `WA_VERIFY_TOKEN`, `WA_WABA_ID`, `WA_SALES_PHONE_ID`, `WA_SERVICE_PHONE_ID`. Environment values override what is set in the app.

## Version 15 — Billing (Swipe-style)
A full GST billing section inside the CRM: **Billing** in the menu. It needs the *Billing* switch; purchases, vendors, expenses and profit need the *Purchases* switch.
- **Documents**: Quotation, Tax Invoice, Proforma invoice, Delivery challan, Credit note and Purchase.
  - A quotation can become an invoice, proforma or challan. Proforma and challan can become an invoice.
  - Duplicate, edit or cancel any document. Cancelling gives the stock back and undoes balances.
- **GST is worked out automatically**:
  - Same state as the brand: CGST + SGST. Other state: IGST.
  - Per-line discount, rates with or without GST, other charges, discount on the total, and round off.
  - HSN/SAC on every line, a tax-rate table and the amount in words on the print.
- **Each brand has its own GST profile** (Billing → Settings, Super Admin only):
  - legal name, GSTIN, state, address, logo, colour, bank, IFSC and UPI
  - default GST, default terms and print design (Modern, Classic or Thermal 3-inch)
  - numbering prefix and next number, so you can **continue from Swipe's numbers**
- **Payments**:
  - Received or partial payments (Cash, UPI, Bank, Cheque or Card) with Unpaid / Partial / Paid / Overdue status.
  - A credit note made against an invoice lowers what is due on it.
- **Share & print**:
  - Print / Save as PDF.
  - Share a link with the customer (no login needed). It shows the bill and a **Pay by UPI** button for the amount due.
  - Send the link by WhatsApp app, CRM WhatsApp or email.
- **Products & stock**:
  - Products and services with code, HSN, unit, selling and purchase price, GST, category, and opening stock with a low-stock alert.
  - Invoices and challans take stock out; purchases and credit notes put it back. Stock in, stock out and set stock, with a history for each product.
- **Customers & vendors**:
  - GSTIN (the state is filled in from it), billing and shipping address, and opening balance.
  - Each has a ledger with a running balance, and dues can be sent as WhatsApp reminders.
- **Expenses** by category.
- **Reports** (any date range, download to Excel or print):
  - sales register, GST summary (sales and purchases, B2B/B2C), HSN summary
  - item-wise sales with profit, customer-wise sales, payments, stock value
  - purchase register, expenses, Profit & Loss
- **Import from Swipe / Excel / CSV**:
  - In Swipe, export Products, Customers or Vendors to Excel and upload the file in Billing.
  - Columns are matched automatically and you can change any match before importing.
  - Existing items are updated, not duplicated (matched by code or name, and by phone or GSTIN for parties).
  - Import templates and Excel exports are included.
- **Linked to the CRM**:
  - Lead pop-up → *New quotation*.
  - Ticket billing → *Make GST invoice from these lines*. It is marked paid automatically when the ticket's payment is received.
  - The customer history shows bills and dues.
- Not included: e-invoice (IRN) and e-way bill generation, which need a GST Suvidha Provider account.

## Version 16–17 — Not assigned tickets, Warranty & Service, photo rotate
- **Not assigned**: a red tab in Service Flow, plus a dashboard tile. It lists every open ticket that has no engineer yet.
- **Warranty & Service** (new menu, plus a *Warranty & service* switch per staff member; on for Admin staff by default):
  1. **Engineer at the site** taps **Pending** and then chooses **⏸ Work pending** (same as before) or **🛡 Warranty / service material received**.
     - For material received, at least **one photo is required**. A voice message, note, item and serial number are optional.
     - The engineer's job is finished (it goes to *Awaiting Payment* as free). It is not a pending job.
  2. **The office is notified** and the case appears under **Warranty & Service** with the engineer's photos, voice message and note.
  3. **The office decides:**
     - **Type:** Warranty or Service.
     - **On site:** pick the service engineer taking care of it (they get notified), and track the work: Not started / Started / Done.
     - **Off site:** choose a **W&S vendor** (or create one on the spot), docket / RMA number, material *With vendor* → *Returned to us*, and **vendor charges**.
     - **Customer:** Free or Paid with the charge amount. Record money received (Cash / Bank + account).
  4. **Finish:**
     - **Convert to service visit** creates a new ticket for the same customer to return / install the item, with any amount still due.
     - **Close**, or **Cancel**: give a reason and say where the material is now (returned to customer / returned to vendor / left with vendor / with us).
  - **W&S vendors** are separate from purchase vendors. Each has an account: items with them now, total charges, payments (Cash / Bank) and balance to pay.
  - Every step is in the case history and also on the original ticket's timeline.
- **🏦 Bank & cash accounts** (Profile, Super Admin): edit the accounts shown when money is received or paid.
- **Photo viewer**: ⟲ / ⟳ Rotate. *Save photo* saves the rotated version.

## Version 18 — Shipping address, scrolling menu, logo fix
- **Shipping address** for every customer:
  - Fields: contact name, phone, address, city, pincode, state. It is set in Billing → Customers, or right on a bill, using the **Same as billing address** switch.
  - Every quotation, invoice, proforma, challan and credit note prints **Bill to** (billing address) and **Ship to** (shipping address) side by side.
  - When goods ship to another state, the place of supply follows the shipping state and GST changes to IGST automatically.
  - Swipe / Excel import and export include the shipping columns.
- **Desktop left menu scrolls** when there are more items than fit on the screen.
- **Billing → Settings logo** now saves correctly and prints on bills.
