require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const bcrypt = require('bcryptjs');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const { Server } = require('socket.io');
const validator = require('validator');
const { migrate, all, get, run, transaction } = require('./db');

migrate();

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = Number(process.env.PORT || 3000);
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const uploadDir = path.join(process.cwd(), 'public', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'local-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 7 }
});

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => cb(null, `${req.session.userId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${path.extname(file.originalname).toLowerCase()}`)
  }),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) return cb(new Error('Only jpeg, png and webp images are allowed.'));
    cb(null, true);
  }
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(rateLimit({ windowMs: 60 * 1000, max: 180 }));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(sessionMiddleware);
app.use('/static', express.static(path.join(process.cwd(), 'public')));

io.engine.use(sessionMiddleware);

const socketsByUser = new Map();
const weakPasswords = new Set(['password', 'password123', 'qwerty', 'azerty', 'letmein', 'admin', 'welcome', 'bonjour', 'dragon', 'football', 'iloveyou', 'matcha']);

function ageFromBirthdate(birthdate) {
  if (!birthdate) return null;
  const born = new Date(birthdate);
  if (Number.isNaN(born.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - born.getFullYear();
  const monthDelta = now.getMonth() - born.getMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getDate() < born.getDate())) age -= 1;
  return age;
}

function sanitizeText(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}

function normalizeTag(value) {
  const tag = String(value || '').trim().toLowerCase().replace(/^#/, '');
  return /^[a-z0-9_-]{2,24}$/.test(tag) ? tag : null;
}

function passwordOk(password) {
  const lower = String(password || '').toLowerCase();
  return password && password.length >= 10 && /[a-z]/i.test(password) && /\d/.test(password) && /[^a-z0-9]/i.test(password) && !weakPasswords.has(lower);
}

function sendMail(to, subject, body) {
  console.log(`\n--- Matcha email (${to}) ---\n${subject}\n${body}\n---------------------------\n`);
}

function currentUser(req) {
  if (!req.session.userId) return null;
  return get('SELECT * FROM users WHERE id = ?', [req.session.userId]);
}

function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.redirect('/login');
  req.user = user;
  res.locals.user = user;
  next();
}

function notify(userId, actorId, type, body) {
  const info = run('INSERT INTO notifications (user_id, actor_id, type, body) VALUES (?, ?, ?, ?)', [userId, actorId || null, type, body]);
  const notification = get(`SELECT n.*, u.username AS actor_username FROM notifications n LEFT JOIN users u ON u.id = n.actor_id WHERE n.id = ?`, [info.lastInsertRowid]);
  io.to(`user:${userId}`).emit('notification', notification);
}

function connected(a, b) {
  const row = get(`SELECT 1 FROM likes l1 JOIN likes l2 ON l2.liker_id = l1.liked_id AND l2.liked_id = l1.liker_id WHERE l1.liker_id = ? AND l1.liked_id = ?`, [a, b]);
  return Boolean(row);
}

function hasProfilePhoto(userId) {
  return Boolean(get('SELECT 1 FROM photos WHERE user_id = ? AND is_profile = 1', [userId]));
}

function recalcFame(userId) {
  const likes = get('SELECT COUNT(*) AS c FROM likes WHERE liked_id = ?', [userId]).c;
  const visits = get('SELECT COUNT(*) AS c FROM visits WHERE visited_id = ?', [userId]).c;
  const reports = get('SELECT COUNT(*) AS c FROM reports WHERE reported_id = ?', [userId]).c;
  const fame = Math.max(0, Math.min(100, likes * 8 + visits * 2 - reports * 12));
  run('UPDATE users SET fame = ? WHERE id = ?', [fame, userId]);
}

function decorateProfiles(rows, viewer) {
  return rows.map((row) => ({ ...row, age: ageFromBirthdate(row.birthdate), distance: distanceKm(viewer, row) }));
}

function distanceKm(a, b) {
  if (a.latitude == null || a.longitude == null || b.latitude == null || b.longitude == null) return null;
  const toRad = (n) => n * Math.PI / 180;
  const R = 6371;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const x = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return Math.round(R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)));
}

function profileQuery(user, filters = {}) {
  const params = { me: user.id };
  const where = [
    'u.id != @me',
    'u.verified = 1',
    `NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = @me AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = @me))`
  ];

  const pref = user.preference || 'bisexual';
  if (pref !== 'bisexual') {
    where.push('u.gender = @wantedGender');
    params.wantedGender = pref === 'women' ? 'woman' : 'man';
  }
  if (user.gender) {
    where.push(`(u.preference = 'bisexual' OR u.preference = @viewerPreference)`);
    params.viewerPreference = user.gender === 'woman' ? 'women' : 'men';
  }
  if (filters.minAge) {
    where.push(`date(u.birthdate) <= date('now', @minAgeExpr)`);
    params.minAgeExpr = `-${Number(filters.minAge)} years`;
  }
  if (filters.maxAge) {
    where.push(`date(u.birthdate) >= date('now', @maxAgeExpr)`);
    params.maxAgeExpr = `-${Number(filters.maxAge) + 1} years`;
  }
  if (filters.minFame) {
    where.push('u.fame >= @minFame');
    params.minFame = Number(filters.minFame);
  }
  if (filters.maxFame) {
    where.push('u.fame <= @maxFame');
    params.maxFame = Number(filters.maxFame);
  }
  if (filters.location) {
    where.push('(lower(u.city) LIKE @location OR lower(u.neighborhood) LIKE @location)');
    params.location = `%${String(filters.location).toLowerCase()}%`;
  }
  if (filters.tag) {
    const tag = normalizeTag(filters.tag);
    if (tag) {
      where.push(`EXISTS (SELECT 1 FROM user_tags ut JOIN tags t ON t.id = ut.tag_id WHERE ut.user_id = u.id AND t.name = @tag)`);
      params.tag = tag;
    }
  }

  const sortMap = {
    age: 'u.birthdate DESC',
    location: 'same_city DESC, u.city ASC',
    fame: 'u.fame DESC',
    tags: 'common_tags DESC'
  };
  const sort = sortMap[filters.sort] || 'same_city DESC, common_tags DESC, u.fame DESC';

  const rows = all(`
    SELECT u.*, p.filename AS profile_photo,
      CASE WHEN lower(coalesce(u.city,'')) = lower(coalesce((SELECT city FROM users WHERE id = @me),'')) THEN 1 ELSE 0 END AS same_city,
      (SELECT COUNT(*) FROM user_tags mine JOIN user_tags theirs ON theirs.tag_id = mine.tag_id WHERE mine.user_id = @me AND theirs.user_id = u.id) AS common_tags
    FROM users u
    LEFT JOIN photos p ON p.user_id = u.id AND p.is_profile = 1
    WHERE ${where.join(' AND ')}
    ORDER BY ${sort}
    LIMIT 100
  `, params);
  return decorateProfiles(rows, user);
}

app.use((req, res, next) => {
  res.locals.user = currentUser(req);
  res.locals.unreadCount = req.session.userId ? get('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL', [req.session.userId]).c : 0;
  res.locals.error = null;
  res.locals.notice = null;
  next();
});

app.get('/', (req, res) => {
  if (req.session.userId) return res.redirect('/browse');
  res.render('index');
});

app.get('/register', (req, res) => res.render('register'));
app.post('/register', (req, res) => {
  const email = sanitizeText(req.body.email, 120).toLowerCase();
  const username = sanitizeText(req.body.username, 32);
  const firstName = sanitizeText(req.body.first_name, 60);
  const lastName = sanitizeText(req.body.last_name, 60);
  const password = String(req.body.password || '');
  if (!validator.isEmail(email) || !/^[a-zA-Z0-9_]{3,32}$/.test(username) || !firstName || !lastName || !passwordOk(password)) {
    return res.status(400).render('register', { error: 'Invalid registration data or weak password.' });
  }
  try {
    const token = crypto.randomBytes(24).toString('hex');
    const hash = bcrypt.hashSync(password, 12);
    run('INSERT INTO users (email, username, first_name, last_name, password_hash, verify_token) VALUES (?, ?, ?, ?, ?, ?)', [email, username, firstName, lastName, hash, token]);
    sendMail(email, 'Verify your Matcha account', `${APP_URL}/verify/${token}`);
    res.render('login', { notice: 'Account created. Check the server console for the verification email.' });
  } catch (err) {
    res.status(409).render('register', { error: 'Email or username already exists.' });
  }
});

app.get('/verify/:token', (req, res) => {
  const user = get('SELECT id FROM users WHERE verify_token = ?', [req.params.token]);
  if (!user) return res.status(404).render('login', { error: 'Invalid verification link.' });
  run('UPDATE users SET verified = 1, verify_token = NULL WHERE id = ?', [user.id]);
  res.render('login', { notice: 'Account verified. You can sign in.' });
});

app.get('/login', (req, res) => res.render('login'));
app.post('/login', (req, res) => {
  const username = sanitizeText(req.body.username, 32);
  const user = get('SELECT * FROM users WHERE username = ?', [username]);
  if (!user || !bcrypt.compareSync(String(req.body.password || ''), user.password_hash)) {
    return res.status(401).render('login', { error: 'Invalid username or password.' });
  }
  if (!user.verified) return res.status(403).render('login', { error: 'Verify your account before signing in.' });
  req.session.userId = user.id;
  run('UPDATE users SET online = 1, last_seen = strftime(\'%s\',\'now\') WHERE id = ?', [user.id]);
  res.redirect('/browse');
});

app.post('/logout', requireAuth, (req, res) => {
  run('UPDATE users SET online = 0, last_seen = strftime(\'%s\',\'now\') WHERE id = ?', [req.user.id]);
  req.session.destroy(() => res.redirect('/'));
});

app.get('/forgot', (req, res) => res.render('forgot'));
app.post('/forgot', (req, res) => {
  const email = sanitizeText(req.body.email, 120).toLowerCase();
  const user = get('SELECT * FROM users WHERE email = ?', [email]);
  if (user) {
    const token = crypto.randomBytes(24).toString('hex');
    run('UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?', [token, Math.floor(Date.now() / 1000) + 3600, user.id]);
    sendMail(email, 'Reset your Matcha password', `${APP_URL}/reset/${token}`);
  }
  res.render('forgot', { notice: 'If that email exists, a reset link was sent.' });
});

app.get('/reset/:token', (req, res) => res.render('reset', { token: req.params.token }));
app.post('/reset/:token', (req, res) => {
  if (!passwordOk(req.body.password)) return res.status(400).render('reset', { token: req.params.token, error: 'Choose a stronger password.' });
  const user = get('SELECT * FROM users WHERE reset_token = ? AND reset_expires > ?', [req.params.token, Math.floor(Date.now() / 1000)]);
  if (!user) return res.status(404).render('forgot', { error: 'Invalid or expired reset link.' });
  run('UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires = NULL WHERE id = ?', [bcrypt.hashSync(req.body.password, 12), user.id]);
  res.render('login', { notice: 'Password updated.' });
});

app.get('/profile', requireAuth, (req, res) => {
  const tags = all('SELECT t.name FROM tags t JOIN user_tags ut ON ut.tag_id = t.id WHERE ut.user_id = ? ORDER BY t.name', [req.user.id]);
  const photos = all('SELECT * FROM photos WHERE user_id = ? ORDER BY is_profile DESC, created_at DESC', [req.user.id]);
  const visits = all(`SELECT u.username, u.first_name, u.last_name, v.created_at FROM visits v JOIN users u ON u.id = v.visitor_id WHERE v.visited_id = ? ORDER BY v.created_at DESC LIMIT 20`, [req.user.id]);
  const likes = all(`SELECT u.username, u.first_name, u.last_name, l.created_at FROM likes l JOIN users u ON u.id = l.liker_id WHERE l.liked_id = ? ORDER BY l.created_at DESC LIMIT 20`, [req.user.id]);
  res.render('profile', { profile: req.user, tags, photos, visits, likes, age: ageFromBirthdate(req.user.birthdate) });
});

app.post('/profile', requireAuth, upload.array('photos', 5), (req, res) => {
  try {
    const firstName = sanitizeText(req.body.first_name, 60);
    const lastName = sanitizeText(req.body.last_name, 60);
    const email = sanitizeText(req.body.email, 120).toLowerCase();
    const bio = sanitizeText(req.body.bio, 900);
    const gender = ['man', 'woman', 'other'].includes(req.body.gender) ? req.body.gender : null;
    const preference = ['men', 'women', 'bisexual'].includes(req.body.preference) ? req.body.preference : 'bisexual';
    if (!firstName || !lastName || !validator.isEmail(email)) throw new Error('Invalid profile data.');
    transaction(() => {
      run(`UPDATE users SET first_name=?, last_name=?, email=?, gender=?, preference=?, birthdate=?, bio=?, city=?, neighborhood=?, latitude=?, longitude=?, location_consent=? WHERE id=?`, [
        firstName, lastName, email, gender, preference, req.body.birthdate || null, bio,
        sanitizeText(req.body.city, 80), sanitizeText(req.body.neighborhood, 80),
        req.body.latitude ? Number(req.body.latitude) : null,
        req.body.longitude ? Number(req.body.longitude) : null,
        req.body.location_consent ? 1 : 0,
        req.user.id
      ]);
      run('DELETE FROM user_tags WHERE user_id = ?', [req.user.id]);
      String(req.body.tags || '').split(/[,\s]+/).map(normalizeTag).filter(Boolean).slice(0, 15).forEach((name) => {
        run('INSERT OR IGNORE INTO tags (name) VALUES (?)', [name]);
        const tag = get('SELECT id FROM tags WHERE name = ?', [name]);
        run('INSERT OR IGNORE INTO user_tags (user_id, tag_id) VALUES (?, ?)', [req.user.id, tag.id]);
      });
      const count = get('SELECT COUNT(*) AS c FROM photos WHERE user_id = ?', [req.user.id]).c;
      for (const file of req.files || []) {
        if (count >= 5) break;
        const hasProfile = hasProfilePhoto(req.user.id);
        run('INSERT INTO photos (user_id, filename, is_profile) VALUES (?, ?, ?)', [req.user.id, file.filename, hasProfile ? 0 : 1]);
      }
    });
    res.redirect('/profile');
  } catch (err) {
    res.status(400).render('profile', { profile: req.user, tags: [], photos: [], visits: [], likes: [], age: ageFromBirthdate(req.user.birthdate), error: err.message });
  }
});

app.post('/photos/:id/profile', requireAuth, (req, res) => {
  const photo = get('SELECT * FROM photos WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (photo) {
    run('UPDATE photos SET is_profile = 0 WHERE user_id = ?', [req.user.id]);
    run('UPDATE photos SET is_profile = 1 WHERE id = ?', [photo.id]);
  }
  res.redirect('/profile');
});

app.post('/photos/:id/delete', requireAuth, (req, res) => {
  const photo = get('SELECT * FROM photos WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (photo) {
    run('DELETE FROM photos WHERE id = ?', [photo.id]);
    fs.rm(path.join(uploadDir, photo.filename), { force: true }, () => {});
  }
  res.redirect('/profile');
});

app.get('/browse', requireAuth, (req, res) => {
  res.render('browse', { profiles: profileQuery(req.user, req.query), query: req.query, title: 'Suggested profiles' });
});

app.get('/search', requireAuth, (req, res) => {
  res.render('browse', { profiles: profileQuery(req.user, req.query), query: req.query, title: 'Search' });
});

app.get('/users/:username', requireAuth, (req, res) => {
  const profile = get(`SELECT u.*, p.filename AS profile_photo FROM users u LEFT JOIN photos p ON p.user_id = u.id AND p.is_profile = 1 WHERE u.username = ?`, [req.params.username]);
  if (!profile || profile.id === req.user.id) return res.status(404).render('error', { message: 'Profile not found.' });
  const blocked = get('SELECT 1 FROM blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)', [req.user.id, profile.id, profile.id, req.user.id]);
  if (blocked) return res.status(404).render('error', { message: 'Profile not found.' });
  run('INSERT INTO visits (visitor_id, visited_id) VALUES (?, ?)', [req.user.id, profile.id]);
  recalcFame(profile.id);
  notify(profile.id, req.user.id, 'visit', `${req.user.username} viewed your profile.`);
  const tags = all('SELECT t.name FROM tags t JOIN user_tags ut ON ut.tag_id = t.id WHERE ut.user_id = ?', [profile.id]);
  const photos = all('SELECT * FROM photos WHERE user_id = ? ORDER BY is_profile DESC, created_at DESC', [profile.id]);
  const liked = Boolean(get('SELECT 1 FROM likes WHERE liker_id = ? AND liked_id = ?', [req.user.id, profile.id]));
  const likedMe = Boolean(get('SELECT 1 FROM likes WHERE liker_id = ? AND liked_id = ?', [profile.id, req.user.id]));
  res.render('user', { profile, tags, photos, liked, likedMe, isConnected: liked && likedMe, age: ageFromBirthdate(profile.birthdate), distance: distanceKm(req.user, profile) });
});

app.post('/users/:id/like', requireAuth, (req, res) => {
  const target = get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!target || !hasProfilePhoto(req.user.id)) return res.status(400).redirect('/browse');
  run('INSERT OR IGNORE INTO likes (liker_id, liked_id) VALUES (?, ?)', [req.user.id, target.id]);
  recalcFame(target.id);
  notify(target.id, req.user.id, 'like', `${req.user.username} liked your profile.`);
  if (connected(req.user.id, target.id)) notify(target.id, req.user.id, 'match', `${req.user.username} liked you back. You are connected.`);
  res.redirect(`/users/${target.username}`);
});

app.post('/users/:id/unlike', requireAuth, (req, res) => {
  const target = get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (target) {
    const wasConnected = connected(req.user.id, target.id);
    run('DELETE FROM likes WHERE liker_id = ? AND liked_id = ?', [req.user.id, target.id]);
    recalcFame(target.id);
    if (wasConnected) notify(target.id, req.user.id, 'unlike', `${req.user.username} disconnected from you.`);
  }
  res.redirect(target ? `/users/${target.username}` : '/browse');
});

app.post('/users/:id/block', requireAuth, (req, res) => {
  run('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)', [req.user.id, req.params.id]);
  res.redirect('/browse');
});

app.post('/users/:id/report', requireAuth, (req, res) => {
  run('INSERT OR IGNORE INTO reports (reporter_id, reported_id, reason) VALUES (?, ?, ?)', [req.user.id, req.params.id, 'fake account']);
  recalcFame(req.params.id);
  res.redirect('/browse');
});

app.get('/chat', requireAuth, (req, res) => {
  const people = all(`
    SELECT u.*, p.filename AS profile_photo FROM users u
    LEFT JOIN photos p ON p.user_id = u.id AND p.is_profile = 1
    WHERE EXISTS (SELECT 1 FROM likes a JOIN likes b ON b.liker_id = a.liked_id AND b.liked_id = a.liker_id WHERE a.liker_id = ? AND a.liked_id = u.id)
    AND NOT EXISTS (SELECT 1 FROM blocks bl WHERE (bl.blocker_id = ? AND bl.blocked_id = u.id) OR (bl.blocker_id = u.id AND bl.blocked_id = ?))
    ORDER BY u.username
  `, [req.user.id, req.user.id, req.user.id]);
  const activeId = Number(req.query.with || (people[0] && people[0].id));
  const active = people.find((p) => p.id === activeId);
  const messages = active ? all(`SELECT * FROM messages WHERE (sender_id=? AND receiver_id=?) OR (sender_id=? AND receiver_id=?) ORDER BY created_at ASC LIMIT 200`, [req.user.id, active.id, active.id, req.user.id]) : [];
  if (active) run('UPDATE messages SET read_at = strftime(\'%s\',\'now\') WHERE sender_id = ? AND receiver_id = ? AND read_at IS NULL', [active.id, req.user.id]);
  res.render('chat', { people, active, messages });
});

app.post('/chat/:id', requireAuth, (req, res) => {
  const receiver = get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  const body = sanitizeText(req.body.body, 1000);
  if (!receiver || !body || !connected(req.user.id, receiver.id)) return res.status(400).redirect('/chat');
  const info = run('INSERT INTO messages (sender_id, receiver_id, body) VALUES (?, ?, ?)', [req.user.id, receiver.id, body]);
  const message = get('SELECT * FROM messages WHERE id = ?', [info.lastInsertRowid]);
  io.to(`user:${receiver.id}`).emit('message', { ...message, sender_username: req.user.username });
  notify(receiver.id, req.user.id, 'message', `${req.user.username} sent you a message.`);
  res.redirect(`/chat?with=${receiver.id}`);
});

app.get('/notifications', requireAuth, (req, res) => {
  const notifications = all(`SELECT n.*, u.username AS actor_username FROM notifications n LEFT JOIN users u ON u.id = n.actor_id WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT 100`, [req.user.id]);
  run('UPDATE notifications SET read_at = strftime(\'%s\',\'now\') WHERE user_id = ? AND read_at IS NULL', [req.user.id]);
  res.render('notifications', { notifications });
});

io.on('connection', (socket) => {
  const userId = socket.request.session.userId;
  if (!userId) return socket.disconnect();
  socket.join(`user:${userId}`);
  socketsByUser.set(socket.id, userId);
  run('UPDATE users SET online = 1, last_seen = strftime(\'%s\',\'now\') WHERE id = ?', [userId]);
  socket.on('disconnect', () => {
    socketsByUser.delete(socket.id);
    if (![...socketsByUser.values()].includes(userId)) run('UPDATE users SET online = 0, last_seen = strftime(\'%s\',\'now\') WHERE id = ?', [userId]);
  });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(400).render('error', { message: err.message || 'Request failed.' });
});

app.use((req, res) => res.status(404).render('error', { message: 'Page not found.' }));

server.listen(PORT, () => {
  console.log(`Matcha running at ${APP_URL}`);
});
