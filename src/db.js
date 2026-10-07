const fs = require('fs');
const path = require('path');

// Relative paths in DATABASE_PATH are taken from the project root, so the app
// finds the same database whatever folder it is started from.
const root = path.join(__dirname, '..');
const dbPath = path.resolve(root, process.env.DATABASE_PATH || path.join('data', 'matcha.sqlite'));
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

// Great-circle distance in km, so ordering by proximity happens in SQL and the
// "nearest 100" window is picked before any LIMIT is applied.
function distanceKm(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some((n) => n === null || n === undefined)) return null;
  const toRad = (n) => (Number(n) * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(toRad(lat1)) * Math.cos(toRad(lat2));
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Neither engine needs anything compiled on install. Node 22.13+ has SQLite
// built in (node:sqlite) and it is used when present; older Node falls back to
// sql.js, SQLite compiled to WebAssembly, which keeps the database in memory
// and writes the whole file back after every change.
function openBuiltin() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (err) {
    return null;
  }
  const db = new DatabaseSync(dbPath);
  // A rollback journal rather than WAL, so the file stays readable by sql.js.
  db.exec('PRAGMA journal_mode = DELETE');
  db.exec('PRAGMA foreign_keys = ON');
  db.function('distance_km', { deterministic: true }, distanceKm);

  // Params are either an array of positional values or an object of named ones.
  const bind = (params) => (Array.isArray(params) ? params : [params]);
  return {
    exec: (sql) => db.exec(sql),
    all: (sql, params) => db.prepare(sql).all(...bind(params)),
    get: (sql, params) => db.prepare(sql).get(...bind(params)),
    run: (sql, params) => db.prepare(sql).run(...bind(params)),
    save() {}
  };
}

async function openWasm() {
  const SQL = await require('sql.js')();
  const db = new SQL.Database(fs.existsSync(dbPath) ? fs.readFileSync(dbPath) : undefined);
  // export() closes and reopens the database, dropping functions and pragmas,
  // so this runs again after every save.
  const setup = () => {
    db.run('PRAGMA foreign_keys = ON');
    db.create_function('distance_km', distanceKm);
  };
  setup();

  // sql.js wants named params with their prefix, while the app passes bare names.
  const bind = (params) => {
    if (Array.isArray(params)) return params;
    const named = {};
    for (const key of Object.keys(params)) {
      named[`@${key}`] = params[key];
      named[`:${key}`] = params[key];
      named[`$${key}`] = params[key];
    }
    return named;
  };
  const query = (sql, params) => {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(bind(params));
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  };
  return {
    exec: (sql) => db.exec(sql),
    all: query,
    get: (sql, params) => query(sql, params)[0],
    run(sql, params) {
      query(sql, params);
      return { changes: db.getRowsModified(), lastInsertRowid: query('SELECT last_insert_rowid() AS id', [])[0].id };
    },
    save() {
      const data = db.export();
      setup();
      // Written aside then renamed, so a crash never leaves half a database.
      fs.writeFileSync(`${dbPath}.tmp`, Buffer.from(data));
      fs.renameSync(`${dbPath}.tmp`, dbPath);
    }
  };
}

let engine = null;
let inTransaction = false;

// Resolves once the database is open; nothing may query it before then.
const ready = Promise.resolve(openBuiltin() || openWasm()).then((opened) => {
  engine = opened;
});

const persist = () => {
  if (!inTransaction) engine.save();
};

function exec(sql) {
  engine.exec(sql);
  persist();
}

function migrate() {
  exec(`
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

    CREATE TABLE IF NOT EXISTS unlikes (
      unliker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      unliked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      PRIMARY KEY (unliker_id, unliked_id)
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
      link TEXT,
      read_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_visits_visited ON visits (visited_id);
    CREATE INDEX IF NOT EXISTS idx_likes_liked ON likes (liked_id);
    CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages (sender_id, receiver_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, read_at);
  `);

  const hasLink = all("PRAGMA table_info(notifications)").some((c) => c.name === 'link');
  if (!hasLink) exec('ALTER TABLE notifications ADD COLUMN link TEXT');
  const hasBreed = all('PRAGMA table_info(users)').some((c) => c.name === 'breed');
  if (!hasBreed) exec('ALTER TABLE users ADD COLUMN breed TEXT');
}

function all(sql, params = {}) {
  return engine.all(sql, params);
}

function get(sql, params = {}) {
  return engine.get(sql, params);
}

function run(sql, params = {}) {
  const info = engine.run(sql, params);
  persist();
  return info;
}

function transaction(fn) {
  engine.exec('BEGIN');
  inTransaction = true;
  try {
    const result = fn();
    engine.exec('COMMIT');
    return result;
  } catch (err) {
    engine.exec('ROLLBACK');
    throw err;
  } finally {
    inTransaction = false;
    engine.save();
  }
}

module.exports = { ready, migrate, all, get, run, transaction };
