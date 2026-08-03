# Matcha

Dating web application for the 42 Matcha subject.

## Stack

- Node.js / Express
- SQLite with handwritten SQL queries
- EJS server-rendered UI
- Socket.IO realtime chat and notifications
- SMTP client built on the standard library (`src/mailer.js`)

Requires Node.js 20 or newer.

## Setup

```bash
cp .env.example .env
# put a real value in SESSION_SECRET, e.g. openssl rand -hex 32
npm install
npm run seed
npm start
```

Open `http://localhost:3000`.

Seed users use password `Password123!`. Example usernames: `alice`, `bruno`, `carla`, `diego`.

## Email

Account verification and password reset links are **never** shown in the browser. They are only delivered by email.

- `MAIL_MODE=console` (default): the message is printed in the server console. Handy for
  local development.
- `MAIL_MODE=smtp`: the message is sent through `SMTP_HOST`/`SMTP_PORT` using STARTTLS
  (or implicit TLS on port 465) and `AUTH LOGIN` when `SMTP_USER` is set.

## Fame rating

`fame = 8 * distinct people who liked you + 2 * distinct people who visited your profile
- 12 * distinct reports`, clamped to 0-100. It is recomputed on every like, unlike, visit,
report and block, and the seed derives its values from the same formula.
