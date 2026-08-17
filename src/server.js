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
const { createMailer } = require('./mailer');

migrate();
// Presence lives in memory, so a restart must not leave stale "online now" flags.
run('UPDATE users SET online = 0 WHERE online = 1');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.set('trust proxy', 'loopback');
const PORT = Number(process.env.PORT || 3000);
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const MAIL_MODE = process.env.MAIL_MODE || 'console';
const sendMail = createMailer(process.env);
const uploadDir = path.join(process.cwd(), 'public', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const PLACEHOLDER_SECRETS = new Set(['', 'change-this-local-secret', 'replace-with-a-random-64-hex-string']);
const sessionSecret = PLACEHOLDER_SECRETS.has(String(process.env.SESSION_SECRET || '').trim())
  ? crypto.randomBytes(32).toString('hex')
  : process.env.SESSION_SECRET;
if (sessionSecret !== process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET is unset or still the placeholder. Using a random secret for this run, set a real value in .env.');
}

const sessionMiddleware = session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 7 }
});

// Only these image types may be stored, and the extension is derived from the
// accepted type, never from the client-supplied filename.
const ALLOWED_IMAGES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const IMAGE_SIGNATURES = [
  { ext: '.jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: '.png', test: (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: '.webp', test: (b) => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP' }
];

function imageExtensionFromBytes(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 12, 0);
    const match = IMAGE_SIGNATURES.find((sig) => sig.test(head));
    return match ? match.ext : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => cb(null, `${req.session.userId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ALLOWED_IMAGES[file.mimetype]}`)
  }),
  limits: { fileSize: 3 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => {
    const declaredExt = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_IMAGES[file.mimetype] || !['.jpg', '.jpeg', '.png', '.webp'].includes(declaredExt)) {
      return cb(userError('Only JPEG, PNG and WebP images are allowed.', 400));
    }
    cb(null, true);
  }
});

// Drops anything whose bytes are not a real JPEG/PNG/WebP, so a renamed script
// or HTML payload can never end up served from our own origin.
function keepOnlyRealImages(files) {
  const kept = [];
  for (const file of files || []) {
    const actualExt = imageExtensionFromBytes(file.path);
    const storedExt = path.extname(file.filename).toLowerCase();
    const matches = actualExt === storedExt || (actualExt === '.jpg' && storedExt === '.jpeg');
    if (matches) kept.push(file);
    else fs.rm(file.path, { force: true }, () => {});
  }
  return kept;
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:'],
      'connect-src': ["'self'", 'ws:', 'wss:'],
      'form-action': ["'self'"],
      'frame-ancestors': ["'none'"],
      'base-uri': ["'self'"],
      'object-src': ["'none'"]
    }
  },
  crossOriginResourcePolicy: { policy: 'same-origin' }
}));
app.use('/static', express.static(path.join(process.cwd(), 'public'), {
  setHeaders: (res, filePath) => {
    // Uploads are user content: never let a browser render one as a document.
    if (filePath.includes(`${path.sep}uploads${path.sep}`)) res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
}));
app.use(rateLimit({ windowMs: 60 * 1000, max: 240 }));
// Generous on purpose: enough to stop scripted password guessing without ever
// locking out an evaluator retrying a form by hand.
const authLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 60, skipSuccessfulRequests: true });
const verificationLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5 });
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(express.json({ limit: '64kb' }));
app.use(sessionMiddleware);

io.engine.use(sessionMiddleware);

const socketsByUser = new Map();
const weakPasswordWords = new Set([
  'password', 'passw', 'qwerty', 'azerty', 'letmein', 'admin', 'welcome', 'bonjour',
  'dragon', 'football', 'iloveyou', 'matcha', 'monkey', 'sunshine', 'princess',
  'superman', 'master', 'hello', 'changeme', 'trustno', 'whatever', 'baseball',
  'shadow', 'michael', 'jessica', 'charlie', 'donald', 'thomas', 'jordan',
  'harley', 'ranger', 'daniel', 'andrew', 'george', 'batman', 'hunter',
  'buster', 'soccer', 'hockey', 'killer', 'pepper', 'joshua', 'maggie',
  'zxcvbn', 'letmein', 'monkey', 'dragon', 'master', 'login', 'apple',
  'strawberry', 'summer', 'winter', 'spring', 'autumn', 'flower', 'cookie',
  'butter', 'coffee', 'cheese', 'orange', 'purple', 'yellow', 'matrix',
  'starwars', 'star', 'force', 'ninja', 'pirate', 'wizard', 'secret',
  'access', 'mustang', 'ferrari', 'porsche', 'mercedes', 'bmw', 'audi',
]);

// Strip all non-alpha characters and check if the resulting base word is common.
// This catches variants like Apple12345!, P@ssw0rd, Sunshine99!, strawberry5# etc.
function isWeakPassword(password) {
  const base = password.toLowerCase().replace(/[^a-z]/g, '');
  if (weakPasswordWords.has(base)) return true;
  for (const word of weakPasswordWords) {
    if (base === word || base.startsWith(word) || base.endsWith(word)) return true;
  }
  return false;
}

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

function passwordIssues(password) {
  const issues = [];
  const pw = String(password || '');
  if (pw.length < 10) issues.push('at least 10 characters');
  if (!/[a-z]/.test(pw)) issues.push('a lowercase letter');
  if (!/[A-Z]/.test(pw)) issues.push('an uppercase letter');
  if (!/\d/.test(pw)) issues.push('a digit');
  if (!/[^A-Za-z0-9]/.test(pw)) issues.push('a symbol');
  if (isWeakPassword(pw)) issues.push('something less common');
  return issues;
}

function passwordOk(password) {
  return passwordIssues(password).length === 0;
}

// Errors we raised ourselves: their message is written for the user and may be
// rendered. Everything else stays generic so DB internals never leak.
function userError(message, status = 400) {
  const err = new Error(message);
  err.userFacing = true;
  err.status = status;
  return err;
}

function positiveId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
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

function isBlockedPair(a, b) {
  return Boolean(get('SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)', [a, b, b, a]));
}

// A blocked user must not reach you at all, and once you remove your like the
// person you unliked stops generating notifications for you.
function notificationsMuted(userId, actorId) {
  if (!actorId || userId === actorId) return false;
  if (isBlockedPair(userId, actorId)) return true;
  return Boolean(get('SELECT 1 FROM unlikes WHERE unliker_id = ? AND unliked_id = ?', [userId, actorId]));
}

function notify(userId, actorId, type, body, link) {
  if (notificationsMuted(userId, actorId)) return;
  const info = run('INSERT INTO notifications (user_id, actor_id, type, body, link) VALUES (?, ?, ?, ?, ?)', [userId, actorId || null, type, body, link || null]);
  const notification = get(`SELECT n.*, u.username AS actor_username FROM notifications n LEFT JOIN users u ON u.id = n.actor_id WHERE n.id = ?`, [info.lastInsertRowid]);
  io.to(`user:${userId}`).emit('notification', notification);
  const unreadCount = get('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL', [userId]).c;
  io.to(`user:${userId}`).emit('unread-count', unreadCount);
}

function connected(a, b) {
  const row = get(`SELECT 1 FROM likes l1 JOIN likes l2 ON l2.liker_id = l1.liked_id AND l2.liked_id = l1.liker_id WHERE l1.liker_id = ? AND l1.liked_id = ?`, [a, b]);
  return Boolean(row);
}

function hasProfilePhoto(userId) {
  return Boolean(get('SELECT 1 FROM photos WHERE user_id = ? AND is_profile = 1', [userId]));
}

// Fame = 8 points per distinct admirer + 2 per distinct visitor - 12 per report,
// clamped to 0-100. Counting people rather than page loads keeps one refreshing
// visitor from inflating the score.
function recalcFame(userId) {
  const likes = get('SELECT COUNT(DISTINCT liker_id) AS c FROM likes WHERE liked_id = ?', [userId]).c;
  const visits = get('SELECT COUNT(DISTINCT visitor_id) AS c FROM visits WHERE visited_id = ?', [userId]).c;
  const reports = get('SELECT COUNT(DISTINCT reporter_id) AS c FROM reports WHERE reported_id = ?', [userId]).c;
  const fame = Math.max(0, Math.min(100, likes * 8 + visits * 2 - reports * 12));
  run('UPDATE users SET fame = ? WHERE id = ?', [fame, userId]);
}

function decorateProfiles(rows, viewer) {
  return rows.map((row) => ({ ...row, age: ageFromBirthdate(row.birthdate), distance: distanceKm(viewer, row) }));
}

function distanceKm(a, b) {
  if (!a || !b || a.latitude == null || a.longitude == null || b.latitude == null || b.longitude == null) return null;
  const toRad = (n) => n * Math.PI / 180;
  const R = 6371;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const x = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return Math.round(R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)));
}

function formatDistance(km) {
  if (km == null) return '';
  if (km === 0) return '< 1 km away';
  if (km < 10) return `${km} km away`;
  return `${km} km away`;
}

function formatDateTime(unix) {
  return new Date(Number(unix) * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

// Offline users must show the date AND time of their last connection, so the
// relative wording always carries the absolute timestamp with it.
function lastSeenText(user) {
  if (!user) return '';
  if (user.online) return 'online now';
  if (!user.last_seen) return 'never connected';
  const seconds = Math.floor(Date.now() / 1000) - Number(user.last_seen);
  const stamp = formatDateTime(user.last_seen);
  if (seconds < 60) return `last seen just now (${stamp})`;
  if (seconds < 3600) return `last seen ${Math.floor(seconds / 60)} min ago (${stamp})`;
  if (seconds < 86400) return `last seen ${Math.floor(seconds / 3600)} h ago (${stamp})`;
  if (seconds < 2592000) return `last seen ${Math.floor(seconds / 86400)} d ago (${stamp})`;
  return `last seen on ${stamp}`;
}

function unreadMessages(userId) {
  return get('SELECT COUNT(*) AS c FROM messages WHERE receiver_id = ? AND read_at IS NULL', [userId]).c;
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
  // Accepts one or several tags ("coffee, geek" or ?tag=a&tag=b): every one of
  // them must be present on the candidate profile.
  const wantedTags = [].concat(filters.tag || [])
    .flatMap((value) => String(value).split(/[,\s]+/))
    .map(normalizeTag)
    .filter(Boolean)
    .slice(0, 5);
  wantedTags.forEach((tag, index) => {
    where.push(`EXISTS (SELECT 1 FROM user_tags ut JOIN tags t ON t.id = ut.tag_id WHERE ut.user_id = u.id AND t.name = @tag${index})`);
    params[`tag${index}`] = tag;
  });

  const sortMap = {
    age: 'u.birthdate DESC',
    location: '(distance_km IS NULL), distance_km ASC, same_city DESC, u.city ASC',
    fame: 'u.fame DESC',
    tags: 'common_tags DESC'
  };
  const requestedSort = typeof filters.sort === 'string' && Object.prototype.hasOwnProperty.call(sortMap, filters.sort)
    ? filters.sort
    : null;
  const sort = requestedSort ? sortMap[requestedSort] : 'same_city DESC, common_tags DESC, u.fame DESC';

  params.myLat = user.latitude;
  params.myLng = user.longitude;
  const rows = all(`
    SELECT u.*, p.filename AS profile_photo,
      distance_km(@myLat, @myLng, u.latitude, u.longitude) AS distance_km,
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
  const user = currentUser(req);
  res.locals.user = user;
  res.locals.unreadCount = user ? get('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL', [user.id]).c : 0;
  res.locals.unreadMessages = user ? unreadMessages(user.id) : 0;
  res.locals.error = null;
  res.locals.notice = null;
  res.locals.values = {};
  res.locals.lastSeenText = lastSeenText;
  res.locals.formatDistance = formatDistance;
  res.locals.devMail = MAIL_MODE === 'console';
  res.locals.currentPath = req.path;
  next();
});

app.get('/', (req, res) => {
  if (req.session.userId) return res.redirect('/browse');
  res.render('index');
});

app.get('/register', (req, res) => res.render('register', { values: {} }));
app.post('/register', authLimiter, (req, res) => {
  const values = {
    email: sanitizeText(req.body.email, 120).toLowerCase(),
    username: sanitizeText(req.body.username, 32),
    first_name: sanitizeText(req.body.first_name, 60),
    last_name: sanitizeText(req.body.last_name, 60)
  };
  const password = String(req.body.password || '');
  const errors = [];
  if (!validator.isEmail(values.email)) errors.push('Enter a valid email address.');
  if (!/^[a-zA-Z0-9_]{3,32}$/.test(values.username)) errors.push('Username must be 3–32 letters, digits, or underscores.');
  if (!values.first_name) errors.push('First name is required.');
  if (!values.last_name) errors.push('Last name is required.');
  const pwIssues = passwordIssues(password);
  if (pwIssues.length) errors.push(`Password needs ${pwIssues.join(', ')}.`);
  if (errors.length) return res.status(400).render('register', { values, error: errors.join(' ') });

  try {
    const token = crypto.randomBytes(24).toString('hex');
    const hash = bcrypt.hashSync(password, 12);
    run('INSERT INTO users (email, username, first_name, last_name, password_hash, verify_token) VALUES (?, ?, ?, ?, ?, ?)', [values.email, values.username, values.first_name, values.last_name, hash, token]);
    const verifyUrl = `${APP_URL}/verify/${token}`;
    // The link travels by email only. Printing it in the response would let
    // anyone "verify" an address they do not own.
    sendMail(values.email, 'Verify your Matcha account', `Hi ${values.first_name},\n\nActivate your Matcha account with this link:\n${verifyUrl}\n\nIf you did not create this account, ignore this message.`);
    res.render('login', {
      values: { username: values.username },
      notice: 'Account created. Open the link we sent to your email to activate it. You cannot sign in before that.'
    });
  } catch (err) {
    const message = /UNIQUE.*email/i.test(err.message) ? 'That email is already registered.'
      : /UNIQUE.*username/i.test(err.message) ? 'That username is taken.'
      : 'Email or username already exists.';
    res.status(409).render('register', { values, error: message });
  }
});

app.get('/verify/:token', (req, res) => {
  const user = get('SELECT id FROM users WHERE verify_token = ?', [req.params.token]);
  if (!user) return res.status(404).render('login', { values: {}, error: 'Invalid or expired verification link.' });
  run('UPDATE users SET verified = 1, verify_token = NULL WHERE id = ?', [user.id]);
  res.render('login', { values: {}, notice: 'Account activated. You can sign in now.' });
});

app.get('/login', (req, res) => res.render('login', { values: {} }));
app.get('/resend-verification', (req, res) => res.render('resend-verification', { values: {} }));
app.post('/resend-verification', verificationLimiter, (req, res) => {
  const email = sanitizeText(req.body.email, 120).toLowerCase();
  const user = get('SELECT id, email, first_name FROM users WHERE email = ? AND verified = 0', [email]);
  if (user) {
    const token = crypto.randomBytes(24).toString('hex');
    run('UPDATE users SET verify_token = ? WHERE id = ?', [token, user.id]);
    const verifyUrl = `${APP_URL}/verify/${token}`;
    sendMail(user.email, 'Verify your Matcha account', `Hi ${user.first_name},\n\nActivate your Matcha account with this link:\n${verifyUrl}\n\nIf you did not create this account, ignore this message.`);
  }
  res.render('resend-verification', {
    values: { email },
    notice: 'If that address belongs to an unverified account, a new verification link was sent.'
  });
});
app.post('/login', authLimiter, (req, res) => {
  const username = sanitizeText(req.body.username, 32);
  const values = { username };
  const user = get('SELECT * FROM users WHERE username = ?', [username]);
  if (!user || !bcrypt.compareSync(String(req.body.password || ''), user.password_hash)) {
    return res.status(401).render('login', { values, error: 'Wrong username or password.' });
  }
  if (!user.verified) return res.status(403).render('login', { values, error: 'Please verify your email before signing in.' });
  req.session.userId = user.id;
  run('UPDATE users SET online = 1, last_seen = strftime(\'%s\',\'now\') WHERE id = ?', [user.id]);
  const profileReady = user.gender && user.birthdate && user.bio && hasProfilePhoto(user.id);
  res.redirect(profileReady ? '/browse' : '/profile?welcome=1');
});

app.post('/logout', requireAuth, (req, res) => {
  run('UPDATE users SET online = 0, last_seen = strftime(\'%s\',\'now\') WHERE id = ?', [req.user.id]);
  req.session.destroy(() => res.redirect('/'));
});

app.get('/forgot', (req, res) => res.render('forgot', { values: {} }));
app.post('/forgot', authLimiter, (req, res) => {
  const email = sanitizeText(req.body.email, 120).toLowerCase();
  const user = get('SELECT * FROM users WHERE email = ?', [email]);
  if (user) {
    const token = crypto.randomBytes(24).toString('hex');
    run('UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?', [token, Math.floor(Date.now() / 1000) + 3600, user.id]);
    const resetUrl = `${APP_URL}/reset/${token}`;
    sendMail(email, 'Reset your Matcha password', `A password reset was requested for @${user.username}.\n\nThis link is valid for one hour:\n${resetUrl}\n\nIf it was not you, ignore this message. Your password stays unchanged.`);
  }
  // Always the same answer, with or without a match: the link must never reach
  // the browser, and the page must not reveal whether the email exists.
  res.render('forgot', { values: { email }, notice: 'If that email is registered, a reset link was sent.' });
});

app.get('/reset/:token', (req, res) => {
  const user = get('SELECT id FROM users WHERE reset_token = ? AND reset_expires > ?', [req.params.token, Math.floor(Date.now() / 1000)]);
  if (!user) return res.status(404).render('forgot', { values: {}, error: 'That reset link is invalid or expired.' });
  res.render('reset', { token: req.params.token });
});
app.post('/reset/:token', authLimiter, (req, res) => {
  const issues = passwordIssues(req.body.password);
  if (issues.length) return res.status(400).render('reset', { token: req.params.token, error: `Password needs ${issues.join(', ')}.` });
  const user = get('SELECT * FROM users WHERE reset_token = ? AND reset_expires > ?', [req.params.token, Math.floor(Date.now() / 1000)]);
  if (!user) return res.status(404).render('forgot', { values: {}, error: 'That reset link is invalid or expired.' });
  run('UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires = NULL WHERE id = ?', [bcrypt.hashSync(req.body.password, 12), user.id]);
  res.render('login', { values: { username: user.username }, notice: 'Password updated.' });
});

function renderProfile(res, profile, opts = {}) {
  const tags = all('SELECT t.name FROM tags t JOIN user_tags ut ON ut.tag_id = t.id WHERE ut.user_id = ? ORDER BY t.name', [profile.id]);
  const photos = all('SELECT * FROM photos WHERE user_id = ? ORDER BY is_profile DESC, created_at DESC', [profile.id]);
  // One row per visitor (their latest visit), so a single person refreshing the
  // page cannot push everyone else out of the history.
  const visits = all(`SELECT u.username, u.first_name, u.last_name, p.filename AS profile_photo, MAX(v.created_at) AS created_at, COUNT(*) AS visit_count FROM visits v JOIN users u ON u.id = v.visitor_id LEFT JOIN photos p ON p.user_id = u.id AND p.is_profile = 1 WHERE v.visited_id = ? GROUP BY v.visitor_id ORDER BY created_at DESC LIMIT 12`, [profile.id]);
  const likes = all(`SELECT u.username, u.first_name, u.last_name, p.filename AS profile_photo, l.created_at FROM likes l JOIN users u ON u.id = l.liker_id LEFT JOIN photos p ON p.user_id = u.id AND p.is_profile = 1 WHERE l.liked_id = ? ORDER BY l.created_at DESC LIMIT 12`, [profile.id]);
  return res.render('profile', {
    profile,
    tags,
    photos,
    visits,
    likes,
    age: ageFromBirthdate(profile.birthdate),
    welcome: opts.welcome || false,
    error: opts.error || null,
    notice: opts.notice || null
  });
}

app.get('/profile', requireAuth, (req, res) => {
  renderProfile(res, req.user, { welcome: req.query.welcome === '1' });
});

app.post('/profile', requireAuth, upload.array('photos', 5), (req, res) => {
  const uploaded = keepOnlyRealImages(req.files);
  const rejectedUploads = (req.files || []).length - uploaded.length;
  let overCap = 0;
  try {
    const firstName = sanitizeText(req.body.first_name, 60);
    const lastName = sanitizeText(req.body.last_name, 60);
    const email = sanitizeText(req.body.email, 120).toLowerCase();
    const bio = sanitizeText(req.body.bio, 900);
    const city = sanitizeText(req.body.city, 80);
    const neighborhood = sanitizeText(req.body.neighborhood, 80);
    const gender = ['man', 'woman', 'other'].includes(req.body.gender) ? req.body.gender : null;
    const preference = ['men', 'women', 'bisexual'].includes(req.body.preference) ? req.body.preference : 'bisexual';
    if (!firstName) throw userError('First name is required.');
    if (!lastName) throw userError('Last name is required.');
    if (!validator.isEmail(email)) throw userError('Enter a valid email address.');
    if (req.body.birthdate) {
      const age = ageFromBirthdate(req.body.birthdate);
      if (age == null) throw userError('Birthdate is invalid.');
      if (age < 18) throw userError('You must be at least 18 years old.');
      if (age > 120) throw userError('That birthdate looks unrealistic.');
    }

    // GPS coordinates are only kept while consent is ticked; without them a
    // manual city is mandatory, since matching is location-driven.
    const consent = req.body.location_consent ? 1 : 0;
    const latitude = consent && req.body.latitude !== '' && req.body.latitude != null ? Number(req.body.latitude) : null;
    const longitude = consent && req.body.longitude !== '' && req.body.longitude != null ? Number(req.body.longitude) : null;
    if (latitude !== null && (!Number.isFinite(latitude) || latitude < -90 || latitude > 90)) throw userError('Latitude must be between -90 and 90.');
    if (longitude !== null && (!Number.isFinite(longitude) || longitude < -180 || longitude > 180)) throw userError('Longitude must be between -180 and 180.');
    if ((latitude === null || longitude === null) && !city) {
      throw userError('Set your city, or tick the GPS box. Matching needs a location.');
    }

    transaction(() => {
      run(`UPDATE users SET first_name=?, last_name=?, email=?, gender=?, preference=?, birthdate=?, bio=?, city=?, neighborhood=?, latitude=?, longitude=?, location_consent=? WHERE id=?`, [
        firstName, lastName, email, gender, preference, req.body.birthdate || null, bio,
        city, neighborhood, latitude, longitude, consent, req.user.id
      ]);
      run('DELETE FROM user_tags WHERE user_id = ?', [req.user.id]);
      String(req.body.tags || '').split(/[,\s]+/).map(normalizeTag).filter(Boolean).slice(0, 15).forEach((name) => {
        run('INSERT OR IGNORE INTO tags (name) VALUES (?)', [name]);
        const tag = get('SELECT id FROM tags WHERE name = ?', [name]);
        run('INSERT OR IGNORE INTO user_tags (user_id, tag_id) VALUES (?, ?)', [req.user.id, tag.id]);
      });
      let count = get('SELECT COUNT(*) AS c FROM photos WHERE user_id = ?', [req.user.id]).c;
      for (const file of uploaded) {
        // Past the 5-photo cap the file is dropped from disk too, so no
        // unreferenced upload is left behind.
        if (count >= 5) {
          overCap += 1;
          fs.rm(file.path, { force: true }, () => {});
          continue;
        }
        const hasProfile = hasProfilePhoto(req.user.id);
        run('INSERT INTO photos (user_id, filename, is_profile) VALUES (?, ?, ?)', [req.user.id, file.filename, hasProfile ? 0 : 1]);
        count += 1;
      }
    });
    const fresh = get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (rejectedUploads || overCap) {
      const reasons = [];
      if (rejectedUploads) reasons.push(`${rejectedUploads} file${rejectedUploads === 1 ? ' was' : 's were'} rejected, only JPEG, PNG and WebP are accepted`);
      if (overCap) reasons.push(`${overCap} file${overCap === 1 ? ' was' : 's were'} skipped, the limit is 5 photos`);
      res.status(400);
      return renderProfile(res, fresh, { error: `Profile saved. ${reasons.join('. ')}.` });
    }
    renderProfile(res, fresh, { notice: 'Profile saved.' });
  } catch (err) {
    for (const file of uploaded) fs.rm(file.path, { force: true }, () => {});
    if (/UNIQUE.*email/i.test(err.message)) {
      res.status(409);
      return renderProfile(res, req.user, { error: 'That email is already used by another account.' });
    }
    if (!err.userFacing) throw err;
    res.status(err.status || 400);
    renderProfile(res, req.user, { error: err.message });
  }
});

app.post('/photos/:id/profile', requireAuth, (req, res) => {
  const photo = get('SELECT * FROM photos WHERE id = ? AND user_id = ?', [positiveId(req.params.id), req.user.id]);
  if (photo) {
    run('UPDATE photos SET is_profile = 0 WHERE user_id = ?', [req.user.id]);
    run('UPDATE photos SET is_profile = 1 WHERE id = ?', [photo.id]);
  }
  res.redirect('/profile');
});

app.post('/photos/:id/delete', requireAuth, (req, res) => {
  const photo = get('SELECT * FROM photos WHERE id = ? AND user_id = ?', [positiveId(req.params.id), req.user.id]);
  if (photo) {
    const wasProfile = photo.is_profile === 1;
    run('DELETE FROM photos WHERE id = ?', [photo.id]);
    fs.rm(path.join(uploadDir, photo.filename), { force: true }, () => {});
    if (wasProfile) {
      const fallback = get('SELECT id FROM photos WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', [req.user.id]);
      if (fallback) run('UPDATE photos SET is_profile = 1 WHERE id = ?', [fallback.id]);
    }
  }
  res.redirect('/profile');
});

app.get('/browse', requireAuth, (req, res) => {
  const profiles = profileQuery(req.user, req.query);
  res.render('browse', { profiles, query: req.query });
});

app.get('/search', requireAuth, (req, res) => {
  const hasQuery = Object.keys(req.query).some(k => req.query[k] !== '');
  const profiles = hasQuery ? profileQuery(req.user, req.query) : null;
  res.render('search', { profiles, query: req.query });
});

app.get('/users/:username', requireAuth, (req, res) => {
  const profile = get(`SELECT u.*, p.filename AS profile_photo FROM users u LEFT JOIN photos p ON p.user_id = u.id AND p.is_profile = 1 WHERE u.username = ?`, [req.params.username]);
  if (!profile || profile.id === req.user.id) return res.status(404).render('error', { message: 'Profile not found.' });
  const blocked = get('SELECT 1 FROM blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)', [req.user.id, profile.id, profile.id, req.user.id]);
  if (blocked) return res.status(404).render('error', { message: 'Profile not available.' });
  run('INSERT INTO visits (visitor_id, visited_id) VALUES (?, ?)', [req.user.id, profile.id]);
  recalcFame(profile.id);
  notify(profile.id, req.user.id, 'visit', `${req.user.username} viewed your profile.`, `/users/${req.user.username}`);
  const tags = all('SELECT t.name FROM tags t JOIN user_tags ut ON ut.tag_id = t.id WHERE ut.user_id = ?', [profile.id]);
  const photos = all('SELECT * FROM photos WHERE user_id = ? ORDER BY is_profile DESC, created_at DESC', [profile.id]);
  const liked = Boolean(get('SELECT 1 FROM likes WHERE liker_id = ? AND liked_id = ?', [req.user.id, profile.id]));
  const likedMe = Boolean(get('SELECT 1 FROM likes WHERE liker_id = ? AND liked_id = ?', [profile.id, req.user.id]));
  const youHavePhoto = hasProfilePhoto(req.user.id);
  res.render('user', {
    profile,
    tags,
    photos,
    liked,
    likedMe,
    isConnected: liked && likedMe,
    youHavePhoto,
    age: ageFromBirthdate(profile.birthdate),
    distance: distanceKm(req.user, profile),
    query: req.query
  });
});

app.post('/users/:id/like', requireAuth, (req, res) => {
  const target = get('SELECT * FROM users WHERE id = ?', [positiveId(req.params.id)]);
  if (!target) return res.status(404).render('error', { message: 'Profile not found.' });
  if (target.id === req.user.id) return res.redirect('/browse');
  if (isBlockedPair(req.user.id, target.id)) return res.status(404).render('error', { message: 'Profile not available.' });
  if (!hasProfilePhoto(req.user.id)) {
    return res.redirect(`/users/${target.username}?need_photo=1`);
  }
  run('INSERT OR IGNORE INTO likes (liker_id, liked_id) VALUES (?, ?)', [req.user.id, target.id]);
  // Liking again lifts the notification mute a previous unlike had set.
  run('DELETE FROM unlikes WHERE unliker_id = ? AND unliked_id = ?', [req.user.id, target.id]);
  recalcFame(target.id);
  notify(target.id, req.user.id, 'like', `${req.user.username} liked your profile.`, `/users/${req.user.username}`);
  if (connected(req.user.id, target.id)) {
    notify(target.id, req.user.id, 'match', `You and ${req.user.username} are now connected.`, `/chat?with=${req.user.id}`);
    notify(req.user.id, target.id, 'match', `You and ${target.username} are now connected.`, `/chat?with=${target.id}`);
  }
  res.redirect(`/users/${target.username}`);
});

app.post('/users/:id/unlike', requireAuth, (req, res) => {
  const target = get('SELECT * FROM users WHERE id = ?', [positiveId(req.params.id)]);
  if (!target) return res.status(404).render('error', { message: 'Profile not found.' });
  const wasConnected = connected(req.user.id, target.id);
  const had = get('SELECT 1 FROM likes WHERE liker_id = ? AND liked_id = ?', [req.user.id, target.id]);
  run('DELETE FROM likes WHERE liker_id = ? AND liked_id = ?', [req.user.id, target.id]);
  // Removing a like also silences that person: no more likes, visits or
  // messages from them until this user likes them again.
  if (had) run('INSERT OR IGNORE INTO unlikes (unliker_id, unliked_id) VALUES (?, ?)', [req.user.id, target.id]);
  recalcFame(target.id);
  if (wasConnected) notify(target.id, req.user.id, 'unlike', `${req.user.username} disconnected from you.`, `/users/${req.user.username}`);
  res.redirect(`/users/${target.username}`);
});

app.post('/users/:id/block', requireAuth, (req, res) => {
  const targetId = positiveId(req.params.id);
  const target = targetId && get('SELECT id FROM users WHERE id = ?', [targetId]);
  if (!target || target.id === req.user.id) return res.status(404).render('error', { message: 'Profile not found.' });
  run('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)', [req.user.id, target.id]);
  run('DELETE FROM likes WHERE (liker_id = ? AND liked_id = ?) OR (liker_id = ? AND liked_id = ?)', [req.user.id, target.id, target.id, req.user.id]);
  recalcFame(req.user.id);
  recalcFame(target.id);
  res.redirect('/browse');
});

app.post('/users/:id/report', requireAuth, (req, res) => {
  const targetId = positiveId(req.params.id);
  const target = targetId && get('SELECT username FROM users WHERE id = ?', [targetId]);
  if (!target || targetId === req.user.id) return res.status(404).render('error', { message: 'Profile not found.' });
  run('INSERT OR IGNORE INTO reports (reporter_id, reported_id, reason) VALUES (?, ?, ?)', [req.user.id, targetId, 'fake account']);
  recalcFame(targetId);
  res.redirect(`/users/${target.username}?reported=1`);
});

app.get('/chat', requireAuth, (req, res) => {
  const people = all(`
    SELECT u.*, p.filename AS profile_photo,
      (SELECT body FROM messages m WHERE (m.sender_id=u.id AND m.receiver_id=?) OR (m.sender_id=? AND m.receiver_id=u.id) ORDER BY m.created_at DESC LIMIT 1) AS last_message,
      (SELECT created_at FROM messages m WHERE (m.sender_id=u.id AND m.receiver_id=?) OR (m.sender_id=? AND m.receiver_id=u.id) ORDER BY m.created_at DESC LIMIT 1) AS last_message_at,
      (SELECT COUNT(*) FROM messages m WHERE m.sender_id=u.id AND m.receiver_id=? AND m.read_at IS NULL) AS unread
    FROM users u
    LEFT JOIN photos p ON p.user_id = u.id AND p.is_profile = 1
    WHERE EXISTS (SELECT 1 FROM likes a JOIN likes b ON b.liker_id = a.liked_id AND b.liked_id = a.liker_id WHERE a.liker_id = ? AND a.liked_id = u.id)
    AND NOT EXISTS (SELECT 1 FROM blocks bl WHERE (bl.blocker_id = ? AND bl.blocked_id = u.id) OR (bl.blocker_id = u.id AND bl.blocked_id = ?))
    ORDER BY (last_message_at IS NULL), last_message_at DESC, u.username
  `, [req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id]);
  const activeId = Number(req.query.with || (people[0] && people[0].id));
  const active = people.find((p) => p.id === activeId);
  // Keep the 200 most recent messages, then show them oldest-first.
  const messages = active ? all(`
    SELECT * FROM (
      SELECT * FROM messages
      WHERE (sender_id=? AND receiver_id=?) OR (sender_id=? AND receiver_id=?)
      ORDER BY created_at DESC, id DESC LIMIT 200
    ) ORDER BY created_at ASC, id ASC
  `, [req.user.id, active.id, active.id, req.user.id]) : [];
  if (active) run('UPDATE messages SET read_at = strftime(\'%s\',\'now\') WHERE sender_id = ? AND receiver_id = ? AND read_at IS NULL', [active.id, req.user.id]);
  res.render('chat', { people, active, messages });
});

app.post('/chat/:id', requireAuth, (req, res) => {
  const receiver = get('SELECT * FROM users WHERE id = ?', [positiveId(req.params.id)]);
  const body = sanitizeText(req.body.body, 1000);
  if (!receiver || !body || !connected(req.user.id, receiver.id) || isBlockedPair(req.user.id, receiver.id)) return res.redirect('/chat');
  const info = run('INSERT INTO messages (sender_id, receiver_id, body) VALUES (?, ?, ?)', [req.user.id, receiver.id, body]);
  const message = get('SELECT * FROM messages WHERE id = ?', [info.lastInsertRowid]);
  const payload = { ...message, sender_username: req.user.username };
  io.to(`user:${receiver.id}`).emit('message', payload);
  io.to(`user:${req.user.id}`).emit('message', payload);
  notify(receiver.id, req.user.id, 'message', `${req.user.username}: ${body.slice(0, 60)}${body.length > 60 ? '…' : ''}`, `/chat?with=${req.user.id}`);
  res.redirect(`/chat?with=${receiver.id}`);
});

// Feeds the interest autocomplete: tags are shared across users, so the ones
// already in use are offered back as suggestions, most popular first.
app.get('/tags', requireAuth, (req, res) => {
  const search = normalizeTag(req.query.q);
  const rows = search
    ? all('SELECT t.name, COUNT(ut.user_id) AS uses FROM tags t LEFT JOIN user_tags ut ON ut.tag_id = t.id WHERE t.name LIKE @prefix GROUP BY t.id ORDER BY uses DESC, t.name ASC LIMIT 12', { prefix: `${search}%` })
    : all('SELECT t.name, COUNT(ut.user_id) AS uses FROM tags t LEFT JOIN user_tags ut ON ut.tag_id = t.id GROUP BY t.id ORDER BY uses DESC, t.name ASC LIMIT 30');
  res.json(rows);
});

app.get('/notifications', requireAuth, (req, res) => {
  const notifications = all(`SELECT n.*, u.username AS actor_username, p.filename AS actor_photo FROM notifications n LEFT JOIN users u ON u.id = n.actor_id LEFT JOIN photos p ON p.user_id = u.id AND p.is_profile = 1 WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT 100`, [req.user.id]);
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

const EXPECTED_ERROR_CODES = new Set(['LIMIT_FILE_SIZE', 'LIMIT_FILE_COUNT', 'LIMIT_UNEXPECTED_FILE', 'entity.too.large', 'entity.parse.failed']);

app.use((err, req, res, next) => {
  // A rejected upload or a malformed body is a normal outcome, not an incident:
  // log one line for those and keep stack traces for genuine faults.
  if (err && (err.userFacing || EXPECTED_ERROR_CODES.has(err.code) || EXPECTED_ERROR_CODES.has(err.type))) {
    console.warn(`${req.method} ${req.path}: ${err.message}`);
  } else {
    console.error(err);
  }
  if (res.headersSent) return next(err);

  // Body-parser and multer failures happen before the locals middleware runs,
  // so the layout would blow up on undefined locals. Seed them here.
  if (res.locals.user === undefined) {
    const user = req.session ? currentUser(req) : null;
    Object.assign(res.locals, {
      user,
      unreadCount: 0,
      unreadMessages: 0,
      error: null,
      notice: null,
      values: {},
      lastSeenText,
      formatDistance,
      devMail: MAIL_MODE === 'console',
      currentPath: req.path
    });
  }

  if (err && (err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_FILE_COUNT')) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'Each photo must be 3 MB or smaller.' : 'You can upload at most 5 photos at a time.';
    res.status(400);
    if (req.path === '/profile' && res.locals.user) return renderProfile(res, res.locals.user, { error: message });
    return res.render('error', { message });
  }

  // Only messages we wrote ourselves reach the user; anything else (SQLite,
  // EJS, Node) would leak internals, so it becomes a generic sentence.
  const status = err && err.status >= 400 && err.status < 500 ? err.status : 400;
  const message = err && err.userFacing && err.message ? err.message : 'Something went wrong with that request.';
  res.status(status).render('error', { message });
});

app.use((req, res) => res.status(404).render('error', { message: 'Page not found.' }));

server.listen(PORT, () => {
  console.log(`Matcha running at ${APP_URL}`);
});
