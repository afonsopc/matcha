# Matcha

Dating web application for the 42 Matcha subject.

## Stack

- Node.js / Express
- SQLite with handwritten SQL queries
- EJS server-rendered UI
- Socket.IO realtime chat and notifications

## Setup

```bash
cp .env.example .env
npm install
npm run seed
npm start
```

Open `http://localhost:3000`.

Seed users use password `Password123!`. Example usernames: `alice`, `bruno`, `carla`, `diego`.

Verification and reset emails are printed in the server console when `MAIL_MODE=console`.
