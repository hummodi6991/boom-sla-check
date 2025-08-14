// check.js
// Usage: node check.js --conversation "<URL>"

const { chromium } = require('playwright');
const nodemailer = require('nodemailer');

const argvUrl = (() => {
  const idx = process.argv.indexOf('--conversation');
  return idx >= 0 ? process.argv[idx + 1] : '';
})();

const BOOM_USER = process.env.BOOM_USER || '';
const BOOM_PASS = process.env.BOOM_PASS || '';
const FROM_NAME = process.env.FROM_NAME || 'Oaktree Boom SLA Bot';
const ROHIT_EMAIL = process.env.ROHIT_EMAIL || '';
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';

if (!argvUrl) {
  console.log('No conversation URL provided; staying on login page to demonstrate artifacts.');
}

function log(...a) { console.log(...a); }

// ---- email helpers ---------------------------------------------------------

async function makeTransport(port, secure) {
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure, // true for 465, false for 587 (STARTTLS)
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    tls: {
      minVersion: 'TLSv1.2',
      // GitHub runners can be strict; keep default CA, do not force rejectUnauthorized false
    },
  });
}

async function sendAlertEmail({ lastSender, urlForEmail }) {
  let transporter;
  try {
    // Try SMTPS on 465 first
    transporter = await makeTransport(465, true);
    await transporter.verify(); // handshake
  } catch (e) {
    log('465 SMTPS failed, falling back to 587 STARTTLS:', e.message);
    transporter = await makeTransport(587, false);
    await transporter.verify();
  }

  const subject = 'SLA breach (>5 min): Boom guest message unanswered';
  const html = `
    <p>Hi Rohit,</p>
    <p>A Boom guest message appears unanswered after 5 minutes.</p>
    <p>Conversation: <a href="${urlForEmail}">Open in Boom</a><br/>
       Last sender detected: ${lastSender || 'Unknown'}</p>
    <p>– Automated alert</p>
  `;

  const info = await transporter.sendMail({
    from: `"${FROM_NAME}" <${SMTP_USER}>`,
    to: ROHIT_EMAIL,
    subject,
    html,
  });

  log('SMTP message id:', info.messageId);
}

// ---- page utilities ---------------------------------------------------------

async function saveSnapshot(page, tag) {
  const shot = `/tmp/shot_${tag}.png`;
  const html = `/tmp/page_${tag}.html`;
  await page.screenshot({ path: shot, fullPage: true });
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  const content = await page.content().catch(() => '');
  const fs = require('fs');
  fs.writeFileSync(html, content || '');
  log('Saved artifacts for', tag);
}

async function detectLastMessage(page) {
  // Search main page + iframes for elements that look like messages.
  const contexts = [page, ...(await page.frames())];

  log(`Searching ${contexts.length} contexts (page + ${contexts.length - 1} frames)…`);

  const SELS = [
    // common chat bubbles / timelines
    '[class*="message"]',
    '[data-test*="message"]',
    '.chat-message',
    '.Message__container',
    // avoid toast wrappers:
    '.intercom-conversation-body',
    '.intercom-thread',
  ];

  for (const ctx of contexts) {
    for (const sel of SELS) {
      const nodes = await ctx.$$(sel);
      if (nodes.length > 0) {
        // Return some text sample if possible
        const last = nodes[nodes.length - 1];
        let textSample = '';
        try {
          textSample = (await last.innerText())?.trim().slice(0, 120) || '';
        } catch {}
        log(`Found ${nodes.length} nodes with selector "${sel}"`);
        log('last message debug:', { selector: sel, textSample });
        // Heuristic: if text is empty it’s likely not a real message (e.g., layout node)
        if (textSample) {
          // Try to infer sender by common patterns
          let lastSender = 'Unknown';
          try {
            const parentText = (await (await last.evaluateHandle(el => el.parentElement || el)).innerText()) || '';
            if (/guest|customer/i.test(parentText)) lastSender = 'Guest';
            if (/you|agent|host|oaktree/i.test(parentText)) lastSender = 'Agent';
          } catch {}
          return { isAnswered: lastSender !== 'Guest', lastSender, reason: 'heuristic' };
        }
      }
    }
  }
  return { isAnswered: false, lastSender: 'Unknown', reason: 'no_selector' };
}

// ---- main -------------------------------------------------------------------

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // 1) Go to login (or conversation if provided)
  const startUrl = argvUrl || 'https://app.boomnow.com/login';
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
  await saveSnapshot(page, 't1');

  // 2) If login form is visible, sign in
  const emailSel = 'input[type="email"], input[name="email"]';
  const passSel  = 'input[type="password"], input[name="password"]';
  const loginBtn = 'button:has-text("Login"), button[type="submit"]';

  const emailInput = await page.$(emailSel);
  const passInput  = await page.$(passSel);

  if (emailInput && passInput) {
    log('Login page detected, signing in…');
    await emailInput.fill(BOOM_USER);
    await passInput.fill(BOOM_PASS);
    const btn = await page.$(loginBtn);
    if (btn) await btn.click();
    // Wait for either the conversation or any app shell route to load
    await page.waitForLoadState('networkidle').catch(() => {});
    // If a conversation URL was provided, navigate there post-login
    if (argvUrl) {
      await page.goto(argvUrl, { waitUntil: 'domcontentloaded' });
    }
  }

  await saveSnapshot(page, 't2');

  // 3) Do message heuristic twice (before/after the 5-min SLA wait handled by Power Automate)
  //    Here this script only runs once, Power Automate handles the 5-minute delay between two runs.
  const result = await detectLastMessage(page);
  log('Second check result:', result);

  // 4) Email if unanswered / last sender looked like guest
  if (result.isAnswered === false) {
    const urlForEmail = argvUrl || 'https://app.boomnow.com/';
    log('Sending email to *** from ***…');
    await sendAlertEmail({ lastSender: result.lastSender, urlForEmail });
  } else {
    log('No alert needed.');
  }

  await browser.close();
})().catch(e => {
  console.error(e);
  process.exit(1);
});
