// check.js — ESM
// Node >=18, "type": "module" in package.json

import { chromium } from 'playwright';
import fs from 'fs/promises';
import nodemailer from 'nodemailer';

// ---------- Env (kept exactly as you have them) ----------
const {
  BOOM_USER,
  BOOM_PASS,
  ALERT_TO,           // comma-separated list of recipients
  ALERT_FROM_NAME,    // display name for from:
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  AGENT_SIDE          // "left" or "right" if you ever need it; unused here
} = process.env;

// Conversation URL from CLI or env
function getConversationUrl() {
  const i = process.argv.indexOf('--conversation');
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  if (process.env.CONVERSATION_URL) return process.env.CONVERSATION_URL;
  return null;
}

// ---------- Email ----------
async function sendAlertEmail({ subject, html }) {
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS || !ALERT_TO) {
    console.log('Alert needed, but SMTP/recipient envs are not fully set.');
    return;
    // Intentionally not throwing; the run should still succeed.
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465, // common default
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });

  const fromName = ALERT_FROM_NAME || 'Boom SLA Bot';
  const toList = ALERT_TO.split(',').map(s => s.trim()).filter(Boolean);

  await transporter.sendMail({
    from: `"${fromName}" <${SMTP_USER}>`,
    to: toList.join(', '),
    subject,
    html
  });
}

// ---------- Auth ----------
async function loginIfNeeded(page) {
  // If we land on login, fill and submit.
  // We look for a visible email input to decide.
  const maybeEmail = page.locator('input[type="email"], input[name*="email" i]');
  if (await maybeEmail.first().isVisible().catch(() => false)) {
    if (!BOOM_USER || !BOOM_PASS) {
      throw new Error('Missing BOOM_USER/BOOM_PASS for login.');
    }
    await maybeEmail.first().fill(BOOM_USER);
    const pwd = page.locator('input[type="password"], input[name*="pass" i]');
    await pwd.first().fill(BOOM_PASS);
    const submit = page.getByRole('button', { name: /sign in|log in|login/i }).first();
    if (await submit.isVisible().catch(() => false)) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}),
        submit.click()
      ]);
    } else {
      await page.keyboard.press('Enter');
      await page.waitForLoadState('networkidle').catch(() => {});
    }
  }
}

// ---------- Analysis ----------
/**
 * Detect last real message (with "via whatsapp" or "via channel"),
 * and whether there is an unapproved AI suggestion card (APPROVE/REJECT)
 * beneath it. We avoid page.evaluate/querySelector completely.
 */
async function analyzeConversation(page) {
  await page.waitForLoadState('domcontentloaded');
  // Give the UI a moment to finish lazy rendering
  await page.waitForTimeout(800);

  // 1) Find all message-like bubbles (guest or human agent) by the "via ..." tag.
  const msgLocator = page.locator('div', { hasText: /via\s+(whatsapp|channel)/i });

  const count = await msgLocator.count();
  const candidates = [];
  for (let i = 0; i < count; i++) {
    const el = msgLocator.nth(i);
    const text = (await el.innerText().catch(() => '')) || '';
    const bb = await el.boundingBox().catch(() => null);
    const sender = /train\b/i.test(text) ? 'Agent' : 'Guest'; // heuristic: Boom shows "TRAIN" on agent items
    candidates.push({
      idx: i,
      sender,
      snippet: text.trim().slice(0, 260),
      y: bb?.y ?? null,
      h: bb?.height ?? null
    });
  }

  // Last visible "real" message:
  let last = null;
  if (candidates.length) {
    // Sort by y, take the lowest on the page
    candidates.sort((a, b) => (a.y ?? 0) - (b.y ?? 0));
    last = candidates[candidates.length - 1];
  }

  // 2) Detect any visible AI suggestion card(s): blocks that contain both REJECT and APPROVE buttons.
  const approveBtn = page.getByRole('button', { name: /^APPROVE$/i });
  const rejectBtn  = page.getByRole('button', { name: /^REJECT$/i });

  // We want the container that *has both* buttons.
  const suggestionCard = page.locator('div')
    .filter({ has: approveBtn })
    .filter({ has: rejectBtn });

  const hasSuggestion = (await suggestionCard.count().catch(() => 0)) > 0;

  // If there are multiple, use the lowest on the page (most recent card).
  let sugY = null;
  if (hasSuggestion) {
    const bb = await suggestionCard.last().boundingBox().catch(() => null);
    sugY = bb?.y ?? null;
  }

  // 3) Build result
  let lastSender = 'Unknown';
  let snippet = '';
  let reason = 'unknown';

  if (!last) {
    reason = 'no_selector';
  } else {
    lastSender = last.sender;
    snippet = last.snippet;

    // Consider a guest unanswered when:
    // - the last real bubble is from Guest
    // - and there's no suggestion card below it (i.e., no pending AI reply)
    const suggestionBelow =
      hasSuggestion && last.y != null && sugY != null && sugY > last.y + (last.h ?? 0) - 2;

    if (last.sender === 'Guest' && !suggestionBelow) {
      reason = 'guest_unanswered';
    } else if (last.sender === 'Guest' && suggestionBelow) {
      reason = 'ai_suggested';
    } else {
      reason = 'agent_last';
    }
  }

  // "ok: true" means no alert needed; "ok: false" means alert.
  const ok = !(lastSender === 'Guest' && reason === 'guest_unanswered');

  // Write a rich debug dump for artifacts
  const debug = {
    candidates,
    last,
    hasSuggestion,
    sugY
  };
  await fs.writeFile('/tmp/boom-nodes.json', JSON.stringify(debug, null, 2)).catch(() => {});

  return { ok, reason, lastSender, hasAgentSuggestion: hasSuggestion, snippet };
}

// ---------- Main ----------
(async () => {
  const url = getConversationUrl();
  if (!url) {
    console.error('Missing conversation URL. Pass --conversation "<url>" or set CONVERSATION_URL.');
    process.exit(2);
  }

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage();

  // Navigate — the link might redirect through login first
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await loginIfNeeded(page);
  // If the login bounced us to a general page, try to go to the URL again
  if (!page.url().includes('/dashboard/')) {
    await page.goto(url, { waitUntil: 'networkidle' }).catch(() => {});
  }
  await page.waitForTimeout(600); // small settle

  // Analyze
  const result = await analyzeConversation(page);
  console.log('Second check result:', JSON.stringify(result, null, 2));

  // Screens & HTML for artifacts
  try {
    await page.screenshot({ path: '/tmp/boom-shot.png', fullPage: true });
    await fs.writeFile('/tmp/boom-page.html', await page.content());
  } catch {}

  // Decide + email
  if (!result.ok) {
    // Compose a compact email
    const subject = `SLA breach? Guest message unanswered`;
    const html = `
      <p>A Boom guest message may be unanswered beyond SLA.</p>
      <p><strong>Last sender:</strong> ${result.lastSender}</p>
      <p><strong>Reason:</strong> ${result.reason}</p>
      <p><strong>Snippet:</strong> ${result.snippet || '(none)'} </p>
      <p><a href="${url}">Open in Boom</a></p>
      <hr/>
      <p>– Automated alert</p>
    `;
    await sendAlertEmail({ subject, html });
  } else {
    console.log('No alert sent (not guest/unanswered).');
  }

  await browser.close();
})().catch(err => {
  console.error(err);
  process.exit(1);
});
