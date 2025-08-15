// check.js — Node 20+, ESM
import { chromium } from 'playwright';
import nodemailer from 'nodemailer';
import fs from 'fs/promises';
import path from 'path';

const {
  CONVERSATION_URL = '',
  BOOM_USER,
  BOOM_PASS,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  FROM_NAME = 'Boom SLA Bot',
  ROHIT_EMAIL,
} = process.env;

// Required env validation
if (!CONVERSATION_URL) {
  console.error('Missing required env var: CONVERSATION_URL');
  process.exit(2);
}
for (const k of ['BOOM_USER', 'BOOM_PASS', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS']) {
  if (!process.env[k]) {
    console.error(`Missing required env var: ${k}`);
    process.exit(2);
  }
}

const tmp = '/tmp';
const f = (name) => path.join(tmp, name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loginIfNeeded(page) {
  // If we see a login form, perform a simple email+password login
  const looksLikeLogin = await page.locator('input[type="email"], text=/Remember me/i').first().count();
  if (!looksLikeLogin) return false;

  const email = page.locator('input[type="email"]');
  if (await email.count()) await email.fill(BOOM_USER, { timeout: 15000 }).catch(() => {});
  // sometimes you must click Continue first
  const tryClick = async (sel) => {
    const btn = page.locator(sel).first();
    if (await btn.count()) {
      await btn.click({ timeout: 15000 }).catch(() => {});
      return true;
    }
    return false;
  };

  let pw = page.locator('input[type="password"]');
  if (!(await pw.count())) {
    await tryClick('button:has-text("Continue"), button:has-text("Sign in"), button[type="submit"]');
    await page.waitForTimeout(500);
  }
  pw = page.locator('input[type="password"]');
  if (await pw.count()) await pw.fill(BOOM_PASS, { timeout: 15000 }).catch(() => {});
  await tryClick('button:has-text("Sign in"), button:has-text("Log in"), button[type="submit"]');

  await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
  return true;
}

async function ensureConversation(page) {
  // Composer present?
  const composer = page.locator('textarea, [contenteditable="true"]').filter({
    hasText: /Type your message|اكتب رسالتك|Type your message/i
  }).first();
  if (await composer.count()) return true;

  // AI suggestion card present?
  const suggestionCard = page.locator('button:has-text("APPROVE")').first();
  if (await suggestionCard.count()) return true;

  // Any "via …" meta lines?
  const meta = page.locator('text=/\\svia\\s/i').last();
  if (await meta.count()) return true;

  return false;
}

// ---------- NEW: role by layout (left = guest, right = agent) ----------
async function detectLastSender(page) {
  const vw = (await page.viewportSize())?.width || 1280;
  const midX = vw / 2;

  // Collect all visible “via …” meta candidates
  const metas = [];
  const loc = page.locator('text=/\\svia\\s/i');
  const count = await loc.count();
  for (let i = 0; i < count; i++) {
    const el = loc.nth(i);
    const bb = await el.boundingBox().catch(() => null);
    if (!bb) continue;
    metas.push({ el, x: bb.x, y: bb.y, cx: bb.x + bb.width / 2 });
  }

  // Exclude metas that belong to an agent suggestion card (APPROVE/REJECT nearby)
  const approves = [];
  const approveLoc = page.locator('button:has-text("APPROVE")');
  const nA = await approveLoc.count();
  for (let i = 0; i < nA; i++) {
    const bb = await approveLoc.nth(i).boundingBox().catch(() => null);
    if (bb) approves.push(bb);
  }
  const belongsToSuggestion = (y) => approves.some(bb => Math.abs(bb.y - y) <= 450);
  const filtered = metas.filter(m => !belongsToSuggestion(m.y));
  if (!filtered.length) {
    return { lastSender: 'Unknown', hasAgentSuggestion: approves.length > 0, snippet: '' };
  }

  // Latest = highest y on the page
  const latest = filtered.sort((a, b) => a.y - b.y).at(-1);

  // Determine role by horizontal position
  // LEFT of midline -> Guest (incoming), RIGHT -> Agent (outgoing)
  const lastSender = latest.cx < midX ? 'Guest' : 'Agent';

  // Tiny snippet for logging
  let snippet = '';
  try {
    snippet = (await latest.el.textContent() || '').trim().slice(0, 120);
  } catch {}
  return { lastSender, hasAgentSuggestion: approves.length > 0, snippet };
}

async function sendEmail({ subject, html }) {
  // Send to both SMTP_USER and ROHIT_EMAIL if present
  const to = Array.from(new Set([process.env.SMTP_USER, process.env.ROHIT_EMAIL].filter(Boolean))).join(', ');
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  const info = await transporter.sendMail({
    from: `"${FROM_NAME}" <${SMTP_USER}>`,
    to,
    subject,
    html,
  });
  console.log('SMTP message id:', info.messageId);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  console.log('Run node check.js --conversation', JSON.stringify(CONVERSATION_URL));
  await page.goto(CONVERSATION_URL, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
  await page.waitForLoadState('domcontentloaded', { timeout: 25000 }).catch(() => {});
  await sleep(800);

  // First artifacts
  await page.screenshot({ path: f('shot_t1.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(f('page_t1.html'), await page.content());

  const didLogin = await loginIfNeeded(page);
  if (didLogin) console.log('Login page detected, signing in…');

  if (/\/login\b/i.test(page.url())) {
    // Navigate back to the conversation after auth
    await page.goto(CONVERSATION_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
  }
  console.log('Resolved Boom URL:', page.url());
  await sleep(1200);

  const inConversation = await ensureConversation(page);

  // Second artifacts
  await page.screenshot({ path: f('shot_t2.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(f('page_t2.html'), await page.content());

  const result = {
    ok: false,
    lastSender: 'Unknown',
    reason: inConversation ? 'heuristic' : 'not_conversation',
    snippet: '',
    hasAgentSuggestion: false,
    ts: new Date().toISOString(),
  };

  if (inConversation) {
    const det = await detectLastSender(page);
    result.lastSender = det.lastSender;
    result.snippet = det.snippet;
    result.hasAgentSuggestion = det.hasAgentSuggestion;
    // ALERT RULE: last visible message is from Guest (unanswered by a human)
    result.ok = det.lastSender === 'Guest';
  }

  console.log('Second check result:', JSON.stringify(result, null, 2));

  if (result.ok) {
    const subj = 'SLA breach (>5 min): Boom guest message unanswered';
    const link = page.url();
    const html = `
      <div style="font:14px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
        <p>Hi Rohit,</p>
        <p>A Boom guest message appears unanswered after 5 minutes.</p>
        <p><b>Conversation:</b> <a href="${link}">Open in Boom</a><br/>
           <b>Last sender detected:</b> Guest<br/>
           <b>Last message sample:</b> ${result.snippet || '(n/a)'}
        </p>
        <p style="color:#999">– Automated alert</p>
      </div>
    `;
    await sendEmail({ subject: subj, html }).catch((e) => console.error('Email send failed:', e?.message || e));
  } else {
    console.log('No alert sent (not confident or not guest/unanswered).');
  }

  await browser.close();
})();
