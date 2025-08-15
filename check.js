// ESM module
import { chromium } from 'playwright';
import nodemailer from 'nodemailer';
import fs from 'fs/promises';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TMP_DIR = '/tmp';

const {
  BOOM_USER,
  BOOM_PASS,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  FROM_NAME,
  ROHIT_EMAIL,
  CONVERSATION_URL: INPUT_URL,
} = process.env;

function nowTs() { return new Date().toISOString(); }

async function saveArtifacts(page, tag) {
  try {
    const shot = path.join(TMP_DIR, `shot_${tag}.png`);
    const html = path.join(TMP_DIR, `page_${tag}.html`);
    await page.screenshot({ path: shot, fullPage: true });
    await fs.writeFile(html, await page.content(), 'utf8');
    console.log(`Saved artifacts for ${tag}`);
  } catch (e) {
    console.log(`(skip) could not save artifacts for ${tag}: ${e.message}`);
  }
}

function buildTransport() {
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    throw new Error('SMTP config missing. Need SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS.');
  }
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

async function sendAlert({ to, subject, html }) {
  const transport = buildTransport();
  const fromName = FROM_NAME || 'Oaktree Boom SLA Bot';
  const from = `"${fromName}" <${SMTP_USER}>`; // send from the SMTP user’s mailbox
  const rcpts = [...new Set(
    (Array.isArray(to) ? to : String(to || '').split(','))
      .map(s => s.trim()).filter(Boolean)
  )];
  if (!rcpts.length) throw new Error('No recipients for alert');

  const info = await transport.sendMail({ from, to: rcpts.join(','), subject, html });
  console.log(`SMTP message id: ${info.messageId}`);
}

function looksLikeConversationUrl(u) {
  return /\/dashboard\/guest-experience\/sales\/[0-9a-f-]+/i.test(u);
}

/**
 * For tracked MJML links we only take the *first* Location hop (which has the
 * conversation URL) and we STOP before the app redirects to /login.
 */
async function resolveFirstHopUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (url.hostname.includes('app.boomnow.com')) {
      return rawUrl;
    }
    // One manual hop
    const res = await fetch(rawUrl, { redirect: 'manual' });
    const loc = res.headers.get('location');
    if (loc) {
      // Absolute or relative
      const final = new URL(loc, rawUrl).toString();
      return final;
    }
  } catch (e) {
    console.log(`resolveFirstHopUrl error: ${e.message}`);
  }
  return rawUrl;
}

async function loginIfOnLogin(page) {
  // If page shows login or URL has /login, do login
  if (!page.url().includes('/login')) {
    // Extra heuristic: “Dashboard Login” heading text
    const loginH1 = await page.locator('text=Dashboard Login').first();
    if (!(await loginH1.count())) return false;
  }
  if (!BOOM_USER || !BOOM_PASS) throw new Error('BOOM_USER/BOOM_PASS missing');

  await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(()=>{});
  // Robust selectors
  const email = page.locator('input[type="email"], input[name="email"]');
  const pass = page.locator('input[type="password"], input[name="password"]');
  const loginBtn = page.locator('button:has-text("Login"), button:has-text("Sign in")');

  await email.fill(BOOM_USER, { timeout: 15000 });
  await pass.fill(BOOM_PASS, { timeout: 15000 });
  await loginBtn.click({ timeout: 15000 }).catch(()=>{});
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(()=>{});
  return true;
}

async function ensureOnConversation(page, intendedUrl) {
  // If we are not on a conversation but have an intended conversation URL, try to go there.
  if (looksLikeConversationUrl(page.url())) return true;

  if (looksLikeConversationUrl(intendedUrl)) {
    await page.goto(intendedUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(()=>{});
    return looksLikeConversationUrl(page.url());
  }
  return false;
}

async function extractLastMessageInfo(page) {
  // Bail out if we’re not on a conversation thread
  const url = page.url();
  if (!looksLikeConversationUrl(url)) {
    return { ok: false, lastSender: 'Unknown', reason: 'not_conversation', snippet: '' };
  }

  // Try to detect the last visible bubble
  // Heuristic 1: the “via channel • …” dots row precedes guest bubble (blue)
  const bubbles = page.locator('div[role="listitem"], div:has-text("via channel")').locator('xpath=..');
  const total = await bubbles.count();
  if (total === 0) {
    return { ok: false, lastSender: 'Unknown', reason: 'no_bubbles', snippet: '' };
  }

  // Fallback: grab the last text block on the timeline area
  const container = page.locator('main, [data-testid="conversation"], div:has-text("via channel")').first();
  const allText = (await container.innerText().catch(()=>'')) || '';
  const snippet = (allText || '').split('\n').slice(-5).join(' ').trim().slice(0, 160);

  // Look for an Agent suggestion card with APPROVE/REJECT immediately after the last bubble
  const hasAgentSuggestion = await page.locator('button:has-text("APPROVE"), button:has-text("Approve")').first().isVisible().catch(()=>false);

  // A very robust sender guess:
  //  - If there’s an agent suggestion card immediately visible and *no* newer human bubble, the last sender is the guest.
  //  - If the newest item contains “Agent” header, treat as Agent.
  const agentHeader = await page.locator('text=Agent').last().isVisible().catch(()=>false);

  let lastSender = 'Unknown';
  if (hasAgentSuggestion && !agentHeader) lastSender = 'Guest';
  else if (agentHeader) lastSender = 'Agent';

  return {
    ok: lastSender !== 'Unknown',
    lastSender,
    reason: 'heuristic',
    snippet,
    hasAgentSuggestion,
  };
}

(async () => {
  if (!INPUT_URL) throw new Error('Missing env var: CONVERSATION_URL');

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  const page = await ctx.newPage();

  let firstHopUrl = await resolveFirstHopUrl(INPUT_URL);
  console.log(`Navigating to conversation…`);
  await page.goto(firstHopUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(()=>{});

  // If we’re on login, log in then go to intended conversation URL
  if (page.url().includes('/login')) {
    await saveArtifacts(page, 't1');
    const didLogin = await loginIfOnLogin(page);
    if (didLogin) {
      // After login, force-load the intended conversation url if we have it
      await ensureOnConversation(page, firstHopUrl);
    }
  } else {
    await saveArtifacts(page, 't1');
  }

  // If still not on a conversation, try one more time to ensure
  await ensureOnConversation(page, firstHopUrl);

  // Take a second set of artifacts on the final page
  await saveArtifacts(page, 't2');

  const result = await extractLastMessageInfo(page);
  console.log('Second check result:', JSON.stringify({ ...result, ts: nowTs() }, null, 2));

  const shouldAlert =
    result.lastSender === 'Guest' &&
    (result.hasAgentSuggestion || true); // keep alert simple: guest last is enough

  if (shouldAlert) {
    const toList = [SMTP_USER, ROHIT_EMAIL].filter(Boolean).join(',');
    const subject = 'SLA breach (>5 min): Boom guest message unanswered';
    const link = looksLikeConversationUrl(firstHopUrl) ? firstHopUrl : page.url();
    const html = `
      <p>Hi Rohit,</p>
      <p>A Boom guest message appears unanswered after 5 minutes.</p>
      <p><b>Conversation:</b> <a href="${link}">Open in Boom</a><br/>
         <b>Last sender detected:</b> ${result.lastSender}<br/>
         <b>Last message sample:</b> ${result.snippet || '—'}</p>
      <p>– Automated alert</p>
    `;
    await sendAlert({ to: toList, subject, html });
  } else {
    console.log('No alert sent (not confident or not guest/unanswered).');
  }

  await browser.close();
})().catch(async (err) => {
  console.error(err);
  process.exitCode = 1;
});
