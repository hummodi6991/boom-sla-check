// check.js
// Usage: node check.js --conversation "<URL>"

const { chromium } = require('playwright');
const nodemailer = require('nodemailer');
const { URL } = require('url');

const argvUrl = (() => {
  const idx = process.argv.indexOf('--conversation');
  return idx >= 0 ? (process.argv[idx + 1] || '') : '';
})();

/* ==== ENV ==== */
const BOOM_USER   = process.env.BOOM_USER  || '';
const BOOM_PASS   = process.env.BOOM_PASS  || '';
const FROM_NAME   = process.env.FROM_NAME  || 'Oaktree Boom SLA Bot';
const ROHIT_EMAIL = process.env.ROHIT_EMAIL|| '';
const SMTP_HOST   = process.env.SMTP_HOST  || 'smtp.gmail.com';
const SMTP_USER   = process.env.SMTP_USER  || '';
const SMTP_PASS   = process.env.SMTP_PASS  || '';
const SMTP_PORT   = Number(process.env.SMTP_PORT || 465);
const MSG_SELECTOR= process.env.MSG_SELECTOR || ''; // optional: pin exact chat selector once known

const log = (...a) => console.log(...a);

/* ==== URL normalizer: pull the real Boom URL out of trackers ==== */
function extractBoomUrl(raw) {
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.hostname.endsWith('boomnow.com')) return raw;
  } catch (_) {/* not a URL yet */}

  // decode up to 3 times and search for an embedded Boom URL
  let s = raw;
  for (let i = 0; i < 3; i++) {
    try { s = decodeURIComponent(s); } catch(_) {}
  }
  const m = s.match(/https?:\/\/app\.boomnow\.com\/[^\s"'<>]+/i);
  return m ? m[0] : raw;
}

/* ==== artifacts ==== */
async function saveSnapshot(page, tag) {
  const fs = require('fs');
  try {
    await page.screenshot({ path: `/tmp/shot_${tag}.png`, fullPage: true });
    const html = await page.content();
    fs.writeFileSync(`/tmp/page_${tag}.html`, html || '', 'utf8');
    log('Saved artifacts for', tag);
  } catch (e) { log('Artifact save failed:', e.message); }
}

/* ==== email (465 → 587 fallback) ==== */
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
  try { tx = await makeTransport(465, true); await tx.verify(); }
  catch(e){ log('465 SMTPS failed → 587 STARTTLS:', e.message); tx = await makeTransport(587, false); await tx.verify(); }

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

/* ==== login ==== */
async function loginIfNeeded(page) {
  const emailSel = 'input[type="email"], input[name="email"], input[placeholder*="Email" i]';
  const passSel  = 'input[type="password"], input[name="password"], input[placeholder*="Password" i]';
  if (await page.$(emailSel)) {
    log('Login page detected, signing in…');
    await page.fill(emailSel, BOOM_USER);
    await page.fill(passSel,  BOOM_PASS);
    await Promise.all([
      page.click('button:has-text("Login"), button[type="submit"], input[type="submit"]'),
      page.waitForLoadState('networkidle').catch(()=>{})
    ]);
  }
}

/* ==== detection helpers ==== */
const BLACKLIST = [
  'v-messages__wrapper','v-messages__message','snackbar','toast','tooltip','intercom'
];
const CANDIDATES = [
  // put your confirmed selector in MSG_SELECTOR secret to skip guessing
  '[data-testid="message"]',
  '[data-testid*="message"]',
  '.message-bubble','.message-row','.chat-message',
  '[class*="messages"] [class*="message"]',
  'li[role="listitem"]'
];

function badClass(cls){ const c=(cls||'').toLowerCase(); return BLACKLIST.some(b=>c.includes(b)); }
function inferSenderFromClass(cls){
  const c=(cls||'').toLowerCase();
  if (/(agent|host|staff|team|outgoing|sent|yours|right)/.test(c)) return 'Agent';
  if (/(guest|customer|incoming|received|left|theirs)/.test(c))      return 'Guest';
  return 'Unknown';
}

async function scrollDeep(page){
  // try to bring virtualized lists into view
  await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); });
  await page.waitForTimeout(800);
  await page.evaluate(() => { window.scrollTo(0, 0); });
}

async function findMessages(page){
  const contexts = [page, ...page.frames()];
  log(`Searching ${contexts.length} contexts (page + ${contexts.length-1} frames)…`);

  const useSelectors = MSG_SELECTOR ? [MSG_SELECTOR, ...CANDIDATES] : CANDIDATES;
  for (const sel of useSelectors) {
    let found = [];
    for (const ctx of contexts) {
      const els = await ctx.$$(sel);
      for (const el of els) {
        const cls = (await el.getAttribute('class')) || '';
        if (badClass(cls)) continue;
        let txt = '';
        try { txt = (await el.innerText() || '').trim(); } catch {}
        if (txt.length > 1) found.push({ cls, txt });
      }
    }
    if (found.length) return { nodes: found, used: sel };
  }
  return { nodes: [], used: '(none)' };
}

async function detectStatus(page){
  await scrollDeep(page);
  const { nodes, used } = await findMessages(page);
  if (!nodes.length) {
    log('No message elements with text found (selector used:', used, ')');
    return { isAnswered:false, lastSender:'Unknown', reason:'no_selector', selUsed: used };
  }
  const freq = {};
  nodes.forEach(n => { freq[n.cls] = (freq[n.cls] || 0) + 1; });
  log('TOP MESSAGE CLASSES:', Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,5));
  const last = nodes[nodes.length-1];
  log('last message debug:', { class: last.cls, textSample: last.txt.slice(0,100) });
  const lastSender = inferSenderFromClass(last.cls);
  return { isAnswered: lastSender === 'Agent', lastSender, reason:'heuristic', selUsed: used };
}

/* ==== main ==== */
(async () => {
  const browser = await chromium.launch({ headless:true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const normalizedUrl = extractBoomUrl(argvUrl);
  const startUrl = normalizedUrl || 'https://app.boomnow.com/login';
  await page.goto(startUrl, { waitUntil:'domcontentloaded' });
  await saveSnapshot(page, 't1');

  await loginIfNeeded(page);

  // Ensure we’re on the real Boom conversation URL after login
  if (normalizedUrl) {
    await page.goto(normalizedUrl, { waitUntil:'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(()=>{});
  }
  await saveSnapshot(page, 't2');

  const result = await detectStatus(page);
  log('Second check result:', result);

  if (!result.isAnswered) {
    await sendAlertEmail({ lastSender: result.lastSender, urlForEmail: normalizedUrl || 'https://app.boomnow.com/' });
  } else {
    log('No alert needed.');
  }

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
