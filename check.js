// check.js  (ESM)
// Run with: node check.js --conversation "<Boom conversation URL>"

import { chromium } from 'playwright';
import nodemailer from 'nodemailer';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ----- ENV & ARGUMENTS -------------------------------------------------------
const {
  BOOM_USER,
  BOOM_PASS,
  AGENT_SIDE,        // e.g., "en" or "ar" if you use it to switch sides
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  FROM_NAME,
  ROHIT_EMAIL,
  CONVERSATION_URL,  // optional: if your workflow exports it
} = process.env;

function getArg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const conversationArg = getArg('--conversation');
const convoURL = conversationArg || CONVERSATION_URL;
if (!convoURL) {
  console.error('Missing conversation URL. Pass --conversation "<url>" or set CONVERSATION_URL.');
  process.exit(2);
}

// ----- MAILER ----------------------------------------------------------------
function buildTransport() {
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    console.error('Missing SMTP_* secrets. Please set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS.');
    process.exit(2);
  }
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465, // true for 465, false otherwise
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

async function sendAlert({ link, lastSender, snippet }) {
  const transporter = buildTransport();
  const fromName = FROM_NAME || 'Oaktree Boom SLA Bot';
  const toList = [SMTP_USER, ROHIT_EMAIL].filter(Boolean).join(', ');

  const subject = 'SLA breach (>5 min): Boom guest message unanswered';
  const html = `
    <p>Hi Rohit,</p>
    <p>A Boom guest message appears unanswered after 5 minutes.</p>
    <p><b>Conversation:</b> <a href="${link}">Open in Boom</a></p>
    <p><b>Last sender detected:</b> ${lastSender || 'Unknown'}</p>
    <p><b>Last message sample:</b> ${snippet ? snippet : '(none)'} </p>
    <p>– Automated alert</p>
  `;

  await transporter.sendMail({
    from: `"${fromName}" <${SMTP_USER}>`,
    to: toList,
    subject,
    html,
  });
}

// ----- ARTIFACTS -------------------------------------------------------------
async function saveArtifacts(page, tag) {
  const shot = `/tmp/shot_${tag}.png`;
  const html = `/tmp/page_${tag}.html`;
  await page.screenshot({ path: shot, fullPage: true });
  const content = await page.content();
  await fs.writeFile(html, content, 'utf8');
  console.log(`Saved artifacts for ${tag}`);
}

// ----- LOGIN & NAVIGATION ----------------------------------------------------
async function loginIfNeeded(page) {
  // If we’re already inside the app, there will be no email input.
  const emailInput = page.locator('input[type="email"]');
  const pwInput = page.locator('input[type="password"]');
  const loginBtn = page.locator('button:has-text("Login"), button:has-text("Sign in")');

  try {
    await emailInput.waitFor({ timeout: 4000 });
  } catch {
    // No login form found – likely already authenticated
    return;
  }

  if (!BOOM_USER || !BOOM_PASS) {
    throw new Error('Missing BOOM_USER / BOOM_PASS.');
  }

  await emailInput.fill(BOOM_USER);
  await pwInput.fill(BOOM_PASS);
  await loginBtn.click();
  await page.waitForLoadState('networkidle', { timeout: 30000 });
}

// Small helper to be resilient to slow pages
async function gotoAndReady(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await loginIfNeeded(page);
  // Give the conversation timeline time to render
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
}

// ----- DETECTION LOGIC -------------------------------------------------------
/**
 * We want the last meaningful message from the timeline, *excluding*
 * Agent suggestion cards (they contain APPROVE / REJECT / REGENERATE buttons).
 * Then classify sender (Guest vs Agent) using nearby meta text (e.g. "via whatsapp", "via channel").
 */
async function analyzeConversation(page) {
  // Try to scope to the main center column if present; otherwise use body
  const root = page.locator('main, [role="main"], .container, body').first();

  // Grab candidates (cards / bubbles)
  const handles = await root.locator('div').elementHandles();

  const info = await page.evaluate((nodes) => {
    function isVisible(el) {
      const s = window.getComputedStyle(el);
      return s && s.visibility !== 'hidden' && s.display !== 'none' && el.offsetParent !== null;
    }

    // Scan from bottom (last items) upwards
    for (let i = nodes.length - 1; i >= 0; i--) {
      const el = nodes[i];
      if (!isVisible(el)) continue;

      const text = (el.innerText || '').trim();

      // Skip empty / tiny nodes
      if (!text || text.length < 1) continue;

      // Skip AI suggestion cards
      const tUpper = text.toUpperCase();
      if (tUpper.includes('APPROVE') && (tUpper.includes('REJECT') || tUpper.includes('REGENERATE'))) {
        continue;
      }

      // Heuristic: ignore top bars / filters / tabs
      if (tUpper.includes('DASHBOARD LOGIN') || tUpper.includes('REMEMBER ME')) continue;

      // Determine sender
      let lastSender = 'Unknown';
      // Look at the full card text – meta (like "via whatsapp" / "via channel") is usually near it
      if (/\bvia whatsapp\b|\bvia email\b|\bvia sms\b|\bvia web\b|\bvia website\b/i.test(text)) {
        lastSender = 'Guest';
      } else if (/\bvia channel\b|\bAgent\b/.test(text)) {
        lastSender = 'Agent';
      }

      // Basic snippet from this element (short, single line)
      const snippet = text.replace(/\s+/g, ' ').slice(0, 160);
      return { lastSender, snippet, raw: text };
    }

    return { lastSender: 'Unknown', snippet: '', raw: '' };
  }, handles);

  // If we couldn’t find any text at all, bail out quietly
  if (!info || (!info.snippet && info.lastSender === 'Unknown')) {
    return { ok: false, reason: 'no_text', lastSender: 'Unknown', snippet: '' };
  }

  // We alert when the last meaningful message is from Guest (PA flow already waited 5+ min)
  const okToAlert = info.lastSender === 'Guest';
  return {
    ok: okToAlert,
    reason: okToAlert ? 'guest_unanswered' : 'heuristic',
    lastSender: info.lastSender,
    snippet: info.snippet,
  };
}

// ----- MAIN ------------------------------------------------------------------
async function main() {
  console.log(`Run node check.js --conversation "${convoURL}"`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  try {
    await gotoAndReady(page, convoURL);
    await saveArtifacts(page, 't1');

    const result = await analyzeConversation(page);
    console.log('Second check result:', result);

    // Always capture a second artifact pass (useful when alerting/no alerting)
    await saveArtifacts(page, 't2');

    if (result.ok) {
      await sendAlert({
        link: convoURL,
        lastSender: result.lastSender,
        snippet: result.snippet,
      });
      console.log('Alert sent.');
    } else {
      console.log('No alert sent (not confident or not guest/unanswered).');
    }
  } catch (err) {
    console.error(err);
    // Save a failure artifact for debugging
    try { await saveArtifacts(page, 'error'); } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
