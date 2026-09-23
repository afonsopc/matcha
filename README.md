# Matcha

A dating app for horses, built for the 42 **Matcha** subject.

Horses sign up (their humans type), build a profile with photos, breed, bio and
interests, browse suggestions nearby, like each other, and chat in real time
once the like goes both ways.

## Stack

- Node.js / Express, EJS server-rendered views
- SQLite with handwritten SQL (`better-sqlite3`)
- Socket.IO for live chat and notifications
- SMTP client written on the standard library (`src/mailer.js`)
- Self-hosted fonts and photos, the app loads nothing from third parties

Requires Node.js 20 or newer.

## Setup

```bash
cp .env.example .env      # then fill SESSION_SECRET and the SMTP settings
npm install
npm run seed              # 500 horses with real photos
npm start
```

Open `http://localhost:3000`.

Seeded horses all use the password `Password123!`. Ready-made accounts:
`trovao`, `estrela`, `canela`, `faisca`. Trovão and Estrela already matched
and have a conversation going.

## Email

Verification and password reset links are **only** sent by email, never shown
in the browser.

- `MAIL_MODE=smtp`: sent through `SMTP_HOST`/`SMTP_PORT`, with STARTTLS (587)
  or implicit TLS (465), and AUTH PLAIN or LOGIN when `SMTP_USER` is set.
- `MAIL_MODE=console`: the email is printed in the server console instead.
  Handy offline.

With Gmail: enable 2-step verification on the account, create an app password
at https://myaccount.google.com/apppasswords, and put it in `SMTP_PASS` with
`SMTP_USER` set to the Gmail address.

No account anywhere? Use [Ethereal](https://ethereal.email), a public test
SMTP service: create a free throwaway account there (or with
`curl -X POST https://api.nodemailer.com/user -H 'Content-Type: application/json' -d '{"requestor":"matcha","version":"1"}'`),
set `SMTP_HOST=smtp.ethereal.email`, `SMTP_PORT=587` and its user/password.
Emails are not delivered to real inboxes; they are captured, and the server
prints a direct link to each one (`View it: https://ethereal.email/message/...`).
You can also log in at https://ethereal.email/messages with the same user and
password to see them all.

Check the settings without signing up anyone:

```bash
npm run mail:test -- you@example.com
```

Emails link to `APP_URL`, so set it to an address the reader can open (for an
evaluation on another machine, use this machine's IP, not `localhost`).

## Horses, in the UI


The database keeps the generic values the subject asks for; the interface
translates them: `man` is shown as **Stallion**, `woman` as **Mare**, and the
preferences as Stallions / Mares / Everyone. Profiles also have an optional
**breed**.

## Location

"Use my location" asks the browser for GPS coordinates (only with the consent
box ticked) and the server turns them into a town and neighbourhood through
OpenStreetMap's Nominatim. Without GPS, the typed town is looked up the other
way to get its approximate centre, so distances and "closest first" work for
everyone. Nominatim is free and keyless; calls are cached and spaced one second
apart as its usage policy asks.

## Fame rating

`fame = 8 * distinct horses who liked you + 2 * distinct horses who visited
your profile - 12 * distinct reports`, clamped to 0-100. It is recomputed on
every like, unlike, visit, report and block, and the seed derives its values
from the same formula.

## Photos

All horse photos come from Wikimedia Commons under their respective licenses
(CC BY, CC BY-SA, public domain). Authors and links are listed in
`public/img/credits.json`.
