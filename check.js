// Robust Boom SLA checker with resilient login and safe fallbacks.
// Uses new secrets: BOOM_USER, BOOM_PASS, SMTP_*, ALERT_FROM_NAME, ALERT_TO, AGENT_SIDE

import { chromium } from 'playwright';
const nodemailer = require('nodemailer');

// ---------- config ----------
const argvConversation = process.argv
  .find(a => a.startsWith('--conversation='))?.split('=')[1];
const CONVERSATION_URL = argvConversation || process.env.CONVERSATION_URL;

if (!CONVERSATION_URL) {
  console.error('Missing conversation URL. Pass --conversation=<url> or set CONVERSATION_URL.');
  process.exit(2);
}

const AGENT_SIDE = (process.env.AGENT_SIDE || 'right').toLowerCase(); // 'right' or 'left'

const BOOM_USER = process.env.BOOM_USER || '';
const BOOM_PASS = process.env.BOOM_PASS || '';

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const FROM_NAME = process.env.ALERT_FROM_NAME || 'Oaktree Boom SLA Bot';
const ALERT_TO = (process.env.ALERT_TO || '').split(',').map(s => s.trim()).filter(Boolean);

if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || ALERT_TO.length === 0) {
  console.error('Missing SMTP_* or ALERT_TO secrets. Configure SMTP_HOST/PORT/USER/PASS and ALERT_TO.');
  process.exit(2);
}

// ---------- helpers ----------
async function sendEmail({ subject, html }) {
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465, // true only for 465
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  await transporter.sendMail({
    from: `"${FROM_NAME}" <${SMTP_USER}>`,
    to: ALERT_TO.join(','),
    subject,
    html,
  });
}

async function saveArtifacts(page, tag) {
  try {
    await page.screenshot({ path: `/tmp/shot_${tag}.png`, fullPage: true });
    const html = await page.content();
    require('fs').writeFileSync(`/tmp/page_${tag}.html`, html, 'utf8');
  } catch {}
}

function anyFrameLocator(page, selector) {
  const all = [page.locator(selector), ...page.frames().map(f => f.locator(selector))];
  return {
    async firstVisible(timeout = 8000) {
      for (const l of all) {
        try {
          await l.first().waitFor({ state: 'visible', timeout });
          return l.first();
        } catch {}
      }
      throw new Error(`Not found: ${selector}`);
    }
  };
}

async function loginIfNeeded(page) {
  // Decide whether login is needed by URL or presence of typical fields
  await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  const url = page.url();
  const looksLikeLogin = /\/login\b/i.test(url) || /auth\./i.test(new URL(url).host);

  let hasMarkers = false;
  try {
    hasMarkers = await page.evaluate(() => {
      const pick = s => document.querySelector(s);
      return !!(
        pick('input[type="email"]') ||
        pick('input[name="email"]') ||
        pick('input[name="username"]') ||
        pick('#email') ||
        pick('input[type="password"]') ||
        pick('#password') ||
        pick('button[type="submit"]') ||
        pick('button:has-text("Login")')
      );
    });
  } catch {}

  if (!looksLikeLogin && !hasMarkers) {
    console.log('Login not required.');
    return false;
  }

  if (!BOOM_USER || !BOOM_PASS) {
    console.warn('BOOM_USER/BOOM_PASS not set. Skipping login.');
    return false;
  }

  console.log('Login page detected, signing in…');

  const emailSel = [
    'input[type="email"]',
    'input[name="email"]',
    'input[name="username"]',
    '#email',
    'input[autocomplete="username"]'
  ].join(', ');

  const passSel = [
    'input[type="password"]',
    'input[name="password"]',
    '#password',
    'input[autocomplete="current-password"]'
  ].join(', ');

  const submitSel = [
    'button:has-text("Login")',
    'button:has-text("Sign in")',
    'button[type="submit"]',
    'input[type="submit"]',
    '.v-btn--has-bg'
  ].join(', ');

  try {
    const email = await anyFrameLocator(page, emailSel).firstVisible(10000);
    await email.fill(BOOM_USER, { timeout: 8000 });

    const pass = await anyFrameLocator(page, passSel).firstVisible(8000);
    await pass.fill(BOOM_PASS, { timeout: 8000 });

    const submit = await anyFrameLocator(page, submitSel).firstVisible(8000);
    await Promise.all([
      page.waitForLoadState('networkidle').catch(() => {}),
      submit.click({ timeout: 8000 }),
    ]);

    await page.waitForURL(/app\.boomnow\.com\/(dashboard|guest-experience)/, { timeout: 20000 }).catch(() => {});
    console.log('Login finished.');
    return true;
  } catch (e) {
    console.warn('Login sequence skipped (selectors not found or timed out):', e.message);
    return false;
  }
}

async function getLastMessageInfo(page) {
  await saveArtifacts(page, 't2');

  const blocks = page.locator([
    '.v-messages__wrapper',
    'div[class*="message"]',
    'div[class*="bubble"]',
    'div[class*="mt-"]',
    'div[class*="mb-"]'
  ].join(', '));

  const count = await blocks.count().catch(() => 0);
  if (!count) return { ok: false, reason: 'no_text', lastSender: 'Unknown', snippet: '' };

  for (let i = count - 1; i >= 0; i--) {
    const el = blocks.nth(i);
    const text = (await el.innerText().catch(() => '')).trim();

    if (!text) continue;
    if (/fun level changed/i.test(text)) continue;
    if (/Approve|Reject|Regenerate|Confidence/i.test(text)) continue;

    // Side heuristic
    let lastSender = 'Unknown';
    try {
      const box = await el.boundingBox().catch(() => null);
      if (box) {
        const centerX = box.x + box.width / 2;
        const vw = (await page.viewportSize())?.width || 1280;
        const isRight = centerX > (vw / 2);
        lastSender = (AGENT_SIDE === 'right')
          ? (isRight ? 'Agent' : 'Guest')
          : (isRight ? 'Guest' : 'Agent');
      }
    } catch {}

    if (lastSender === 'Unknown') {
      const html = (await el.innerHTML().catch(() => '')).toLowerCase();
      if (html.includes('via channel') || html.includes('agent')) lastSender = 'Agent';
      if (html.includes('via whatsapp') || html.includes('guest')) lastSender = 'Guest';
    }

    return { ok: true, lastSender, snippet: text.slice(0, 200) };
  }

  return { ok: false, reason: 'no_text', lastSender: 'Unknown', snippet: '' };
}

// ---------- main ----------
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  try {
    await page.goto(CONVERSATION_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await loginIfNeeded(page);
    await page.waitForURL(/app\.boomnow\.com\/dashboard\/guest-experience\//, { timeout: 15000 }).catch(() => {});

    const info = await getLastMessageInfo(page);
    console.log('Second check result:', info);

    // Fire alert when last sender appears to be Guest
    const shouldAlert = info.ok && info.lastSender === 'Guest';

    if (shouldAlert) {
      const subject = 'SLA breach (>5 min): Boom guest message unanswered';
      const html = `
        <p>Hi all,</p>
        <p>A Boom guest message appears unanswered after 5 minutes.</p>
        <p><b>Conversation:</b> <a href="${CONVERSATION_URL}">Open in Boom</a></p>
        <p><b>Last sender detected:</b> ${info.lastSender}</p>
        <p><b>Last message sample:</b><br><i>${(info.snippet || '').replace(/\n/g, '<br>')}</i></p>
        <p>– Automated alert</p>
      `;
      await sendEmail({ subject, html });
      console.log('Alert email sent.');
    } else {
      console.log('No alert sent (not guest or no message).');
    }
  } catch (err) {
    console.error('Fatal error:', err);
    await saveArtifacts(page, 'error');
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
