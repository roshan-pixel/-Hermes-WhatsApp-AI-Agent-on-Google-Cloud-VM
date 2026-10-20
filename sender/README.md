# Hermes Baileys sender

`whatsapp-web.js` (the main bot) cannot start a chat with a number the account has never messaged on the current WhatsApp Web build
(the send crashes while WhatsApp Web works out the sender of the new message). This small program links to the **same WhatsApp account as one more device**
using Baileys, which talks to WhatsApp directly, and is used only for broadcasts.

* Link it once with a pairing code: `pm2 start sender.mjs --name baileys-sender`, read the code from `sender.log`
  (WhatsApp -> Linked devices -> Link with phone number) and enter it on the phone.
* Local control API on `127.0.0.1:3100` (`/status`, `/send?to=`, `/broadcast`, `/cancel`, `/report-owner`).
* The main bot hands a confirmed `/broadcast` to it; it checks every number is on WhatsApp, pauses 20-45 s between members,
  stops after 3 failures in a row and sends the completion report to the owner.
* `sender/auth/` holds the login session and is git-ignored. Never commit it.
