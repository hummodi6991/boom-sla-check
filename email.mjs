/**
 * Boom SLA Bot - Mailer (UTF-8 safe)
 * Fixes mojibake by forcing UTF-8 and sanitizing text before sending.
 *
 * Usage (programmatic):
 *   const { sendSlaEmail } = require('./mailer');
 *   await sendSlaEmail({ minutes: 5, url: 'https://example.com', to: 'a@b.com' });
 *
 * CLI (optional for testing):
 *   node mailer.js --minutes 5 --url https://example.com --to you@example.com
 *
 * Required ENV:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
 * Optional ENV:
 *   ALERT_FROM_NAME, ALERT_TO (comma-separated), ALERT_LANGUAGE (default: en-US)
 */
const nodemailer = require('nodemailer');

function sanitize(input) {
  return String(input ?? '')
    .normalize('NFC')
    .replace(/\u00A0/g, ' ')               // NBSP -> space
    .replace(/[‘’]/g, "'")                  // curly -> straight
    .replace(/[“”]/g, '"')                  // curly -> straight
    .replace(/[\u2013\u2014]/g, '-')      // en/em dash -> hyphen
    .replace(/\u200B/g, '');               // zero-width space -> remove
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, function(m) {
    switch (m) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return m;
    }
  });
}

async function sendSlaEmail({ minutes, url, to }) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !port || !user || !pass) {
    throw new Error('Missing SMTP_* environment variables.');
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // true for 465, false otherwise
    auth: { user, pass }
  });

  const fromName = sanitize(process.env.ALERT_FROM_NAME || 'Oaktree Boom SLA Bot');
  const toList = sanitize(to || process.env.ALERT_TO || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!toList.length) {
    throw new Error('Recipient list is empty. Provide "to" or set ALERT_TO.');
  }

  const mins = Number(minutes);
  const safeUrl = sanitize(url || '');
  const subject = sanitize(`Boom SLA: guest unanswered ${Number.isFinite(mins) ? mins : minutes}m`);

  const textBody = sanitize(
    `Guest appears unanswered for ${Number.isFinite(mins) ? mins : minutes} minutes.`
    + (safeUrl ? `\n\nConversation: ${safeUrl}` : '')
  );

  const htmlBody = `<p>${escapeHtml(textBody).replace(/\n/g, '<br>')}</p>`;

  const info = await transporter.sendMail({
    from: { name: fromName, address: user },
    to: toList,
    subject,
    text: textBody,
    html: htmlBody,
    headers: {
      'Content-Type': 'text/plain; charset=UTF-8',
      'Content-Transfer-Encoding': 'quoted-printable',
      'Content-Language': sanitize(process.env.ALERT_LANGUAGE || 'en-US')
    }
  });

  return info;
}

module.exports = { sendSlaEmail };

// Optional CLI for quick testing
if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const minutes = get('--minutes') ?? get('-m') ?? 5;
  const url = get('--url') ?? get('-u') ?? '';
  const to = get('--to') ?? get('-t') ?? process.env.ALERT_TO;

  (async () => {
    const info = await sendSlaEmail({ minutes, url, to });
    console.log('Email queued with id:', info.messageId);
  })().catch(err => {
    console.error('Failed to send email:', err && err.stack || err);
    process.exit(1);
  });
}
