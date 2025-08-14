// check.js
// Usage (workflow passes the URL): node check.js --conversation "<URL>"

const { chromium } = require('playwright');
const nodemailer = require('nodemailer');

const argvUrl = (() => {
  const idx = process.argv.indexOf('--conversation');
  return idx >= 0 ? process.argv[idx + 1] : '';
})();

/* ==== ENV ==== */
const BOOM_USER  = process.env.BOOM_USER || '';
const BOOM_PASS  = process.env.BOOM_PASS || '';
const FROM_NAME  = process.env.FROM_NAME || 'Oaktree Boom SLA Bot';
const ROHIT_EMAIL= process.env.ROHIT_EMAIL || '';
const SMTP_HOST  = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT  = Number(process.env.SMTP_PORT || 465);
const SMTP_USER  = process.env.SMTP_USER || '';
const SMTP_PASS  = process.env.SMTP_PASS || '';
const MSG_SELECTOR = process.env.MSG_SELECTOR || ''; // optional override for the exact chat-bubble selector

/* ==== Helpers ==== */
const log = (...a) => console.log(...a);
async function saveSnapshot(page, tag) {
  const fs = require('fs');
  try {
    await page.screenshot({ path: `/tmp/shot_${tag}.png`, fullPage: true });
    const html = await page.content();
    fs.writeFileSync(`/tmp/page_${tag}.html`, html || '', 'utf8');
    log('Saved artifacts for', tag);
  } catch (e) { log('Artifact save failed:', e.message); }
}

/* ==== Email (465 first, fallback to 587) ==== */
async function makeTransport(port, secure) {
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    tls: { minVersion: 'TLSv1.2' }
  });
}
async function sendAlertEmail({ lastSender, urlForEmail }) {
  let tx;
  try {
    tx = await makeTransport(465, true);
    await tx.verify();
  } catch (e) {
    log('465 SMTPS failed → fallback to 587 STARTTLS:', e.message);
    tx = await makeTransport(587, false);
    await tx.verify();
  }
  const info = await tx.sendMail({
    from: `"${FROM_NAME}" <${SMTP_USER}>`,
    to: ROHIT_EMAIL,
    subject: 'SLA breach (>5 min): Boom guest message unanswered',
    html: `
      <p>Hi Rohit,</p>
      <p>A Boom guest message appears unanswered after 5 minutes.</p>
      <p>Conversation: <a href="${urlForEmail}">Open in Boom</a><br/>
         Last sender detected: ${lastSender || 'Unknown'}</p>
      <p>– Automated alert</p>`
  });
  log('SMTP message id:', info.messageId);
}

/* ==== Login if needed ==== */
async function loginIfNeeded(page) {
  const emailSel = 'input[type="email"], input[name="email"]';
  const passSel  = 'input[type="password"], input[name="password"]';
  if (await page.$(emailSel)) {
    log('Login page detected, signing in…');
    await page.fill(emailSel, BOOM_USER);
    await page.fill(passSel, BOOM_PASS);
    await page.click('button:has-text("Login"), button[type="submit"]');
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(()=>{});
    // If URL was provided, go there after login
    if (argvUrl) {
      await page.goto(argvUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(()=>{});
    }
  }
}

/* ==== Message detection ==== */
const BLACKLIST = [
  'v-messages__wrapper', 'v-messages__message',   // Vuetify validation helpers
  'snackbar', 'toast', 'tooltip',
  'intercom',                                     // Intercom widgets
];

const CANDIDATES = [
  // Put any selector you discover at the top of this list or set MSG_SELECTOR secret.
  '[data-testid="conversation-message"]',
  '.conversation-message',
  '.message-bubble',
  '.chat-message',
  '.message-row',
  'li[class*="message"]',
  '[class*="messages"] [class*="message"]'
];

function looksLikeChatClass(cls) {
  const c = (cls || '').toLowerCase();
  if (!c) return false;
  if (BLACKLIST.some(b => c.includes(b))) return false;
  // discourage super generic “message” wrappers with no text
  return true;
}

function inferSenderFromClass(cls) {
  const c = (cls || '').toLowerCase();
  if (/(agent|host|staff|team|outgoing|sent|yours|right)/.test(c)) return 'Agent';
  if (/(guest|customer|incoming|received|left|theirs)/.test(c))     return 'Guest';
  return 'Unknown';
}

async function findMessages(page) {
  const contexts = [page, ...page.frames()];
  log(`Searching ${contexts.length} contexts (page + ${contexts.length-1} frames)…`);

  // If we have an exact selector, try it first in all contexts
  if (MSG_SELECTOR) {
    for (const ctx of contexts) {
      const els = await ctx.$$(MSG_SELECTOR);
      const withText = [];
      for (const el of els) {
        const cls = (await el.getAttribute('class')) || '';
        if (!looksLikeChatClass(cls)) continue;
        const txt = ((await el.innerText()) || '').trim();
        if (txt.length > 1) withText.push({ cls, txt });
      }
      if (withText.length) {
        return { nodes: withText, used: MSG_SELECTOR };
      }
    }
  }

  // Otherwise try candidates
  for (const sel of CANDIDATES) {
    let all = [];
    for (const ctx of contexts) {
      const els = await ctx.$$(sel);
      for (const el of els) {
        const cls = (await el.getAttribute('class')) || '';
        if (!looksLikeChatClass(cls)) continue;
        const txt = ((await el.innerText()) || '').trim();
        if (txt.length > 1) all.push({ cls, txt });
      }
    }
    if (all.length) return { nodes: all, used: sel };
  }
  return { nodes: [], used: '(none)' };
}

async function detectStatus(page) {
  const { nodes, used } = await findMessages(page);

  if (nodes.length === 0) {
    log('No message elements with text found (selector used:', used, ')');
    return { isAnswered: false, lastSender: 'Unknown', reason: 'no_selector' };
  }

  // Debug top classes to help us lock the selector later
  const freq = {};
  nodes.forEach(n => { freq[n.cls] = (freq[n.cls] || 0) + 1; });
  const top = Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,5);
  log('TOP MESSAGE CLASSES:', top);

  const last = nodes[nodes.length - 1];
  log('last message debug:', { class: last.cls, textSample: last.txt.slice(0,100) });

  const lastSender = inferSenderFromClass(last.cls);
  return { isAnswered: lastSender === 'Agent', lastSender, reason: 'heuristic', selUsed: used };
}

/* ==== Main ==== */
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const startUrl = argvUrl || 'https://app.boomnow.com/login';
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
  await saveSnapshot(page, 't1');

  await loginIfNeeded(page);
  await saveSnapshot(page, 't2');

  const result = await detectStatus(page);
  log('Second check result:', result);

  if (!result.isAnswered) {
    await sendAlertEmail({ lastSender: result.lastSender, urlForEmail: argvUrl || 'https://app.boomnow.com/' });
  } else {
    log('No alert needed.');
  }

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
