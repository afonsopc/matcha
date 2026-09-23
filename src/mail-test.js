// Sends one real email with the settings from .env, so SMTP problems show up
// here instead of during a signup. Usage: npm run mail:test -- you@example.com
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { createMailer, readConfig } = require('./mailer');
const { verifyEmail } = require('./emails');

const to = process.argv[2];
if (!to) {
  console.error('Usage: npm run mail:test -- you@example.com');
  process.exit(1);
}

const config = readConfig(process.env);
if (config.mode !== 'smtp' || !config.host) {
  console.error('MAIL_MODE must be "smtp" and SMTP_HOST must be set in .env to send a real email.');
  process.exit(1);
}
console.log(`Sending through ${config.host}:${config.port} (${config.secure ? 'TLS' : 'STARTTLS'}) as ${config.from}`);

const appUrl = process.env.APP_URL || 'http://localhost:3000';
const mail = verifyEmail({ firstName: 'tester', url: `${appUrl}/verify/this-is-only-a-test` });
createMailer(process.env)(to, `[test] ${mail.subject}`, mail.text, mail.html).then((result) => {
  if (result.delivered) console.log(result.preview ? `Captured by Ethereal: ${result.preview}` : 'Delivered. Check the inbox (and the spam folder).');
  process.exit(result.delivered ? 0 : 1);
});
