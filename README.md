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

## Version 19 — GSTIN auto-fill, box headers, photo viewer
- **Billing Desk and Warranty & Service headers** now use the same box tiles as Services and Leads, each with a live count.
  - Billing tiles: Invoices, Quotations, Proforma, Challans, Credit notes, Purchases, Expenses, Products, Customers and Vendors.
  - Warranty & Service tiles: Open, New, In progress, With vendor, Ready, Converted, Closed, Cancelled, All cases and W&S vendors.
  - On a phone, the tiles scroll sideways.
- **GSTIN everywhere:** billing customers, billing vendors, W&S vendors, the customer edit screen and the party on any bill.
  - **Auto-fill:** type a 15-character GSTIN and the details fill in by themselves (or tap 🔍 Fetch): company (legal name), name (trade name), address, city, pincode and state. On a bill the GST type updates too (IGST for another state).
  - **Checks first:** a GSTIN with a wrong check digit is caught before any lookup, so no credit is wasted.
  - **Without a lookup key:** only the state and PAN are filled from the GSTIN.
  - **With a key:** add one in Billing → Settings → 🔍 GSTIN auto-fill (get it at gstinapi.in/api-keys), or set the `GSTIN_API_KEY` env var. The key is shown masked.
  - **Caching:** each GSTIN result is kept for 30 days, so repeat lookups are free.
- **Ticket photos (report book, work photos)** now open inside the app with ⟲ / ⟳ Rotate and Save, instead of a new browser tab.
- Env (optional): `GSTIN_API_KEY`, `GSTIN_API_URL` (default `https://www.gstinapi.in`).

## Version 20 — Free service engineers
- **Services → "Free engineers" tile**, right next to *Not assigned*. It shows how many service engineers have no job right now.
- Tap the tile to see every engineer, in four groups: **Free now**, **Busy**, **Away today** and **All engineers**.
  - **Free** means no job in *Assigned*, *On-Process* or *Pending*.
  - **Busy** engineers show each open job: ticket no, status and customer. Tap a job to open it.
  - **Away** means leave, a week off, a holiday or permission time.
  - Each engineer shows today's attendance (checked in / checked out / not checked in) and when they finished their last job.
- **Assign** on an engineer lists all *Not assigned* tickets; tap one to give it to that engineer. The free and not-assigned counts update straight away.
- Technicians don't see this list. Office staff need the create, assign or edit services permission.

## Version 21 — Brand-wise WhatsApp numbers and templates
- **Any number of WhatsApp numbers**, each with a **brand** and a **use** (Sales or Service). For example: Heaven Sales, Heaven Service, G Media Sales, G Media Service, Rago Infotech Sales and Rago Infotech Service.
  - Add them in Profile → WhatsApp setup → **📱 Numbers → ＋ Add number**.
  - Your existing Sales and Service numbers carry over with all their chats.
- **Switch on / off** each number. A switched-off number is hidden from staff and can't send. Messages that arrive on it are still saved.
- **Brand access:**
  - Staff of a brand see only that brand's numbers and chats. A number set to *All brands* is shared.
  - Super Admin sees every number.
  - Push alerts go only to people who can see the number.
- **Inbox:** one tab per number plus *All chats*, with an unread count on each. In *All chats*, every chat shows which number it is on.
- **＋ Chat** starts a chat with any mobile number from the number you pick.
- **Which number is used:** from a lead, ticket or bill, the app picks the brand's Sales number (for leads) or Service number (for tickets). When more than one number could fit, it asks **"Send from which WhatsApp number?"**
- **Sales numbers:** unknown numbers that message a Sales number become a lead of that number's brand. You can turn this off per number.
- **Different company accounts:** a number can have its own WhatsApp Business Account ID and its own token, for a company in another Meta business portfolio.
  - **Test connection** checks every number and every account.
  - It switches each account's messages to the CRM on.
- **Templates (to message a customer more than 24 hours after their last message):**
  - **📋 Templates** lists every template with Meta's review status (approved, pending, rejected with the reason).
  - **➕ New template** offers ready-made texts for each brand: greeting, enquiry follow-up, quotation sent, reconnect, service update, engineer visit, service done and payment reminder. Review and send them to Meta for approval from inside the CRM.
  - Templates are named after the brand (`heaven_…`, `gmedia_…`, `rago_…`). Staff see only their own brand's templates and shared ones.
- Monthly usage is shown per number.

## Version 22 — Billing: brand choice, Bill of Supply, drafts, seal & signature, bank accounts
- **Choose the brand at the top of the Billing Desk** (All brands · Heaven · G Media · …). Invoices, quotations, customers, expenses, the overview, the counts and the reports then show only that brand. The app remembers your choice. New bills are made for the chosen brand. Products and vendors are shared by all brands.
- **Bill type on every bill: Regular (GST) or Bill of Supply.** A Bill of Supply adds no GST, hides the GST columns and prints with the title "Bill of Supply".
- **Purchase price with GST or without GST:** set this on each product. When the product is used on a purchase, its rate follows that setting.
- **Categories right inside the quotation / invoice:**
  - Tap a category to see its products and add them with one tap.
  - Tap **＋ Add category** to make a new one on the spot. You can also make one from the product form.
  - Items are tagged with their category, and the printed bill groups the items under category headings.
- **GST 18% by default.** The items header has a **GST** box with **Apply to all**, which sets the same GST on every item. It also has a **Rates: Without GST / With GST** switch for all items.
- **＋ Add description** under an item now opens only a description box. HSN and unit still come from the product.
- **Several bank accounts per brand** (Billing → Settings → Bank accounts; the first one is the default). While creating a quotation or invoice, choose which account to print, or choose "Don't show bank details".
- **Round seal and signature:** upload them in Billing → Settings. The white paper background is removed automatically. They print above "Authorised signatory" on quotations and invoices. You can switch them off on any bill.
- **Drafts:** closing a quotation or invoice you are creating asks you to **Save**, **Save as draft**, **Discard** or **Keep editing**. This happens with ✕, the Esc key or a tap outside. There is also a **📝 Save as draft** button.
  - A draft has no number yet. It does not touch stock, totals or balances.
  - Find drafts under the **📝 Drafts** filter. Open one with **Continue editing**. Saving it for real gives it the next number. A draft can also be deleted.
- **Full view:** opening a quotation or invoice now shows the complete bill, exactly as it prints, with logo, items, GST table, bank, seal and signature. **☰ Summary** shows the short view. The printed / shared bill also fits better on phones.

## Version 23 — Billing works like Swipe: table lists, row menus, full-page create, Convert at the top
- **Lists as a table** for invoices, quotations, proforma invoices, challans, credit notes and purchases. Columns: Amount · Status · Bill # (with who made it) · Customer (with phone and a WhatsApp dot) · Date (with "an hour ago" / "Yesterday, 3:05 PM").
  - **Status tabs with counts:** All · Open · Closed · Lost · Cancelled · Drafts. Invoices and purchases have All · Unpaid · Partial · Paid · Overdue · Cancelled · Drafts.
  - A **period** box: This year (April to March) · This month · Last month · Last year · All time. There is also a search box and a **＋ Create** button.
  - **Footer:** Total and Closed (for invoices: Received and Due), and pages of 50 with ‹ 1 / N ›.
  - On phones every bill shows as a card.
- **Buttons on each row:** ₹ (record a payment on an unpaid invoice), 👁 View, ➤ Send, and **•••**. The ••• menu has:
  - Edit, Download PDF / Print, Thermal print, Duplicate, Send / share and Payment received
  - Mark accepted / Mark lost, Credit note
  - **Convert to** Invoice / Proforma invoice / Delivery challan
  - Cancel
  - Drafts have Continue editing and Delete draft instead.
- **Create / edit opens as a full page** with a back arrow, the number box (prefix + automatic number) and Save at the top.
  - Type (Regular · GST or Bill of Supply) and brand.
  - A Select-customer panel and a Date / Validity / Reference panel.
  - **Products & Services:** search a product, type the **Qty**, tap **＋ Add to Bill**. Or type any name and press Enter to add a one-time line. "⊕ Add new product" is right there, along with the category chips.
  - Item table: Product name · Qty · **Unit price** · **Price with GST** (type either one and the other fills itself) · **Discount in % or ₹** (tap the % / ₹ button) · GST · Total.
  - **Apply discount (%) to all items**, the GST Apply to all box, and an Items / Qty count.
  - **Bottom bar:** Save as draft · Save and print · Save.
- **Quotation view has its actions at the top:** Edit · Download PDF / Print · Send · ₹ Payment received · **Convert ▾** (to Invoice, Proforma invoice, Delivery challan) · ••• More (Thermal print, Duplicate, Mark accepted / lost, Credit note, Cancel). A proforma invoice can now also become a delivery challan.
- **📊 Insights** (new Billing tile). It greets you ("Hi, name 👋") and shows any period: last 30 days, this month, last month, last 3 months, this year, last year or custom dates. Every number is compared with the period just before it.
  - **Business overview:** a bar chart of Sales / Purchases / Expenses per day (per week or month for long periods), with the previous period in grey and an average line. Hover a bar to see its values; a Table view is also there. Next to it: Sales +, Purchases −, Expenses − and **Net**.
  - **Receivables** and **Payables:** amount outstanding, overdue count, number of customers / vendors and the oldest bill. Aging breakdown: 0–5, 6–10, 11–20 and 20+ days.
  - **Cash flow:** money in, money out (vendor payments + expenses) and net, with ↗ / ↘ %. Inflow **by mode** or **by bank**.
  - **Expenses** with the top expense categories.
  - **Customers:** active, repeat and with dues, plus top customers by revenue. **Vendors:** active and with dues, plus top vendors by spend.
  - **Products:** units sold and top selling products. **Top categories** by revenue, units or orders. **Inventory health:** out of stock, low stock, healthy.
  - Follows the brand chosen at the top.
- **📦 Inventory** (new Billing tile):
  - Four boxes: **Low stock** (items and qty), **Positive stock**, **Stock value at sale price** and **Stock value at purchase price**. Tap a box to filter.
  - Search, category and status filters.
  - Table: Item · Qty · Status (In stock / Low / Out) · Purchase price (incl. / excl. tax) · Sale price · Last updated · **Stock in / Stock out** buttons on every row.
  - **⬇ Bulk stock in / ⬆ Bulk stock out:** pick many items, type each quantity and add a note, then save once.
  - **🕘 Timeline:** every stock move (sales, purchases, returns, manual and bulk) with the bill number, who did it and the note.

## Version 24 — Field Visits (sales staff check in / out at sites, photos, customers, GPS route and km)
- New menu item **📍 Field Visits** for anyone with the new permission **"Field visits"**. Sales staff get it automatically; switch it on for others in Team. A second permission, **"See everyone's field visits, routes & kilometres"**, is for managers. Super Admin and Admins have both.
- **▶ Start day:** tap it when leaving home or the office. Kilometres are counted from there.
- **📍 Check in here:**
  - The phone's GPS location is saved, with its accuracy shown.
  - **Old customer:** search by name, company or phone. It shows ✅ *Old customer* with their details, service tickets and **earlier visits** (date, who went, result and notes).
  - **New customer:** name, company / shop, phone and address. If the phone number already belongs to a customer, the app offers to use that customer.
  - **Purpose:** Sales visit · Product demo · Follow-up · Site survey · Payment collection · Service / support · Other.
  - **Photos** straight from the camera, plus an optional note.
- **While on site:** a card shows the customer, the check-in time and how long you have been there. Add more photos (up to 20) and write the **description**; it saves by itself.
- **✓ Check out:**
  - The description is required, and so is **how it went**: Interested · Quotation needed · Order confirmed · Follow-up later · Not interested · Payment collected · Other.
  - Next follow-up date (optional). The check-out GPS location is saved.
  - A **new customer is saved to Customers**, and also **added as a lead** (source "Field visit", assigned to the sales person, with the site location and the visit note) unless you switch that off.
- Then travel to the next place and check in / check out again. **🏁 End day** when finished. You can still check in later if needed.
- **Route & kilometres:**
  - While the day is on and the app is open, the phone's GPS position is recorded every 30 seconds or more.
  - Poor GPS fixes and impossible jumps are ignored.
  - The km between each place is the distance along the recorded route.
  - If the app was closed while travelling (iPhone and Android don't let web apps track in the background), it uses the straight-line distance + 25% and marks it **"approx."**. Keep the app open while travelling for exact km.
- **Day view:**
  - Tiles: Visits · Km travelled · Time on site · New customers.
  - A **map** of the route with numbered stops (start point in green) and **Open route in Google Maps**.
  - A timeline of every stop: check-in / check-out times, time spent, km from the previous place, purpose, result, follow-up, phone, address, description, photos (tap to enlarge), check-in and check-out places on Google Maps, and links to the lead and customer.
  - Pick any date to see past days.
- **Team** (managers): every person on the road that day, with visits, km, time on site, first check-in, last check-out and where they are now ("At Murugan Traders" / "Travelling" / "Day ended"). Tap a person to see their day, map and photos.
- **Month report:** km and visits per day for any person and month. Tap a day to open it.
- The map library is now inside the app (`public/vendor/leaflet`), so maps don't depend on another website. Map tiles come from OpenStreetMap.

## Version 25 — Real Google Maps road km, ₹/km travel allowance, product move up / down, expense categories
- **Kilometres now come from Google Maps road distance** (Google Routes API):
  - Each leg is measured by road: start of day → first visit, visit → next visit, last visit → end of day.
  - **This works even when the app was closed while travelling**, because Google gives the road distance between the check-out point and the next check-in point.
  - When the app was open, the GPS points are sent to Google as "via" points, so detours are counted too.
  - Each leg shows "12.4 km by road (Google Maps · ~25 min)". Results are stored, so Google is asked only once per leg.
  - Without a key (or if Google fails), it falls back to the GPS route / straight-line estimate as before. Super Admin sees Google's error message and a **↻ Recalculate km with Google** button.
- **Super Admin → Field Visits → ⚙ Km & rate:**
  - Google Maps API key (stored safely, shown only as ••••1234) with a **🧪 Test Google key** button.
  - Vehicle: Two-wheeler or Car (Google measures the road route for that vehicle).
  - **Rate per km (₹)** for everyone, plus an optional **different rate per person**.
- **Travel allowance = km × rate**, shown on the day view (tile "Travel allowance ₹… @ ₹x/km"), in the Team view (per person and total) and in the Month report (per day and total). When a person taps **End day**, that day's rate is fixed, so later rate changes don't alter past days.
- **Quotation / invoice items can be re-ordered:** **▲ / ▼** buttons under each item (big on phones), and on a computer you can drag the **⋮⋮** handle. Items save and print in that order.
- **Expense categories:** **＋ New category** in the expense form and **＋ Add category** in the Expenses list. New categories appear with the standard ones, and "Other" stays last.
- **New role "Sales admin"** (made by Super Admin or an Admin with Team access). It manages the sales team:
  - sees **all leads of their brand** (new feature "See all leads of the brand")
  - sees **everyone's field visits** with routes, km and allowance
  - billing and team attendance
- **🎭 Roles & features** (Super Admin, Team page):
  - **Add your own roles** (e.g. "Marketing Executive"). Each one "works like" Admin, Sales admin, Sales, Technician or Support staff and has its own feature switches.
  - **Change the standard features** of each built-in role, or **Reset to standard**.
  - Optional: **give the new features to people who already have that role**.
  - When adding a member, the new roles appear in the Role list with their features ticked automatically. You can still switch any feature on / off for that one person.
  - Removing a role keeps the people's features; their label goes back to the base role.
  - Support staff can now also be given Field visits.
- **Desktop sidebar:** shows icons only. **Move the mouse over it and it opens with the names** (over the page, so nothing jumps). It closes when the mouse leaves.
- **Smoother on phones:** faster taps (no tap delay or grey flash), a small press effect on buttons, and pages / pop-ups don't drag the whole app when scrolled to the end.
