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

## Version 26 — ₹/km per person on the user form, field visits assigned from leads, map fix
- **Per-person kilometre rate while creating / editing a member (Super Admin):** when **Field visits** is ticked, a box **"📍 Field visit rate per km (₹)"** appears. Each marketing / field person can have a different rate. Empty = the common rate in ⚙ Km & rate. It is the same rate as in ⚙ Km & rate, so changing it in one place changes it in the other. Only Super Admin sees and sets it.
- **Assign a field visit from a lead (Super Admin, Admin, Sales admin):**
  - In the lead pop-up there is a new section **📍 Field visits** with a **📍 Assign field visit** button. Choose the field sales person (only people with Field visits are listed, with how many visits they already have), the date (today / tomorrow / any later day) and a note.
  - The person gets a **notification** (bell + phone push). Tapping it opens Field Visits.
  - The lead now **shows in that person's Leads** (even if it is not assigned to them), with a badge **"📍 Visit · name · date"** on the lead card ("Visited" once done). Admin and Super Admin see the same badge.
  - On their **Field Visits** page a **🗓 Planned visits** list comes first: today, overdue and coming visits, with the customer, phone, address, the note, who assigned it, **🧭 Go** (Google Maps directions) and **📍 Check in**.
  - Checking in from a planned visit fills the customer from the lead. At check-out no duplicate lead is made; the customer is linked to the lead.
  - The visit result goes into the **lead history**, the planned visit becomes **Visited**, and **the person who assigned it gets a "✅ Field visit done" notification**.
  - The assigner can **cancel** a planned visit (✕ in the lead), and the field person is told.
- **Fix:** the map on Field Visits no longer covers the bottom menu bar and the top bar while scrolling on phones.

## Version 27 — Field Sales Dashboard for Super Admin / Admin / Sales admin
- **Super Admin no longer gets Start day / Check in / GPS tracking.** Field Visits opens the **📊 Field Sales Dashboard** instead. Admin and Sales admin (anyone with "See everyone's field visits") get the same dashboard; if they also do field visits themselves they keep **My day**.
- **Tabs:** Dashboard · Person (any field person's day: map, photos, notes, km) · Team today · Month report.
- **Period:** Today · This week · This month · Last month.
- **Tiles:**
  - Field staff out today (e.g. 7/17) and **on site now**
  - Visits, **Km travelled**, **Travel allowance ₹**
  - New customers, **Orders confirmed**, **Planned visits** (with how many are late)
- **🟢 Live today:** a map with each person's last position. The badge colour shows On site, Travelling or Day ended. Each person shows their status ("At Murugan Traders since 10:20", "Travelling", "Day ended", "Not started") and today's visits and km. Tap a person to see their day.
- **How visits went:** results of all visits (Order confirmed, Quotation needed, Interested…) with bars and %.
- **👥 By person:** visits, km, allowance, rate, new customers, orders, planned and late visits per person. Tap a person to see their month.
- **🗓 Planned visits** (assigned from leads) with late ones in red, and **🕘 Latest visits** with photo, customer, person and result.
- Admin / Sales admin of a brand see only that brand's field staff.

## Version 28 — Field visit questions at check-out, stronger protection

**Field Visits — questions only at check-out**
- Check in is now one tap: only the time and GPS location are saved.
- Everything else is asked when the person taps **Check out**: customer (search old or add new), purpose, photos, description, how it went, next follow-up, and "add as lead".
- Check-out will not finish until a customer is chosen or typed.
- Visits planned from Leads still know the customer at check-in, so check-out skips the customer step for them.

**Protection**
- Security headers on every page (stops other sites from framing the CRM, blocks unknown scripts, hides the server type).
- The app page sent to browsers is compacted: comments removed, inner names shortened. The readable code stays only on GitHub and the server.
- Server files (server.js, package.json, .env, node_modules) can never be downloaded. Search engines are told not to index the CRM.
- Database and internal errors are no longer shown to users. They only show "Something went wrong" (details go to the Render log).
- An account locks for 15 minutes after 10 wrong passwords, even when the attempts come from different networks. This adds to the existing limit per network.
- Every API checks login and permissions on the server, so a user gets only the data and features their role allows, even if they try to call the API directly.

**What protection cannot do (honest note)**
Any web app has to send its screen code to the browser to run it, so a determined person can still read the compacted code. The real protection is what stays on the server: passwords, API keys, the database and the permission checks. To keep it safe:
1. Keep the GitHub repo **private**.
2. Never share the Render dashboard or the environment keys.
3. Give each user only the features they need (Settings → Roles / user form).
4. Turn off a user as soon as they leave.

## Version 29 — Call leads, email from your own mailbox, delivery details, bill filters, branch-wise products

**Billing**
- Every list (invoices, quotations, challans…) can be sorted by tapping **Amount, Status, Bill #, Customer or Date**. Tap again to reverse the order.
- **⚲ Filter**: amount from/to, status, bill number, customer, date from/to, and delivery (not delivered yet / transport / collected).
- **Create Quotation / Invoice**: the category chips are gone. Product search shows only the chosen branch's products (plus products shared by all branches).
- The customer box now also shows the **open leads of that branch**. Picking a lead links the bill to the lead, and it becomes a customer when you save.
- **Products & Inventory are branch-wise.** Each product has a Branch (or "All branches"). Use **🏷 Set branch** on the Products tab to move many products at once, e.g. "all products not given a branch yet → Heaven".

**Delivery (invoices and delivery challans)**
- Choose **🤝 Collected by customer** (who collected it, date) or **🚚 By transport** (transport name, tracking / LR number, vehicle number, date, details, photo).
- Set it while creating the bill or later with the 🚚 Delivery button. It is printed on the bill.

**Call leads (Android phones)**
- New menu **Call leads**. Calls of the set length (default **5 min**) from the chosen SIM come in with number, contact name, duration and SIM.
- Tap **＋ Add to leads** (source "Call") or Ignore. Calls with a number that is already a lead are added to that lead's history automatically.
- Super Admin / Admin set the minimum call length and choose incoming/outgoing (⚙ Call length).
- Turn on **"Call leads"** on the user (Team → user → features). It is on by default for new Sales and Sales Admin users.
- This needs the small **Rago Calls** Android app (sign in once, choose SIM, allow call logs). iPhone does not allow any app to read calls.

**Rago Calls Android app**
- The app file is inside the CRM: `public/app/rago-calls.apk`. Staff download it from **Call leads → Download app** (Android only).
- Install: allow "Install unknown apps" for the browser when Android asks. Open the app, check the CRM address (`https://rago-crm.onrender.com`), and sign in with the CRM username/password.
- Choose the SIM, then tap **Allow permissions** (Call logs + Phone).
- Android 13+: if Call logs is greyed out, go to App info → ⋮ → **Allow restricted settings** first.
- Set battery to **No restrictions** for Rago Calls. It syncs after every call and every 15 minutes, plus "Sync now".
- Only calls of the set length or longer are sent. Short calls never leave the phone.

**Warranty & Service — transport**
- On each case, add the transport details for every trip: **Received from customer, Sent to vendor, Back from vendor, Sent to customer**.
- Each trip is "by transport" (courier / transport name, tracking or LR number, vehicle, date, details, photo) or "by hand" (person name). Every trip is added to the case history.

**Mail**
- New menu **Mail**. Each user connects **their own Hostinger email** once (email + password). The CRM checks sending and inbox before saving. The password is stored encrypted and never shown again.
- Read your inbox and sent mail, open and reply.
- **✉ Email** buttons on quotations/invoices (adds a "View bill" button with the link) and on leads. Emails sent from the CRM are saved in the mailbox's Sent folder and in the lead's history.

**Render setup (one time)**
- Render → your service → Environment → add `MAIL_KEY` = any long random text (e.g. 40 letters and numbers). Do this before staff connect their email. Don't change it later, or everyone has to reconnect their email.

## Version 30 — Credit period per customer, overdue block with MD approval

**Credit period**
- Each customer can have their own **Credit period (days)** (Billing → Customers → edit).
- When you make an invoice for that customer, the due date is filled automatically (bill date + credit days).
- Customers without their own period use the **default credit period** from Billing → Settings → Credit control.

**Stop new bills while a bill is overdue (switch in Billing → Settings → Credit control, MD only)**
- When it is on, a new **invoice or quotation** for a customer with an overdue invoice cannot be saved. This also covers converting a quotation into an invoice.
- Overdue means the due date (plus any "extra grace days") has passed and money is still due.
- In the bill editor, a red box under the customer shows the overdue bills and the amount as soon as the customer is chosen.
- Staff can still **save as draft**. Other bill types (proforma, challan, credit note) and other customers are not affected.
- The block is lifted when:
  1. the overdue payment is received, or
  2. the **MD (Super Admin) approves**. Staff tap **🔒 Ask MD approval** (with a note), and the MD gets a notification and sees **🔒 Approvals** in Billing. An approval is valid **till tonight** for that customer.
- The MD can also approve directly while saving ("Approve as MD & save"). Every approval is recorded.

## Version 31 — Rago CRM Android app (the CRM + call leads in one app)

**What it is**
- One Android app, **Rago CRM** (`public/app/rago-calls.apk`, downloaded from `/rago-crm.apk`). It opens the CRM and stays logged in.
- It is an update of the Rago Calls app: phones that have Rago Calls get it updated without uninstalling, and it keeps the same signing key.
- Every CRM update (GitHub → Render) shows up in the app by itself. A new APK is only needed when the app itself changes.

**Works inside the app**
- Camera and gallery for all photo uploads (check-in, delivery, warranty), microphone for voice notes, and GPS for field visits.
- **Field visit km keep counting when the app is closed.** A "Field visit day is on" notification shows while the day is on, and it stops when the day ends.
- Print / Save as PDF for bills, ledgers, reports and salary slips (opens Android's print screen).
- WhatsApp, phone, maps and email links open in their own apps. Excel/CSV downloads go to the phone's Downloads folder.
- Phone back button: closes the open pop-up first; on a plain screen the app goes to the background.
- **Phone notifications:** new CRM alerts (leads, approvals, call leads…) show on the phone within about 15 minutes, even when the app is closed.
- **Call leads:** open Call leads → **This phone → Set up** → "Turn on with my CRM login" → allow Call logs → choose the SIM. No second password needed.

**Install**
1. On the Android phone, open the CRM in Chrome → Call leads → Download app (or open `https://rago-crm.onrender.com/rago-crm.apk`).
2. Open the file → Install. Allow "Install unknown apps" if asked.
3. Open Rago CRM → log in → allow Location, Camera, Microphone and Notifications when asked.
4. Battery: Settings → Apps → Rago CRM → Battery → **No restrictions**.

iPhone: keep using Safari → Share → Add to Home Screen. Call leads are not possible on iPhone.

## Version 32 — Call leads managed by Admin, staff filter, Super Admin reads mailboxes, email when Render blocks mail ports

**Call leads**
- **Staff filter** (Admin / Super Admin): choose a person to see only their calls and counts.
- **Only Admin / Super Admin set it up:**
  - Call leads → **👥 Staff phones**: choose the SIM for each person (All SIMs / SIM 1 / SIM 2). Their phone follows it at the next sync.
  - Only Admin / Super Admin can remove a phone or change the call length.
  - In the app, staff only see the SIM (read only) and cannot switch call leads off.
- Rago CRM app **v3** (included as `public/app/rago-calls.apk`) is needed for the SIM-from-CRM part. It installs over v2.

**Mail**
- **Super Admin can open any staff mailbox** (Mail → mailbox picker). This is read only: no reply, and messages are not marked read for the staff. Staff see "The Super Admin can read this mailbox" when they connect.
- Super Admin's "Sent from CRM" shows everyone's emails.
- **"Could not reach the mail server" when connecting:** Render's free plan blocks the email sending ports (465 / 587). Now:
  1. The CRM tries both ports.
  2. If sending is blocked, the email still connects. The inbox works and a clear "Sending is blocked" note shows.
  3. Super Admin can turn on **Mail → Settings → Sending route → Brevo**. Emails then go through Brevo over normal web traffic, still **from each person's own address**, with a copy in their Hostinger Sent folder.
- Brevo setup:
  - Make a Brevo account.
  - Senders, Domains & IPs → Domains → add your domain, and copy its DNS records into Hostinger → Domains → DNS until it shows verified.
  - SMTP & API → API keys → Generate → paste it in the CRM.
- Other fix: move the Render service to a paid plan (mail ports open). Then no Brevo is needed.

## Version 33 — Warranty & Service filters by branch, UI check of every screen

**Warranty & Service**
- **Branch tiles** (All branches / Heaven / G Media …) like Billing. The case counts follow the chosen branch, and the choice is remembered.
- **⚲ Filter:** type (Warranty / Service), handled (on site / off site / not decided), W&S vendor, engineer, received from/to date, transport (has details / none yet).
- **Sort:** recently updated, newest, oldest, most money due.
- Cards show the branch (when viewing all branches) and how many transport trips are recorded.

**UI fixes after checking every screen on desktop and phone**
- **Desktop side menu:** with many menus it no longer fit the screen, and Mail, Chat, WhatsApp, Projects, Warranty, Attendance, Salary and Holidays were hidden below it. Now it shows ⌃ / ⌄ arrows when there are more menus, the open screen is always scrolled into view, and the icons are a little tighter on shorter screens.
- Customers: the search box now uses the full width (it was cut to "Search name, company or ph…").
- Profile on phone: the notification sound "On" button no longer squeezes the text.
- Checked all 19 screens and the main pop-ups (lead, bill, service, warranty case, team, new invoice) at desktop and phone size: no sideways scrolling and no page errors.

## Version 34 — Delete permission, call leads phone + delete

- New feature switch **"Delete records"** (Team → user → features, or Roles). It covers leads, customers, service tickets, products, call logs and warranty cases.
  - **Super Admin can always delete.**
  - Other users can delete only when the Super Admin turns this on for them. It is off by default, also for Admin.
  - Before, product delete was open to every billing user; now it needs this switch.
- **Call leads:** 📞 button on every call (tap to call back) and 🗑 delete. The Ignored / Added / Already-leads tabs have **"Delete all"**. Deleting a call never deletes a lead made from it.
- **Warranty & Service:** 🗑 Delete on a case (with the permission).

## Version 35 — Company accounts (step 1 of selling Rago CRM)

- Rago CRM can now hold **many separate companies**. Each company has its **own private section of the database** (a Postgres schema) with its own leads, customers, bills, staff, settings, logo, WhatsApp, mail and call leads. One company can never see another's data.
- **Your current data is company #1** and nothing moved. All current logins, bill links, calendar links and phone apps keep working.
- **Usernames are unique across all companies**, so staff log in normally and land in their own company. There is no company code to type.
- Links that work without login (shared bills, calendar, Siri reminders, phone app, bill logo/seal) carry the company inside them.
- **WhatsApp for other companies:** each company gets its own webhook address, shown in its WhatsApp setup.
- Reminders, holiday greetings and other background jobs run for every company.
- New menu **Companies** (only for you, the Rago owner):
  - totals: companies, active users, paid companies;
  - every company with owner, phone, city, users, plan and status;
  - **＋ New company** (creates the company and its Super Admin login);
  - **Pause / Activate** (a paused company cannot log in).
- Next steps: modules + free plan (Attendance free up to 5 users), then signup with Razorpay.

## Version 42 — Yellow & ash again, new logo, Staff report, Bike / Bus travel, two packages

**Look** — back to the first Rago **yellow and ash** look everywhere (CRM, sign-up page, Console, invoices, emails). The glass designs are removed. The **logo** is now a yellow feather with an ash "Rago" (app icon, login, website).

**Staff report** (menu → Staff report; for Super Admin, Admins and people with Dashboard / Team attendance)
- Pick Today / This week / This month / Last month or any dates.
- For every person: new leads, follow-ups, quotations (and ₹), invoices (and ₹), calls (and minutes), service tickets made, services done, field visits, km, travel claim, days present and late. Totals at the top.
- **History ›** shows everything one person did, day by day (leads, follow-ups, bills, calls, ticket updates, visits, attendance).
- **🖨 Print** for the whole team or for one person's history.

**Field sales**
- At **Check in**: choose **🏍 Bike** or **🚌 Bus**. Bus asks for the **ticket amount** and a **ticket photo**.
- Bike km × ₹/km = **petrol**; bus tickets = **bus fare**; both make the day's **travel claim**. Bus trips are not counted as petrol km.
- **End day**: enter the **km noted on the bike meter** (optional) and, if going back by bus, the return ticket.
- The day shows **map km vs km noted by hand**; a difference of **5 km or more is flagged ⚠**. Admins can correct the noted km (＋ Add km).
- Field month report and Staff report show petrol, bus fare and total travel.

**Two packages from the same code**
- **rago-crm-heaven** — for Heaven Automation & G Media (your existing data). `SAAS=0`: no sign-up page, no Console/Companies, no plans; everything is on. `COMPANY_NAME=Heaven Automation`, `BRANCHES=Heaven,G Media` (only used on a brand-new database — existing data is never changed).
- **rago-crm-sale** — for selling Rago CRM module-wise (sign-up, 7-day trial, plans, Razorpay, Console). `COMPANY_NAME=Rago Infotech`.

## Version 41 — Automatic 001 numbers, ₹100 Attendance, full trial for added companies

**Automatic numbers (no typing)**
- Invoice, quotation, proforma, challan, credit note and purchase numbers are made automatically: **INV-001, QT-001, PI-001, DC-001, CN-001, PUR-001**.
- Each **branch has its own series** (branch 1 INV-001…, branch 2 also INV-001…), and each document type has its own series.
- The editor shows the next number at the top (it can't be typed). The prefix (INV-, QT-…) and starting number can still be set by the Super Admin in Billing → Settings.
- Purchases: the **vendor's bill number** is shown only inside the opened bill, not in the lists.

**Prices**
- Attendance & Payroll: **free for up to 5 users**; above 5 users **₹100 per user per month**. Other modules ₹199; whole CRM ₹499. Shown on the sign-up page, Choose plan screen and the website.
- Render variable `PRICE_ATTENDANCE` (default 100).

**Companies you add from Rago Console / Companies** now start with the **7-day trial with everything on** (before, they got only Attendance & Payroll).

**Fixes** — sign-up page and Console were unreadable when the computer/phone is in **dark mode**; they now always use the light glass style.

## Version 40 — Red Glass design

The whole app now has the **Rago Red Glass** look (like the sample video, in Rago red and ash):
- Glowing red-to-ash background, **dark glass sidebar** (on computers it now shows names, a Rago CRM title and a plan card), a full-width **glass top bar**, and one **frosted panel** holding white glass cards. On phones: a glass top bar and a glass bottom menu.
- **Smooth animations**: each screen's cards fade and slide in one after another; tiles lift on hover; buttons and menu items move slightly when you point at them. Turned off automatically for people who choose "reduce motion" on their phone.
- The **login screen**, **sign-up page** and **Rago Console** use the same glass style. Pop-up windows stay solid white so forms are easy to read. Dark mode keeps working.
- Website: the **Rago CRM page** (rago-crm.html) has the same red glass design with floating, animated cards. The rest of the website is unchanged.

Nothing else changed — all features work as before.

## Version 39 — Rago red look, GST number, fuller Console, clean new installs

**Rago red & ash look** — the app, sign-up page and Console now use the Rago Infotech colours (red #e3262b and ash grey), the same as the website. The help **?** button is ash and sits above the red **+** button on phones.

**GST number (GSTIN)**
- Sign-up page: optional **GST number** field (checked for a valid GSTIN).
- Choose plan / Pay screen: **🧾 GST bill details** — business name, GSTIN, billing address. Saved for next time and sent with the Razorpay payment.
- The Console shows the company's GSTIN and each payment's GST amount.

**Rago Console — company details**
- **Plan & trial**: Free trial / Paid / Trial ended, start → end date, days left with a bar, users active/allowed, branches used/allowed, monthly value, total paid, modules on, plan chosen at sign-up.
- **Usage**: last active (and who), last login, active users today · 7 days · 30 days, logins in 30 days.
- **Staff**: total, active, switched off, count by role.
- **Data**: leads, customers, quotations, invoices (this month and amount), tickets, products, attendance, field visits, calls.
- **Payments** list, and Call / WhatsApp / Email buttons. The company list shows "Trial · X days left" and "Ended → Free".

**Branches**
- A brand-new install starts with **one branch named after your company** (Render variable `COMPANY_NAME`, default "Rago Infotech"), not "Heaven" and "G Media". Existing data is not changed.
- Profile → **Branches**: tap ✎ to **rename** a branch, ✕ to remove it.
- Setting `COMPANY_NAME` in Render also renames your own company (company #1).

**Fixes** — the "All branches" button no longer covers "Say a reminder" on the to-do page.

**Invoice + email after payment**
- Every Razorpay payment gets an **invoice number** like `RAGO/2026-27/0001` (new series every financial year from April).
- Invoice page: Rago Infotech details and GSTIN, customer name, GSTIN and address, plan, users, months and period, SAC code, **CGST + SGST** (same state) or **IGST** (other state, from the customer's GSTIN), total paid. Print / Save PDF.
- An **email goes to the customer** (company email + Super Admin) with the invoice number, plan details and a private link to the invoice. No login needed for the link.
- Customers see all invoices in **Profile → Plan → Invoices**. The Console shows each payment's invoice with **Invoice** and **Resend email** buttons.

**Plan ending reminders**
- **4 days before** a plan or trial ends: an email + an in-app notification, and a **pop-up in the CRM** (once a day) for the Super Admin and Admins with a **Renew now** button.
- When it **has ended**: one more email + notification. The Console Activity shows each reminder.

**Render → Environment for emails and invoices**
- Emails are sent with the **Brevo key saved in your own company** (Rago CRM → Profile → Email → Brevo). In Brevo, verify the sender email.
- `MAIL_FROM` — the sender email (default `LEGAL_EMAIL`, else ragoinfotech@gmail.com). It must be verified in Brevo.
- `LEGAL_NAME`, `LEGAL_ADDRESS`, `LEGAL_GSTIN`, `LEGAL_EMAIL`, `LEGAL_PHONE` — printed on every invoice. With `LEGAL_GSTIN` set, the title becomes **Tax Invoice**.
- Optional: `INVOICE_PREFIX` (default RAGO), `INVOICE_SAC` (default 997331 — confirm with your auditor), `REMIND_DAYS` (default 4), `APP_URL` (default https://app.ragoinfotech.com).
- If you are not GST registered, set `PLAN_GST` to 0 so no GST is charged.

## Version 38 — Branch switcher on top, one branch per company, Razorpay payments

**Branch switcher (like "Change company" in Swipe)**
- A **🏢 All branches ▾** button at the top. Choose a branch and every screen (dashboard, leads, services, billing, attendance, payroll, warranty, reports) shows only that branch. The choice is remembered.
- Only for users who see all branches (Super Admin / admins without a fixed branch), and only when the company has 2 or more branches. Staff tied to one branch always see their own branch.

**One branch per company**
- A client company can create **1 branch**. Trying to add a second shows "Your plan includes 1 branch. To add another branch, contact Rago Infotech."
- Rago Console → company → Plan → **Branches**: raise it for that company (for example 2 or 3).
- Your own company (Rago) has no limit. Render variable `BRANCH_LIMIT` changes the default.

**Razorpay — pay inside the app**
- Profile → Plan / "Choose plan" / "Renew plan": choose modules, users and **1, 3, 6 or 12 months**. It shows the price + GST 18% and a **🔒 Pay ₹…** button (UPI, cards, net banking).
- When payment succeeds the plan switches on at once: Paid, the chosen modules and users, paid till date. Paying again adds to the end date.
- Safe: the amount is worked out on the server, each payment is checked with Razorpay's signature, the same payment can't be counted twice, and only the Super Admin can pay.
- You get a "💰 Payment received" notification. The Console shows every payment in Activity.
- If Razorpay keys are not set, the app shows the WhatsApp / Email renew buttons instead (as in V37).

**Render → Environment (add these — never paste them in chat or GitHub)**
- `RAZORPAY_KEY_ID` — from Razorpay Dashboard → Account & Settings → API Keys (starts with `rzp_live_`, or `rzp_test_` for testing)
- `RAZORPAY_KEY_SECRET` — shown once when you generate the key
- `RAZORPAY_WEBHOOK_SECRET` — any strong password you choose, and the same one in Razorpay → Webhooks
- Optional: `PLAN_GST` (default 18; set 0 if you don't charge GST), `BRANCH_LIMIT` (default 1)

**Fixes (V38.1)**
- A branch saved on a phone from another company no longer leaves the first screen empty.
- When a paid plan ends, the strip says "Your plan has ended" (not "free trial").
- Admins see "Only the Super Admin can pay" instead of a Pay button.

**Razorpay webhook** (so the plan switches on even if the customer closes the app during payment)
- Razorpay Dashboard → Account & Settings → Webhooks → Add new webhook
- URL: `https://app.ragoinfotech.com/webhook/razorpay` (or your onrender.com address + `/webhook/razorpay`)
- Secret: the same as `RAZORPAY_WEBHOOK_SECRET` · Events: `payment.captured` and `order.paid`

## Version 37 — Sell module-wise: plans, 7-day trial, Rago Console, help bot

**Prices (per user per month, GST extra)**
- One module: ₹199. Whole CRM (Leads, Service, Billing, Attendance, Field Sales): ₹499. Picking 3 or more modules never costs more than ₹499.
- Free plan: Attendance for up to 5 users, free forever.
- WhatsApp & Mail is a future **add-on** — it is not part of the whole CRM. The owner can switch it on by hand from the Console.
- Only **one Super Admin** per company.

**Sign up from the website** — `/signup`
- Customer picks Free, some modules, or the whole CRM, and the number of users, and creates their own company and login.
- **Every new company gets 7 days with all features on.** What they chose is saved and offered when the trial ends.
- After 7 days: Leads, Billing, Service and Field Sales lock (data is kept). Attendance stays free for 5 users. The Super Admin sees a "Renew plan" screen with the price, and can send the plan on WhatsApp or email to Rago until online payment is connected.

**During the trial / free plan**
- Quotations and invoices print with a light **"RAGO CRM" watermark** and a small "Made with Rago CRM" line at the bottom.
- A trial strip ("X days left — Choose plan") and a small Rago CRM card show on the dashboard and to-do for the Super Admin and Admins.
- Rago's own company never sees these.

**Rago Help** — the round **?** button at the bottom right. Tap a topic or type a question ("how to make invoice") and it explains the steps and opens the right screen. It works without the internet or any AI service.

**Rago Console** — `/console` (Rago owner login only)
- Every company: plan, users, last seen, sign-ups, logins, activity, monthly revenue.
- Change a company's plan, modules, users and paid-till date; pause, activate or delete.

**Render environment (optional)** — `PRICE_MODULE` (199), `PRICE_ALL` (499), `FREE_USERS` (5), `TRIAL_DAYS` (7), `TRIAL_SEATS` (50).

**Website** — new page `rago-crm.html` with modules, prices and sign-up buttons; "Rago CRM" link added to the menu and footer of every page.

## Version 36 — Ready for the stores: legal pages, delete account, Play Store app

- **Legal pages in Rago Infotech's name** (needed by Google Play, App Store and Razorpay):
  - /privacy (explains every app permission), /terms, **/refund** (cancellation and refund, new), /data-deletion and **/contact** (new). No prices are written on them.
  - Company details are set in Render Environment and can be changed without code: `LEGAL_NAME`, `LEGAL_ADDRESS`, `LEGAL_EMAIL`, `LEGAL_PHONE`, `LEGAL_GSTIN`.
- **Profile → Delete my account** (required by both stores):
  - Staff: the login is removed at once and name, phone, email and photo are erased. Their work records stay with the company as "Deleted user".
  - A company's Super Admin: deletes the whole company. Logins stop at once, and you (owner) delete it for good from **Companies**.
  - Your owner account can't be deleted by mistake.
- **Rago CRM app 4.0**, two versions from the same code and key:
  - **Play Store version** `com.ragoinfotech.crm` (AAB file): no call-log permission, newest Android target (15), screen fits the new edge-to-edge Android.
  - **Website version** `com.ragoinfotech.calls` (APK, inside this zip at `public/app/rago-calls.apk`): everything including Call leads.
- **Fast start with many companies:** the server opens straight away and updates other companies' tables in the background, only when the table design changed (and also on a company's first request after an update).
