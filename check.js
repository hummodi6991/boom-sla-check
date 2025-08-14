// check.js
// Robust checker: resolves tracking links, logs in, opens Messages, decides if guest is unanswered, emails if needed.
// Save debug artifacts whenever we're not confident.

const { chromium } = require('playwright');
const nodemailer = require('nodemailer');
const fs = require('fs/promises');
const path = require('path');
const { URL } = require('url');

const BOOM_USER = process.env.BOOM_USER;
const BOOM_PASS = process.env.BOOM_PASS;
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || '587');
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const FROM_NAME = process.env.FROM_NAME || 'Oaktree Boom SLA Bot';
const TO_EMAILS = (process.env.TO_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean);
const DEBUG_ON_UNSURE = (process.env.DEBUG_ON_UNSURE || 'true').toLowerCase() === 'true';

if (!BOOM_USER || !BOOM_PASS) {
  console.error('Missing BOOM_USER / BOOM_PASS');
  process.exit(1);
}

const argv = process.argv.join(' ');
const rawArg = /--conversation\s+("([^"]+)"|'([^']+)'|(\S+))/.exec(argv);
if (!rawArg) {
  console.error('Missing --conversation argument');
  process.exit(1);
}
const conversationInput = rawArg[2] || rawArg[3] || rawArg[4];

function nowTag() {
  const d = new Date();
  return `${d.getHours()}${String(d.getMinutes()).padStart(2,'0')}${String(d.getSeconds()).padStart(2,'0')}`;
}

async function saveDebug(page, tag) {
  const png = `/tmp/shot_${tag}.png`;
  const html = `/tmp/page_${tag}.html`;
  try {
    await page.screenshot({ path: png, fullPage: true });
  } catch {}
  try {
    await fs.writeFile(html, await page.content(), 'utf8');
  } catch {}
}

async function resolveTrackingLink(context, url) {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith('boomnow.com')) return url; // already final
  } catch {
    // if it's not a valid URL, just return as-is (Playwright will try)
    return url;
  }

  // Open in a lightweight page and let redirects happen until we land on app.boomnow.com
  const page = await context.newPage();
  await page.route('**/*', route => route.continue()); // just in case
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // Some trackers show an interstitial; wait for a navigation or a URL change
  for (let i = 0; i < 5; i++) {
    const cur = page.url();
    try {
      const u = new URL(cur);
      if (u.hostname.endsWith('boomnow.com')) {
        const finalUrl = cur;
        await saveDebug(page, `login_${nowTag()}`); // snapshot of where we landed
        await page.close();
        return finalUrl;
      }
    } catch {}
    // give the tracker a moment to push us
    await page.waitForTimeout(1500);
  }

  const finalUrl = page.url();
  await saveDebug(page, `login_${nowTag()}`);
  await page.close();
  return finalUrl;
}

async function ensureLoggedIn(page) {
  const url = page.url();
  if (/boomnow\.com/i.test(url) && !/login/i.test(url)) return;

  // Fill Boom login form
  try {
    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 15_000 });
  } catch {
    // if the resolved URL is already inside the app, bail
    return;
  }

  const emailSel = 'input[type="email"], input[name="email"]';
  const passSel  = 'input[type="password"], input[name="password"]';
  const buttonSel = 'button:has-text("Login"), button[type="submit"]';

  await page.fill(emailSel, BOOM_USER);
  await page.fill(passSel, BOOM_PASS);
  await Promise.all([
    page.click(buttonSel),
    page.waitForNavigation({ waitUntil: 'networkidle', timeout: 60_000 }).catch(()=>{})
  ]);
}

async function openMessagesIfNeeded(page) {
  // Heuristic: if message composer is present, we are already in conversation view.
  const composer = await page.$('textarea[placeholder*="Type"], textarea, [contenteditable="true"]');
  if (composer) return true;

  // Try clicking a "Messages" tab or icon if present
  const tabSelectors = [
    'div[role="tab"]:has-text("Messages")',
    'button:has-text("Messages")',
    'a:has-text("Messages")'
  ];
  for (const sel of tabSelectors) {
    const el = await page.$(sel);
    if (el) {
      await Promise.all([
        el.click(),
        page.waitForLoadState('networkidle').catch(()=>{})
      ]);
      const again = await page.$('textarea, [contenteditable="true"]');
      if (again) return true;
    }
  }
  return false;
}

async function sampleLastBubble(page) {
  // Try to find message bubbles. Narrow selectors first, then fallbacks.
  const selectors = [
    // likely message feed containers
    '[class*="message"]',
    '[data-test*="message"]',
    '.v-messages__wrapper .message, .message, div[class*="bubble"]'
  ];

  for (const sel of selectors) {
    const nodes = await page.$$(`${sel}`);
    if (nodes.length) {
      // pull last non-empty node text
      for (let i = nodes.length - 1; i >= 0; i--) {
        const text = (await nodes[i].innerText()).trim();
        if (text) {
          // Identify sender by nearby labels
          const box = await nodes[i].boundingBox().catch(()=>null);
          let sender = 'Unknown';
          try {
            // Look slightly above the bubble for "Guest" / "Agent" words in English/Arabic.
            const snippet = text.slice(0, 160).replace(/\s+/g, ' ');
            // lightweight heuristic: if composer exists we are in a 1:1 thread; try to see if bubble has role or class
            const cls = await nodes[i].getAttribute('class') || '';
            if (/(guest|from-guest)/i.test(cls)) sender = 'Guest';
            if (/(agent|from-agent|staff)/i.test(cls)) sender = 'Agent';
            return { textSample: snippet, sender, foundBy: sel };
          } catch {}
        }
      }
    }
  }

  // Geo heuristic: when we fail to grab bubbles, pull any left-column thread body text that’s clearly not the tab strip.
  const bodyFallback = await page.innerText('body').catch(()=> '');
  const fallbackSample = (bodyFallback || '').slice(0, 160).replace(/\s+/g,' ');
  return { textSample: fallbackSample, sender: 'Unknown', foundBy: '(none)' };
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // 1) Resolve final Boom URL from the email tracking link (if needed)
  const resolvedUrl = await resolveTrackingLink(context, conversationInput);
  console.log(`Resolved Boom URL: ${resolvedUrl}`);

  // 2) Go there and login if required
  await page.goto(resolvedUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(()=>{});
  await ensureLoggedIn(page);

  // Wait until we are inside Boom app
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(()=>{});

  // 3) Make sure we’re on the conversation and Messages are visible
  const inMessages = await openMessagesIfNeeded(page);
  const tag = nowTag();
  if (!inMessages) {
    await saveDebug(page, `t2_${tag}`);
    console.log(`Second check result: { ok: false, reason: 'no_selector', lastSender: 'Unknown', snippet: '' }`);
    console.log('No alert sent (not confident or not guest/unanswered).');
    await browser.close();
    return;
  }

  // 4) Sample the last visible bubble
  const sample = await sampleLastBubble(page);
  await saveDebug(page, `t2_${tag}`);

  // Decision rule:
  // - If we cannot determine a sender confidently OR it looks like a guest and there's no agent reply, alert.
  //   (You can tighten/loosen as needed.)
  let isGuestUnanswered = false;
  if (sample.sender === 'Guest') isGuestUnanswered = true;
  if (sample.sender === 'Unknown' && DEBUG_ON_UNSURE) isGuestUnanswered = true;

  const result = {
    isAnswered: !isGuestUnanswered,
    lastSender: sample.sender,
    reason: sample.foundBy === '(none)' ? 'heuristic' : 'selector',
    selUsed: sample.foundBy,
    snippet: sample.textSample
  };

  console.log('Second check result:', result);

  if (!isGuestUnanswered) {
    console.log('No alert sent (conversation appears answered or not a guest message).');
    await browser.close();
    return;
  }

  // 5) Send email alert
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || TO_EMAILS.length === 0) {
    console.log('Email not configured; skipping send.');
    await browser.close();
    return;
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });

  const subject = 'SLA breach (>5 min): Boom guest message unanswered';
  const html = `
    <p>Hi Rohit,</p>
    <p>A Boom guest message appears unanswered after 5 minutes.</p>
    <p>Conversation: <a href="${resolvedUrl}">Open in Boom</a><br/>
       Last sender detected: <b>${sample.sender}</b><br/>
       Last message sample: <i>${sample.textSample || '(none)'} </i>
    </p>
    <p>– Automated alert</p>
  `;

  const info = await transporter.sendMail({
    from: `"${FROM_NAME}" <${SMTP_USER}>`,
    to: TO_EMAILS.join(', '),
    subject,
    html
  });
  console.log(`SMTP message id: ${info.messageId}`);

  await browser.close();
}

main().catch(async err => {
  console.error(err);
  process.exit(1);
});
