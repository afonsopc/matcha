const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'matcha.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL UNIQUE,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0,
      verify_token TEXT,
      reset_token TEXT,
      reset_expires INTEGER,
      gender TEXT,
      preference TEXT DEFAULT 'bisexual',
      birthdate TEXT,
      bio TEXT DEFAULT '',
      city TEXT,
      neighborhood TEXT,
      latitude REAL,
      longitude REAL,
      location_consent INTEGER NOT NULL DEFAULT 0,
      fame INTEGER NOT NULL DEFAULT 0,
      online INTEGER NOT NULL DEFAULT 0,
      last_seen INTEGER,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS user_tags (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, tag_id)
    );

    CREATE TABLE IF NOT EXISTS photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      is_profile INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS likes (
      liker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      liked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      PRIMARY KEY (liker_id, liked_id)
    );

    CREATE TABLE IF NOT EXISTS visits (
      visitor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      visited_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS blocks (
      blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      PRIMARY KEY (blocker_id, blocked_id)
    );

    CREATE TABLE IF NOT EXISTS reports (
      reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reported_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reason TEXT NOT NULL DEFAULT 'fake account',
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      PRIMARY KEY (reporter_id, reported_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      read_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      type TEXT NOT NULL,
      body TEXT NOT NULL,
      read_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
  `);
}

function all(sql, params = {}) {
  return db.prepare(sql).all(params);
}

function get(sql, params = {}) {
  return db.prepare(sql).get(params);
}

function run(sql, params = {}) {
  return db.prepare(sql).run(params);
}

function transaction(fn) {
  return db.transaction(fn)();
}

module.exports = { db, migrate, all, get, run, transaction };
