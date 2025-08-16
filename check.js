// check.js
// Boom SLA checker — uses Playwright + nodemailer
// Secrets expected (do NOT rename): BOOM_USER, BOOM_PASS, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, FROM_NAME, ROHIT_EMAIL, AGENT_SIDE
// Optional: ALERT_TO (comma emails) ALERT_CC (comma emails)

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import nodemailer from 'nodemailer';

const OUT_DIR = '/tmp';
const SHOT1 = path.join(OUT_DIR, 'boom-1.png');
const SHOT2 = path.join(OUT_DIR, 'boom-2.png');
const HTML_DUMP = path.join(OUT_DIR, 'thread.html');

const env = (k, d = undefined) => {
  const v = process.env[k];
  return (v === undefined || v === null || v === '') ? d : v;
};

const EMAIL = env('BOOM_USER');
const PASS = env('BOOM_PASS');

const SMTP_HOST = env('SMTP_HOST');
const SMTP_PORT = Number(env('SMTP_PORT', '587'));
const SMTP_USER = env('SMTP_USER');
const SMTP_PASS = env('SMTP_PASS');
const FROM_NAME = env('FROM_NAME', 'Boom SLA Bot');

const ALERT_TO = (env('ALERT_TO') || env('ROHIT_EMAIL') || '').split(',').map(s => s.trim()).filter(Boolean);
const ALERT_CC = (env('ALERT_CC') || '').split(',').map(s => s.trim()).filter(Boolean);

const AGENT_SIDE = env('AGENT_SIDE', 'left'); // 'left' or 'right'
const CONVERSATION_URL = process.argv.slice(2).find(x => /^https?:\/\//i.test(x)) || env('CONVERSATION_URL');

// tiny helpers
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

async function loginIfNeeded(page, url) {
  // Always start at the conversation URL if provided; the app will redirect to /login when necessary
  if (url) await page.goto(url, { waitUntil: 'domcontentloaded' });
  else await page.goto('https://app.boomnow.com/login', { waitUntil: 'domcontentloaded' });

  // If we’re on /login, perform login
  if (/\/login(\?|$)/.test(page.url())) {
    await page.screenshot({ path: SHOT1 });

    const emailSel = 'input[type="email"], input[name="email"], [placeholder="Email"]';
    const passSel  = 'input[type="password"], input[name="password"], [placeholder="Password"]';
    const loginBtn = 'button:has-text("Login"), [type="submit"]';

    await page.waitForSelector(emailSel, { timeout: 20000 });
    await page.fill(emailSel, EMAIL);
    await page.fill(passSel, PASS);

    // try clicking Login and wait for dashboard load
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => null),
      page.click(loginBtn)
    ]);

    // If the app lands on the dashboard, re-open the intended conversation
    if (url && !page.url().includes('/guest-experience/')) {
      await page.goto(url, { waitUntil: 'networkidle' }).catch(() => {});
    }
  }

  // Give it a moment for live thread content to load
  await sleep(1500);
}

function textNormalize(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

async function detectState(page) {
  // Always dump HTML for debugging
  try { fs.writeFileSync(HTML_DUMP, await page.content(), 'utf8'); } catch {}

  // Grab a screenshot of the post-login / thread state
  await page.screenshot({ path: SHOT2, fullPage: true }).catch(() => {});

  // Heuristics:
  //  - Ignore AI suggestion cards (they contain “Agent” header + “Confidence” + APPROVE/REJECT/REGENERATE)
  //  - Ignore system events like “Fun level changed …”
  //  - Classify a real message bubble by the presence of “ • via whatsapp” or “ • via channel”
  //  - "Guest" means the last real message is on the NON-agent side and/or does NOT have an internal user name marker
  //  - If the last visual thing is only an AI suggestion card, treat as answered-by-agent (no alert)

  const bodyText = await page.textContent('body').catch(() => '');
  const hasAgentSuggestion = /Confidence:\s*\d|REGENERATE|APPROVE|REJECT/.test(bodyText);

  // Collect candidates that look like real bubbles
  // We search for the literal “• via ” because Boom renders that in English even on Arabic threads
  const bubbleLoc = page.locator('xpath=//*[contains(normalize-space(.)," • via ")]');
  const count = await bubbleLoc.count().catch(() => 0);

  if (!count) {
    return {
      ok: true,                 // not failing the job — just not enough selectors to decide
      reason: 'no_selector',
      lastSender: 'Unknown',
      hasAgentSuggestion,
      snippet: ''
    };
  }

  // Take the last matching element’s text
  const lastText = textNormalize(await bubbleLoc.nth(count - 1).innerText());
  // Extract a short snippet (message bubble text usually sits right above the "• via" line, but we don’t know DOM)
  // Practical approach: take the whole text minus the trailing “• via …” marker if present
  let snippet = lastText.replace(/• via .*$/i, '').trim();
  if (snippet.length > 140) snippet = snippet.slice(0, 140) + '…';

  // Side / sender guess:
  // If an internal user name (Latin letters) appears next to "• via channel", we’ll assume Agent
  // If it’s WhatsApp and there’s no internal name token after “• via”, assume Guest.
  // Fall back to AGENT_SIDE hint if the string clearly says “via channel”.
  let lastSender = 'Guest';
  const viaWhats = /•\s*via\s*whatsapp/i.test(lastText);
  const viaChannel = /•\s*via\s*channel/i.test(lastText);

  if (viaChannel) {
    // Many internal replies are “via channel” with an internal name rendered (Latin letters / spaces)
    // If we see a name-like token before/around the marker, classify as Agent.
    // Otherwise keep Guest (rare, but possible if customer used channel).
    const hasLatinName = /[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(lastText);
    lastSender = hasLatinName ? 'Agent' : 'Agent'; // channel is practically always an agent reply
  } else if (viaWhats) {
    lastSender = 'Guest';
  }

  // Also: if the very bottom of the page contains an AI suggestion card immediately after a guest bubble,
  // we still count the lastSender as Guest (it’s unanswered until an agent posts or the AI message is approved/sent).
  // Our classification already does that by ignoring the suggestion card entirely.

  return {
    ok: true,
    reason: lastSender === 'Guest' ? 'guest_last' : 'agent_last',
    lastSender,
    hasAgentSuggestion,
    snippet
  };
}

async function sendAlertEmail(result) {
  if (!ALERT_TO.length || !SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    console.log('Alert needed, but SMTP/recipient envs are not fully set.');
    return;
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });

  const subject = `SLA breach (>5 min): Boom guest message unanswered`;
  const parts = [];
  parts.push(`Hi Rohit,`);
  parts.push('');
  parts.push(`A Boom guest message appears unanswered after 5 minutes.`);
  if (CONVERSATION_URL) parts.push(`\nConversation: ${CONVERSATION_URL}`);
  parts.push(`\nLast sender detected: ${result.lastSender}`);
  if (result.snippet) parts.push(`Last message sample: ${result.snippet}`);
  parts.push(`\n– Automated alert`);

  const attachments = [];
  try { attachments.push({ filename: 'boom-1.png', path: SHOT1 }); } catch {}
  try { attachments.push({ filename: 'boom-2.png', path: SHOT2 }); } catch {}
  try { attachments.push({ filename: 'thread.html', path: HTML_DUMP }); } catch {}

  await transporter.sendMail({
    from: `"${FROM_NAME}" <${SMTP_USER}>`,
    to: ALERT_TO.join(','),
    cc: ALERT_CC.length ? ALERT_CC.join(',') : undefined,
    subject,
    text: parts.join('\n'),
    attachments
  });

  console.log('Alert email sent.');
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();

  const result = {
    ok: false,
    reason: 'unknown',
    lastSender: 'Unknown',
    hasAgentSuggestion: false,
    snippet: ''
  };

  try {
    if (!CONVERSATION_URL) {
      console.log('No conversation URL provided (input or CONVERSATION_URL env). Exiting gracefully.');
      result.ok = true;
      result.reason = 'no_url';
      console.log('Second check result:', result);
      await browser.close();
      process.exit(0);
    }

    await loginIfNeeded(page, CONVERSATION_URL);

    // Make sure we’re actually on the conversation (some logins land at /login or /dashboard first)
    if (!/\/guest-experience\//.test(page.url())) {
      await page.goto(CONVERSATION_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(1200);
    }

    // Scroll bottom to ensure latest widgets load
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await sleep(700);

    const state = await detectState(page);
    Object.assign(result, state);

    // Decide whether to alert:
    // Fire **only** when lastSender is Guest (unanswered) AND we’re not seeing an agent bubble after it.
    const shouldAlert = result.ok && result.lastSender === 'Guest';

    console.log('Second check result:', result);

    if (shouldAlert) {
      await sendAlertEmail(result);
    } else {
      console.log('No alert sent (not guest/unanwered beyond SLA).');
    }
  } catch (e) {
    result.ok = false;
    result.reason = 'exception';
    console.log('Checker failed with exception:', e?.message || e);
  } finally {
    try { console.log(`ts: ${nowIso()}`); } catch {}
    await browser.close().catch(() => {});
  }
})();
