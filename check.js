// check.js
// Robust Boom conversation watcher with artifact saving and resilient selectors.

const { chromium } = require('playwright');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const BOOM_USER = process.env.BOOM_USER;
const BOOM_PASS = process.env.BOOM_PASS;
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = +(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const FROM_NAME = process.env.FROM_NAME || 'Boom SLA Bot';
const TO_EMAIL  = process.env.ROHIT_EMAIL || process.env.TO_EMAIL || SMTP_USER; // fall back to sender

const ART_DIR = '/tmp';
const log = (...a) => console.log(...a);

if (!process.env.CONVERSATION_URL && !process.argv.find(a => a.startsWith('--conversation'))) {
  console.error('Usage: node check.js --conversation "<url>"');
  process.exit(2);
}
const argUrl =
  (process.env.CONVERSATION_URL) ||
  (process.argv.find(a => a.startsWith('--conversation')) || '').split('=')[1];

function artPath(name) { return path.join(ART_DIR, name); }

async function saveArtifacts(page, tag) {
  const shot = artPath(`shot_${tag}.png`);
  const html = artPath(`page_${tag}.html`);
  try { await page.screenshot({ path: shot, fullPage: true }); } catch {}
  try { await fs.promises.writeFile(html, await page.content()); } catch {}
}

async function loginIfNeeded(page) {
  // If we’re on the Boom login page, sign in.
  const isLogin = await page.locator('text=Dashboard Login').first().isVisible().catch(() => false);
  if (!isLogin) return;

  const email = page.locator('input[type="email"], input[name="email"]');
  const pass  = page.locator('input[type="password"], input[name="password"]');
  const btn   = page.locator('button:has-text("Login"), button:has-text("Sign in"), input[type="submit"]');

  await email.fill(BOOM_USER, { timeout: 20000 });
  await pass.fill(BOOM_PASS,   { timeout: 20000 });
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: 30000 }),
    btn.click({ timeout: 10000 })
  ]);
}

async function resolveFinalUrl(context, rawUrl) {
  // Outlook “xwlu9.mjt.lu/lnk/…” → follow to app.boomnow.com
  const page = await context.newPage();
  await page.goto(rawUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // If it redirects in-page via meta/JS, give it a moment
  await page.waitForTimeout(1500);
  const fin = page.url();
  await saveArtifacts(page, 't1');
  await page.close();
  return fin;
}

// Heuristic: scroll and wait for message area to render
async function waitForConversationReady(page) {
  // Wait for any of these hints that the conversation UI is present
  const hints = [
    'text=/Type your message/i',
    'text=/via channel/i',
    'button:has-text("APPROVE")',
    'button:has-text("REJECT")',
    'text=/AI LIVE/i'
  ];
  await page.waitForLoadState('domcontentloaded', { timeout: 45000 });
  for (let i = 0; i < 6; i++) {
    for (const h of hints) {
      if (await page.locator(h).first().isVisible().catch(() => false)) return true;
    }
    // force-load lazy content
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(700);
  }
  return false;
}

// Returns { isAnswered (boolean), lastSender ('Guest'|'Agent'|'Auto'|'Unknown'), snippet, reason, selUsed }
async function getLastMessageInfo(page) {
  // 1) Selector-based attempt
  const selectors = [
    // generic bubbles
    '[class*="message"] [class*="bubble"]',
    '[class*="message"][class*="row"]',
    '[class*="messages"] [class*="message"]',
    '.v-messages__row, .v-messages__wrapper .v-message',
    // common fallbacks
    'div[class*="mb-"][class*="mt-"] div' // very permissive last resort in conversation pane
  ];

  let selUsed = '(none)';
  for (const sel of selectors) {
    const loc = page.locator(sel);
    const count = await loc.count().catch(() => 0);
    if (count >= 1) {
      selUsed = sel;
      // take the last visible node’s text
      const idx = count - 1;
      const text = (await loc.nth(idx).innerText().catch(() => '') || '').trim();
      if (text) {
        // try to infer sender nearby
        const sender = await page.evaluate((selector, index) => {
          const nodes = Array.from(document.querySelectorAll(selector));
          const node = nodes[index];
          if (!node) return 'Unknown';
          // walk up a bit and read nearby labels
          let cur = node;
          let seen = '';
          for (let i = 0; i < 5 && cur; i++) {
            seen += ' ' + (cur.innerText || '');
            cur = cur.parentElement;
          }
          if (/via email\s*·\s*Auto/i.test(seen)) return 'Auto';
          if (/\bAgent\b/i.test(seen)) return 'Agent';
          if (/\bGuest\b/i.test(seen)) return 'Guest';
          return 'Unknown';
        }, sel, idx);

        return {
          isAnswered: sender !== 'Guest', // if last is not Guest, we consider answered
          lastSender: sender,
          snippet: text.slice(0, 180),
          reason: 'selector',
          selUsed
        };
      }
    }
  }

  // 2) Fallback: anchor on 'via channel' and read local neighborhood (very robust on Boom UI)
  const info = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('body *'))
      .filter(n => n.textContent && /via channel/i.test(n.textContent));
    if (!items.length) return null;

    // take the lowest (latest) instance
    items.sort((a, b) => (a.getBoundingClientRect().top - b.getBoundingClientRect().top));
    const last = items[items.length - 1];
    const y = last.getBoundingClientRect().top;

    // collect nearby text above the chip
    const vicinity = Array.from(document.querySelectorAll('body *'))
      .filter(n => {
        const r = n.getBoundingClientRect();
        return r.bottom <= y && r.bottom >= y - 320; // within 320px above
      })
      .map(n => (n.innerText || '').trim())
      .filter(Boolean);

    const joined = vicinity.join('\n');
    // sender inference
    let sender = 'Unknown';
    if (/via email\s*·\s*Auto/i.test(joined)) sender = 'Auto';
    else if (/\bAgent\b/i.test(joined)) sender = 'Agent';
    else if (/\bGuest\b/i.test(joined)) sender = 'Guest';

    // grab the most likely bubble text near the bottom of this window
    let snippet = '';
    for (let i = vicinity.length - 1; i >= 0; i--) {
      const t = vicinity[i];
      if (!/via channel|Agent|Guest|APPROVE|REJECT|CONFIDENCE|AI|Fun Level Changed|TRAIN|via email|Auto/i.test(t)) {
        snippet = t;
        break;
      }
    }
    return {
      isAnswered: sender !== 'Guest',
      lastSender: sender,
      snippet: snippet.slice(0, 180),
      reason: 'geo-heuristic',
      selUsed: 'text=/via channel/i'
    };
  });

  if (info) return info;

  return { isAnswered: true, lastSender: 'Unknown', snippet: '', reason: 'no_selector', selUsed: '(none)' };
}

async function sendAlert({ conversationUrl, lastSender, snippet }) {
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });

  const html = `
    <p>Hi Rohit,</p>
    <p>A Boom guest message appears unanswered after 5 minutes.</p>
    <p><b>Conversation:</b> <a href="${conversationUrl}">Open in Boom</a><br/>
    <b>Last sender detected:</b> ${lastSender}<br/>
    <b>Last message sample:</b> ${snippet ? ('<i>' + snippet + '</i>') : '(none)'}
    </p>
    <p>– Automated alert</p>
  `;

  const info = await transporter.sendMail({
    from: `"${FROM_NAME}" <${SMTP_USER}>`,
    to: TO_EMAIL,
    subject: 'SLA breach (>5 min): Boom guest message unanswered',
    html
  });

  log(`SMTP message id: ${info.messageId}`);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Resolve tracking link to final Boom URL if needed
    const finalUrl = /boomnow\.com/.test(argUrl)
      ? argUrl
      : await resolveFinalUrl(context, argUrl);

    // Go to Boom and login if needed
    await page.goto(finalUrl, { timeout: 60000, waitUntil: 'domcontentloaded' });
    await saveArtifacts(page, 'login');
    await loginIfNeeded(page);

    // Make sure we are on the conversation and messages are rendered
    const ready = await waitForConversationReady(page);
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(()=>{});
    await saveArtifacts(page, 't2');

    const res = await getLastMessageInfo(page);

    // Log for Actions
    log('Second check result:', JSON.stringify({
      ok: !(!res.isAnswered && res.lastSender === 'Guest'), // "ok" means no SLA breach
      reason: res.reason,
      lastSender: res.lastSender,
      selUsed: res.selUsed || '(none)',
      snippet: res.snippet || ''
    }));

    // Decide: send alert only if last is Guest (and thus unanswered)
    if (!res.isAnswered && res.lastSender === 'Guest') {
      await sendAlert({ conversationUrl: finalUrl, lastSender: res.lastSender, snippet: res.snippet });
    } else {
      log('No alert sent (not confident or not guest/unanswered).');
    }
  } catch (e) {
    // Always leave something behind when we crash
    await saveArtifacts(page, 'error');
    console.error(e);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
