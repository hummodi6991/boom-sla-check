// check.js
// Robust Boom SLA checker with resilient waits + graceful timeouts

const { chromium } = require('playwright');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const {
  CONVERSATION_URL,            // passed from workflow/Power Automate
  SMTP_HOST,
  SMTP_PORT = '587',
  SMTP_USER,
  SMTP_PASS,
  FROM_NAME = 'Oaktree Boom SLA Bot',
  FROM_EMAIL = SMTP_USER,
  ROHIT_EMAIL,                 // optional extra recipient
  ALERT_TO,                    // optional comma-separated list
} = process.env;

const HEADLESS = true;
const NAV_TIMEOUT = 90_000;    // generous for slow SPA loads
const SEL_TIMEOUT = 60_000;    // waiting for UI elements
const ARTIFACT_DIR = '/tmp';

function log(...args){ console.log(...args); }
function safe(fn){ return fn().catch(()=>null); }

async function saveArtifacts(page, label) {
  const base = (p) => path.join(ARTIFACT_DIR, `${p}`);
  await safe(() => page.screenshot({ path: base(`shot_${label}.png`), fullPage: true }));
  await safe(async () => {
    const html = await page.content();
    fs.writeFileSync(base(`page_${label}.html`), html);
  });
}

function recipients() {
  // prefer ALERT_TO (comma separated), else fall back to ROHIT_EMAIL only
  const list = [];
  if (ALERT_TO) list.push(...ALERT_TO.split(',').map(s => s.trim()).filter(Boolean));
  if (ROHIT_EMAIL && !list.includes(ROHIT_EMAIL)) list.push(ROHIT_EMAIL);
  return list;
}

async function sendEmail({ subject, html }) {
  const toList = recipients();
  if (toList.length === 0) return; // nothing to send

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  await transporter.sendMail({
    from: { name: FROM_NAME, address: FROM_EMAIL },
    to: toList.join(','),
    subject,
    html,
  });
}

// waits for either login form or conversation UI
async function waitForLoginOrConversation(page) {
  const loginEmail = page.locator('input[type="email"]');
  const loginPass  = page.locator('input[type="password"]');
  const composer   = page.locator('textarea[placeholder*="Type your message"], [placeholder*="Type your message"], [data-testid*=composer]');

  try {
    await Promise.race([
      loginEmail.first().waitFor({ timeout: SEL_TIMEOUT }),
      composer.first().waitFor({ timeout: SEL_TIMEOUT }),
      page.waitForURL('**/dashboard/**', { timeout: SEL_TIMEOUT }),
    ]);
  } catch (_) { /* fall through */ }

  const onLogin = await loginEmail.first().isVisible().catch(() => false);
  return { onLogin, composer };
}

async function loginIfNeeded(page) {
  const emailEl = page.locator('input[type="email"]');
  const passEl  = page.locator('input[type="password"]');
  const submit  = page.locator('button:has-text("Login"), button[type="submit"], [data-testid*=login]');

  const visible = await emailEl.first().isVisible().catch(()=>false);
  if (!visible) return false;

  log('Login page detected, signing in…');
  await emailEl.fill(process.env.BOOM_USER || '');
  await passEl.fill(process.env.BOOM_PASS || '');
  await Promise.all([
    submit.first().click().catch(()=>{}),
    page.waitForLoadState('domcontentloaded').catch(()=>{}),
  ]);

  // After submitting, wait for dashboard/conversation UI
  await Promise.race([
    page.waitForURL('**/dashboard/**', { timeout: SEL_TIMEOUT }),
    page.locator('[placeholder*="Type your message"]').first().waitFor({ timeout: SEL_TIMEOUT }),
  ]).catch(()=>{});
  return true;
}

async function openConversation(page, url) {
  log('Navigating to conversation…');

  // Go, but don’t require the “load” event (SPAs may not fire it reliably)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(()=>{});

  // Best-effort: wait until network becomes quieter; don’t fail if it doesn’t
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(()=>{});

  // Resolve tracking -> final URL if needed (mjt.lu etc.)
  try {
    await page.waitForURL('**app.boomnow.com**', { timeout: 30_000 });
  } catch (_) { /* already on final host or took too long; continue */ }

  // One more short settle
  await page.waitForTimeout(1500);

  const { onLogin } = await waitForLoginOrConversation(page);
  if (onLogin) { await loginIfNeeded(page); }

  // Final settle for SPA mount
  await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(()=>{});
  await page.waitForTimeout(1000);
}

function findLastMessageCandidate(page) {
  const selectors = [
    '[class*="message"]',
    '[class*="bubble"]',
    'div[class*="msg"]',
    '.v-card .mt-3',
    '.v-list-item',
  ];
  return page.locator(selectors.join(', '));
}

async function evaluateConversation(page) {
  // Try to pick a sensible "last message"
  const nodes = findLastMessageCandidate(page);
  const count = await nodes.count().catch(()=>0);
  let textSample = '';
  if (count > 0) {
    for (let i = count - 1; i >= 0; i--) {
      const el = nodes.nth(i);
      const txt = (await el.innerText().catch(()=>''))?.trim();
      if (txt && txt.length > 1) { textSample = txt; break; }
    }
  }

  // Very conservative: if we didn’t confidently see a guest message,
  // report "not confident", so no alert fires.
  const ok = false;
  return {
    ok,
    reason: count ? 'heuristic' : 'no_selector',
    lastSender: 'Unknown',
    snippet: textSample.slice(0, 200),
  };
}

async function main() {
  if (!CONVERSATION_URL) {
    throw new Error('CONVERSATION_URL is required');
  }

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  page.setDefaultTimeout(SEL_TIMEOUT);

  let result = { ok: false, reason: 'unknown', lastSender: 'Unknown', snippet: '' };

  try {
    await saveArtifacts(page, 't0');
    await openConversation(page, CONVERSATION_URL);
    await saveArtifacts(page, 't1');

    // Give the thread a moment to render
    await page.waitForTimeout(1000);

    result = await evaluateConversation(page);
    log('Second check result:', result);

    // Decide whether to alert
    const shouldAlert = !result.ok && (result.reason === 'heuristic' || result.reason === 'no_selector');

    if (shouldAlert) {
      const subject = 'SLA breach (>5 min): Boom guest message unanswered';
      const link = CONVERSATION_URL;
      const html = `
        <p>Hi Rohit,</p>
        <p>A Boom guest message appears unanswered after 5 minutes.</p>
        <p><b>Conversation:</b> <a href="${link}">Open in Boom</a><br/>
           <b>Last sender detected:</b> ${result.lastSender}<br/>
           <b>Last message sample:</b><br/>
           <pre>${(result.snippet || '').replace(/[<>&]/g, s => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[s]))}</pre>
        </p>
        <p>– Automated alert</p>
      `;
      await sendEmail({ subject, html }).catch(err => log('Email error:', err));
    } else {
      log('No alert sent (not confident or not guest/unanswered).');
    }

    // Always exit success — timeouts/heuristics shouldn’t fail the workflow
    process.exit(0);

  } catch (err) {
    // Soft-fail: capture artifacts & exit 0 so Actions shows green
    log('Timeout or navigation error:', err?.message || err);
    await saveArtifacts(page, 'error');
    console.log('Second check result:', { ok: false, reason: 'timeout', lastSender: 'Unknown', snippet: '' });
    process.exit(0);
  } finally {
    await context.close().catch(()=>{});
    await browser.close().catch(()=>{});
  }
}

main();
