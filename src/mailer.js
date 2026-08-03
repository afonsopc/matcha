const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

const TIMEOUT_MS = 15000;

// Minimal SMTP client (ESMTP + STARTTLS + AUTH LOGIN) built on the standard
// library, so the project keeps its "micro-framework, no extra libraries" shape.
class SmtpSession {
  constructor(socket) {
    this.buffer = '';
    this.waiter = null;
    this.failure = null;
    this.attach(socket);
  }

  attach(socket) {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.setTimeout(TIMEOUT_MS);
    socket.on('data', (chunk) => {
      this.buffer += chunk;
      this.drain();
    });
    socket.on('error', (err) => this.abort(err));
    socket.on('timeout', () => this.abort(new Error('SMTP timeout')));
    socket.on('close', () => this.abort(new Error('SMTP connection closed')));
  }

  abort(err) {
    this.failure = this.failure || err;
    if (this.waiter) {
      const { reject } = this.waiter;
      this.waiter = null;
      reject(err);
    }
  }

  drain() {
    if (!this.waiter) return;
    const lines = this.buffer.split(/\r?\n/);
    const end = lines.findIndex((line) => /^\d{3}(\s|$)/.test(line));
    if (end === -1) return;
    const reply = lines.slice(0, end + 1).join('\n');
    this.buffer = lines.slice(end + 1).join('\n');
    const code = Number(lines[end].slice(0, 3));
    const { resolve, reject, expected } = this.waiter;
    this.waiter = null;
    if (expected.includes(code)) resolve({ code, reply });
    else reject(new Error(`SMTP expected ${expected.join('/')} but got: ${reply.trim()}`));
  }

  read(expected) {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject, expected };
      this.drain();
    });
  }

  send(command, expected) {
    if (this.failure) return Promise.reject(this.failure);
    const pending = this.read(expected);
    this.socket.write(`${command}\r\n`);
    return pending;
  }
}

function connect(options) {
  return new Promise((resolve, reject) => {
    const socket = options.secure ? tls.connect(options) : net.connect(options);
    const onError = (err) => reject(err);
    socket.once('error', onError);
    socket.once(options.secure ? 'secureConnect' : 'connect', () => {
      socket.removeListener('error', onError);
      resolve(socket);
    });
  });
}

function encodeHeader(value) {
  // RFC 2047 encoded-word so accented subjects survive transport.
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function buildMessage({ from, to, subject, text }) {
  const body = String(text).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@matcha>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit'
  ];
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

async function sendSmtpMail(config, { to, subject, text }) {
  const port = Number(config.port);
  const secure = config.secure;
  let socket = await connect({ host: config.host, port, servername: config.host, secure });
  const session = new SmtpSession(socket);
  try {
    await session.read([220]);
    let greeting = await session.send(`EHLO ${config.clientName}`, [250]);

    if (!secure && /STARTTLS/i.test(greeting.reply)) {
      await session.send('STARTTLS', [220]);
      socket.removeAllListeners('data');
      socket.removeAllListeners('close');
      socket.removeAllListeners('timeout');
      socket = tls.connect({ socket, servername: config.host });
      await new Promise((resolve, reject) => {
        socket.once('secureConnect', resolve);
        socket.once('error', reject);
      });
      session.buffer = '';
      session.attach(socket);
      greeting = await session.send(`EHLO ${config.clientName}`, [250]);
    }

    if (config.user) {
      await session.send('AUTH LOGIN', [334]);
      await session.send(Buffer.from(config.user, 'utf8').toString('base64'), [334]);
      await session.send(Buffer.from(config.pass, 'utf8').toString('base64'), [235]);
    }

    await session.send(`MAIL FROM:<${config.fromAddress}>`, [250]);
    await session.send(`RCPT TO:<${to}>`, [250, 251]);
    await session.send('DATA', [354]);
    await session.send(`${buildMessage({ from: config.from, to, subject, text })}\r\n.`, [250]);
    await session.send('QUIT', [221]).catch(() => {});
  } finally {
    socket.destroy();
  }
}

function readConfig(env) {
  const from = env.MAIL_FROM || 'Matcha <no-reply@matcha.local>';
  const fromAddress = (from.match(/<([^>]+)>/) || [null, from])[1].trim();
  return {
    mode: env.MAIL_MODE || 'console',
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT || 587),
    secure: String(env.SMTP_SECURE || '').toLowerCase() === 'true' || Number(env.SMTP_PORT) === 465,
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    clientName: env.SMTP_CLIENT_NAME || 'matcha.local',
    from,
    fromAddress
  };
}

// Returns a sendMail(to, subject, text) that never rejects: a broken mail server
// must not turn a legitimate signup into an unhandled server error.
function createMailer(env = process.env, logger = console) {
  const config = readConfig(env);
  const smtpReady = config.mode === 'smtp' && config.host;

  if (config.mode === 'smtp' && !config.host) {
    logger.warn('MAIL_MODE=smtp but SMTP_HOST is not set. Falling back to console delivery.');
  }

  return async function sendMail(to, subject, text) {
    if (!smtpReady) {
      logger.log(`\n--- Matcha email (${to}) ---\n${subject}\n${text}\n---------------------------\n`);
      return { delivered: false, mode: 'console' };
    }
    try {
      await sendSmtpMail(config, { to, subject, text });
      logger.log(`Matcha email sent to ${to}: ${subject}`);
      return { delivered: true, mode: 'smtp' };
    } catch (err) {
      logger.error(`Matcha email to ${to} failed: ${err.message}`);
      return { delivered: false, mode: 'smtp', error: err };
    }
  };
}

module.exports = { createMailer, readConfig };
