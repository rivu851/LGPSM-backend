// Sends one test email the same way the server does, and says which route it took and why it failed if it did.
//   node scripts/check-email.js you@example.com
// Uses the environment of the machine it runs on (a .env file, or the variables you export). Prints no secrets.
require('dotenv').config();
const to = process.argv[2];
if (!to) { console.error('Usage: node scripts/check-email.js recipient@example.com'); process.exit(1); }

const set = (k) => (process.env[k] ? 'set' : 'MISSING');
console.log('BREVO_API_KEY :', set('BREVO_API_KEY'), '(mail over HTTPS: works on hosts that block SMTP, such as Render free)');
console.log('BREVO_SENDER  :', set('BREVO_SENDER'), '(a sender verified in Brevo, e.g. "LGPSM <events@yourdomain>")');
console.log('PUBLIC_API_URL:', set('PUBLIC_API_URL'), '(this API\'s public address; invitation emails link their images there)');
console.log('SMTP_HOST/USER/PASS:', set('SMTP_HOST'), set('SMTP_USER'), set('SMTP_PASS'), '(fallback; SMTP ports are blocked on Render free instances)');
console.log('Route:', process.env.BREVO_API_KEY ? 'Brevo API over HTTPS' : 'SMTP');

const { sendEmail } = require('../dist/utils/email.provider');
sendEmail(to, 'LGPSM email check', '<p>This is a test from <b>scripts/check-email.js</b>. If you can read it, the server can send mail.</p>')
  .then(() => { console.log('SENT: the mail service accepted the message for', to); process.exit(0); })
  .catch((e) => { console.error('FAILED:', e.message, '(the line above it explains why)'); process.exit(2); });
