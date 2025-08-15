// check.js  — ESM
import { chromium } from 'playwright';
import nodemailer from 'nodemailer';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ------------------------
// ENV / CONFIG
// ------------------------
const CONVERSATION_URL =
  process.env.CONVERSATION_URL ||
  process.argv.slice(2).join(' ') || // allow passing URL as single arg
  '';

if (!CONVERSATION_URL) {
  console.error('Missing conversation URL (env CONVERSATION_URL or CLI arg).');
  process.exit(2);
}

const BOOM_USER = process.env.BOOM_USER || '';
const BOOM_PASS = process.env.BOOM_PASS || '';

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = +(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const FROM_NAME  = process.env.FROM_NAME  || 'Oaktree Boom SLA Bot';
const ROHIT_EMAIL = process.env.ROHIT_EMAIL || '';

const ART_T1_SHOT = '/tmp/shot_t1.png';
const ART_T2_SHOT = '/tmp/shot_t2.png';
const ART_T1_HTML = '/tmp/page_t1.html';
const ART_T2_HTML = '/tmp/page_t2.html';

// ------------------------
// Helpers
// ------------------------
async function saveArtifacts(page, basename) {
  const shot = basename === 't1' ? ART_T1_SHOT : ART_T2_SHOT;
  const html = basename === 't1' ? ART_T1_HTML : ART_T2_HTML;
  await page.screenshot({ path: shot, fullPage: true });
  const content = await page.content();
  await fs.writeFile(html, content, 'utf8');
}

async function firstExistingLocator(page, selectors) {
  for (const sel of selectors) {
    const loc = page.locator(sel);
    if (await loc.first().count()) return loc.first();
  }
  return null;
}

async function loginIfNeeded(page) {
  // Wait the first navigation to settle a bit
  await page.waitForLoadState('domcontentloaded');

  // Heuristic: if we can see an email OR password input, assume login
  const emailSelectors = [
    'input[type="email"]',
    'input[name="email"]',
    'input#email',
    'input[autocomplete="username"]',
    '[placeholder*="email" i]'
  ];
  const passSelectors = [
    'input[type="password"]',
    'input[name="password"]',
    'input#password',
    '[placeholder*="password" i]'
  ];
  const submitSelectors = [
    'button[type="submit"]',
    'button:has-text("Sign in")',
    'button:has-text("Log in")',
    'button:has-text("Continue")',
    'button:has-text("الدخول")'
  ];

  const emailInput = await firstExistingLocator(page, emailSelectors);
  const passInput  = await firstExistingLocator(page, passSelectors);

  // If neither input is present, do a soft check for a known login text,
  // but do NOT mix engines in the same selector.
  if (!emailInput && !passInput) {
    // If a typical login phrase is visible, allow a short wait for inputs to appear.
    const maybeLoginText = page.getByText(/remember me|تذكرني|log in|sign in/i).first();
    if (await maybeLoginText.count()) {
      await page.waitForTimeout(800); // tiny settle
    }
  }

  // Try again after the soft wait
  const email = emailInput || await firstExistingLocator(page, emailSelectors);
  const pass  = passInput  || await firstExistingLocator(page, passSelectors);

  if (email && pass) {
    if (!BOOM_USER || !BOOM_PASS) {
      throw new Error('Login required but BOOM_USER/BOOM_PASS not set');
    }
    await email.fill(BOOM_USER, { timeout: 15_000 }).catch(() => {});
    await pass.fill(BOOM_PASS, { timeout: 15_000 }).catch(() => {});
    const submit = await firstExistingLocator(page, submitSelectors);
    if (submit) {
      await Promise.all([
        page.waitForLoadState('networkidle').catch(() => {}),
        submit.click(),
      ]);
    } else {
      // fallback: press Enter in password field
      await Promise.all([
        page.waitForLoadState('networkidle').catch(() => {}),
        pass.press('Enter')
      ]);
    }
    // Give post-login redirects time
    await page.waitForLoadState('domcontentloaded');
  }
}

function buildTransport() {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error('SMTP settings missing (SMTP_HOST/SMTP_USER/SMTP_PASS).');
  }
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

async function sendAlert({ to, subject, html }) {
  const transporter = buildTransport();
  await transporter.sendMail({
    from: `"${FROM_NAME}" <${SMTP_USER}>`,
    to,
    subject,
    html,
  });
}

// Very small “is unanswered” heuristic that you can expand
async function detectState(page) {
  // Save an initial artifact
  await saveArtifacts(page, 't1');

  // Try to identify last message bubble role
  // We’ll search for little pills like “via whatsapp” or “via channel”
  // near the last bubble, otherwise fall back to role labels.
  const bubbleSelectors = [
    // guest messages (blue bubbles) usually left aligned:
    '[class*="message"]:has-text("via whatsapp")',
    '[class*="message"]:has-text("via channel")',
    '.v-timeline .v-timeline-item',       // generic
    '[data-test*="message"]',             // generic
  ];

  const aiSuggestionSelectors = [
    'button:has-text("APPROVE")',
    'button:has-text("REJECT")',
    'button:has-text("REGENERATE")'
  ];

  let lastSender = 'Unknown';

  // Look for “via whatsapp / via channel” on the last message row
  const viaWhats = page.getByText(/via whatsapp/i).last();
  const viaChan  = page.getByText(/via channel/i).last();
  if (await viaWhats.count() || await viaChan.count()) {
    // If we see those tags on the last bubble, that bubble is Guest
    lastSender = 'Guest';
  } else {
    // If we can find a visible “Agent” chip close to the end of the feed, call it Agent
    const agentChip = page.getByText(/^Agent$/i).last();
    if (await agentChip.count()) lastSender = 'Agent';
  }

  // Consider presence of the 3-button AI suggestion card as a sign
  // that no human reply was approved yet.
  let hasAgentSuggestion = false;
  for (const sel of aiSuggestionSelectors) {
    if (await page.locator(sel).first().count()) { hasAgentSuggestion = true; break; }
  }

  // If last sender is guest AND an AI suggestion card is present, we treat as unanswered.
  const isUnanswered = lastSender === 'Guest' && hasAgentSuggestion;

  // Save another artifact after reading UI
  await saveArtifacts(page, 't2');

  // Extract a small text snippet as context
  let snippet = '';
  const lastMsg = page.locator('[class*="message"]').last();
  if (await lastMsg.count()) {
    snippet = (await lastMsg.innerText()).slice(0, 140);
  }

  return { ok: !isUnanswered, lastSender, hasAgentSuggestion, snippet };
}

// ------------------------
// Main
// ------------------------
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  try {
    // Go to the link (can be a tracking link; we’ll follow redirects)
    await page.goto(CONVERSATION_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    // Log in if the page shows login controls; do NOT use mixed selectors
    await loginIfNeeded(page);

    // Some tracking links first land on a dashboard/login then redirect —
    // ensure we end at the conversation URL by navigating again (idempotent)
    await page.goto(CONVERSATION_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    // Give the conversation view a moment to render
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(800);

    const result = await detectState(page);

    console.log('Second check result:', JSON.stringify(result, null, 2));

    if (!result.ok) {
      // Compose recipients: always to ROHIT, CC the SMTP user as well (so you see the alert)
      const to = [ROHIT_EMAIL, SMTP_USER].filter(Boolean).join(', ');
      if (to) {
        const subject = 'SLA breach (>5 min): Boom guest message unanswered';
        const html = `
          <p>Hi Rohit,</p>
          <p>A Boom guest message appears unanswered after 5 minutes.</p>
          <p><b>Conversation:</b> <a href="${CONVERSATION_URL}">Open in Boom</a><br/>
             <b>Last sender detected:</b> ${result.lastSender}<br/>
             <b>AI suggestion visible:</b> ${result.hasAgentSuggestion ? 'Yes' : 'No'}<br/>
             <b>Last message sample:</b> ${result.snippet || '(n/a)'}
          </p>
          <p>— Automated alert</p>
        `;
        await sendAlert({ to, subject, html });
      } else {
        console.warn('Alert NOT sent: no recipients configured.');
      }
    } else {
      console.log('No alert sent (not confident or not guest/unanswered).');
    }
  } catch (err) {
    console.error(err);
    // Save at least one artifact for debugging if we crashed early
    try { await saveArtifacts(page, 't1'); } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
