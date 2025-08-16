// check.js — Boom SLA checker (Guest/Agent last-message + AI suggestion)
// ESM compatible. Requires Playwright + nodemailer installed.
// Secrets used (must already exist in repo settings):
// BOOM_USER, BOOM_PASS, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ALERT_TO, ALERT_FROM_NAME, AGENT_SIDE
//
// Behavior (alert condition):
// - If the last *real* message is by Guest, we alert.
// - An "Agent" AI suggestion card (with REJECT/APPROVE) does NOT count as a reply.
// - If SMTP/ALERT_* not configured, we log "alert needed" with details instead of sending.
//
// Artifacts always saved to /tmp for Actions to upload.

import { chromium } from 'playwright';
import fs from 'fs';
import nodemailer from 'nodemailer';

const {
  BOOM_USER,
  BOOM_PASS,
  ALERT_TO,
  ALERT_FROM_NAME,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  AGENT_SIDE, // optional "true"/"false" (if you want to only alert when lastSender === 'Guest')
} = process.env;

const CONVERSATION_URL = process.env.CONVERSATION_URL?.trim();
if (!CONVERSATION_URL) {
  console.error('Missing CONVERSATION_URL. Exiting.');
  process.exit(2);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function saveArtifacts(page, note = '') {
  try {
    const shot = `/tmp/boom-shot${note ? '-' + note : ''}.png`;
    const html = `/tmp/boom-page${note ? '-' + note : ''}.html`;
    await page.screenshot({ path: shot, fullPage: true });
    const content = await page.content();
    fs.writeFileSync(html, content, 'utf8');
  } catch (e) {
    console.warn('Artifact save error:', e.message);
  }
}

// Robust login that works whether we land on login or are already authed
async function loginIfNeeded(page) {
  // If we see a login email field, sign in; otherwise we’re probably already logged in.
  const emailInput = page.locator('input[type="email"], input[name="email"]');
  const passwordInput = page.locator('input[type="password"], input[name="password"]');
  const loginButton = page.locator('button:has-text("Log in"), button:has-text("Sign in"), button[type="submit"]');

  if (await emailInput.first().isVisible().catch(() => false)) {
    await emailInput.first().fill(BOOM_USER || '');
    await passwordInput.first().fill(BOOM_PASS || '');
    await Promise.any([
      loginButton.first().click().catch(() => {}),
      page.keyboard.press('Enter').catch(() => {}),
    ]);
    // Wait for either conversation UI or general dashboard shell to load
    await page.waitForLoadState('networkidle', { timeout: 30000 });
    // A small settle time in case SPA transitions are mid-flight
    await sleep(1500);
  }
}

// Core DOM analysis run in the page to avoid brittle selectors.
// Strategy:
//  1) Find all elements that look like a real message row by searching for “via whatsapp” or “via channel”.
//  2) Exclude AI suggestion cards (they don’t contain “via ...” anyway).
//  3) Classify each candidate as Agent if the same row (or its immediate container) contains the text “TRAIN”.
//     (In your UI screenshots, agent-authored messages show a “TRAIN” badge; guests don’t.)
//  4) The last candidate (bottom-most in DOM order) is taken as the last real message.
//  5) Detect presence of an AI suggestion card by “Agent” header + REJECT/APPROVE buttons.
async function analyzeConversation(page) {
  const data = await page.evaluate(() => {
    function nodeInfo(n) {
      const txt = (n.innerText || '').replace(/\s+/g, ' ').trim();
      const rect = n.getBoundingClientRect();
      return { text: txt, y: rect?.y ?? 0, h: rect?.height ?? 0 };
    }

    const all = Array.from(document.querySelectorAll('div, article, section, li'));
    const looksLikeMessage = (n) =>
      /via\s+(whatsapp|channel)/i.test(n.innerText || '');

    // Collect all “real message” rows
    let candidates = [];
    for (const n of all) {
      if (!looksLikeMessage(n)) continue;
      const i = nodeInfo(n);

      // Classify agent vs guest using the TRAIN tag heuristic.
      // We look in the element and a couple of ancestors to avoid strictly relying on local structure.
      let scopeText = i.text;
      let p = n.parentElement;
      for (let k = 0; k < 2 && p; k++, p = p.parentElement) {
        scopeText += ' ' + (p.innerText || '');
      }
      const isAgent = /\bTRAIN\b/i.test(scopeText);

      // Pull a short snippet of the bubble text (try to avoid metadata)
      // Heuristic: take first line that is not “via whatsapp|channel” and not containing “TRAIN”.
      const lines = (n.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
      let snippet = '';
      for (const line of lines) {
        if (/via\s+(whatsapp|channel)/i.test(line)) continue;
        if (/TRAIN/i.test(line)) continue;
        snippet = line;
        break;
      }

      candidates.push({
        y: i.y, h: i.h, snippet,
        raw: i.text.slice(0, 400),
        sender: isAgent ? 'Agent' : 'Guest'
      });
    }

    candidates.sort((a, b) => (a.y + a.h) - (b.y + b.h)); // top->bottom
    const last = candidates[candidates.length - 1] || null;

    // Detect an AI suggestion card (unapproved) – look for “Agent” header and buttons
    // We accept any of these button labels to be flexible with localization.
    const hasAgentSuggestion = !!document.querySelector(
      [
        'div:has(> *:is(h1,h2,h3,div):has-text("Agent")):has(button:has-text("APPROVE"))',
        'div:has(button:has-text("REJECT")):has(button:has-text("APPROVE"))',
        'div:has-text("Agent"):has(button:has-text("REJECT"))'
      ].join(', ')
    );

    return {
      candidates,
      lastSender: last ? last.sender : 'Unknown',
      snippet: last ? last.snippet : '',
      hasAgentSuggestion
    };
  });

  // Also dump the raw nodes for debugging
  try {
    fs.writeFileSync('/tmp/boom-nodes.json', JSON.stringify(data, null, 2));
  } catch {}

  return data;
}

function recipientsReady() {
  return Boolean(ALERT_TO && SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS && ALERT_FROM_NAME);
}

async function sendEmail(subject, html) {
  if (!recipientsReady()) {
    console.log('Alert needed, but SMTP/recipient envs are not fully set.');
    return;
  }
  const port = Number(SMTP_PORT) || 587;
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465, // use TLS if 465
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });

  await transporter.sendMail({
    from: `"${ALERT_FROM_NAME}" <${SMTP_USER}>`,
    to: ALERT_TO,
    subject,
    html
  });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Navigate to conversation (login will happen if necessary)
  await page.goto(CONVERSATION_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await loginIfNeeded(page);

  // Make sure we’re looking at the conversation thread
  await saveArtifacts(page, 't1');

  const res = await analyzeConversation(page);

  // Decide alert
  // If AGENT_SIDE is truthy, only fire when lastSender === 'Guest'.
  // Otherwise (default), same behavior (we alert only for guest-last).
  const onlyGuest = String(AGENT_SIDE || '').toLowerCase() !== 'false';
  const needsAlert = (res.lastSender === 'Guest');

  const result = {
    ok: !needsAlert,
    reason: needsAlert ? 'guest_last' : (res.lastSender === 'Agent' ? 'agent_last' : 'unknown'),
    lastSender: res.lastSender,
    hasAgentSuggestion: res.hasAgentSuggestion,
    snippet: res.snippet,
  };

  console.log('Second check result:', JSON.stringify(result, null, 2));

  // If guest last, alert (AI suggestion presence strengthens the case but is not required)
  if (needsAlert) {
    const subject = `SLA breach (>5 min): Boom guest message unanswered`;
    const html = `
      <div style="font-family:system-ui,Arial,sans-serif;font-size:14px;line-height:1.5">
        <p>Hi team,</p>
        <p>A Boom guest message appears to be the latest message in this conversation.</p>
        <p><b>Conversation:</b> <a href="${CONVERSATION_URL}" target="_blank" rel="noopener">Open in Boom</a><br/>
           <b>Last sender detected:</b> ${res.lastSender}<br/>
           <b>AI suggestion visible:</b> ${res.hasAgentSuggestion ? 'Yes' : 'No'}<br/>
           <b>Last snippet:</b> ${res.snippet || '(empty)'}
        </p>
        <p style="color:#666">– Automated alert</p>
      </div>
    `;
    await sendEmail(subject, html);
  } else {
    console.log('No alert sent (not guest/unanswered).');
  }

  await saveArtifacts(page, 't2');
  await browser.close();
})();
