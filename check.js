// check.js
// Boom SLA watchdog — Playwright + SMTP
// Triggers an alert email only when the *last* message in the thread is from a Guest
// AND there is a meaningful non-empty text snippet.

const { chromium } = require('playwright');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const CONVERSATION_URL =
  (process.argv[2] && process.argv[2].startsWith('http') ? process.argv[2] : null) ||
  process.env.CONVERSATION_URL;

if (!CONVERSATION_URL) {
  console.error('Missing conversation URL. Pass as arg or set CONVERSATION_URL env.');
  process.exit(2);
}

// Secrets
const BOOM_USER = process.env.BOOM_USER;
const BOOM_PASS = process.env.BOOM_PASS;

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;

const FROM_NAME = process.env.FROM_NAME || 'Oaktree Boom SLA Bot';
const FROM_EMAIL = SMTP_USER; // same mailbox
// Keep your current secret name for recipients to avoid repo changes
const TO_EMAILS = [process.env.ROHIT_EMAIL, process.env.ALERT_TO, process.env.NOTIFY_EMAIL]
  .filter(Boolean)
  .join(',');

// --- tiny helpers -----------------------------------------------------------
const outDir = '/tmp';
async function snap(page, tag) {
  const png = path.join(outDir, `shot_${tag}.png`);
  const html = path.join(outDir, `page_${tag}.html`);
  await page.screenshot({ path: png, fullPage: true });
  const htmlContent = await page.content();
  fs.writeFileSync(html, htmlContent, 'utf8');
  return { png, html };
}

function cleanText(s) {
  return (s || '')
    .replace(/\s+/g, ' ')
    .replace(/\u00A0/g, ' ')
    .trim();
}

function looksLikeStatusRow(txt) {
  // Things like “Fun Level Changed”, counters, tags, or system rows
  const t = txt.toLowerCase();
  return (
    t.length < 4 ||
    /fun level|changed|approved|rejected|ai escalations|reserved|follow ups|awaiting payment|recently confirmed|all/.test(
      t
    )
  );
}

// Decide whether to alert
function shouldAlert(result) {
  // Only when last sender is *Guest* and we have a meaningful snippet.
  if (!result) return false;
  if (result.lastSender !== 'Guest') return false;
  const snippet = cleanText(result.snippet);
  if (!snippet || snippet.length < 4) return false;
  return true;
}

// --- email ------------------------------------------------------------------
async function sendEmail({ to, subject, html }) {
  if (!to) {
    console.log('No recipient email configured; skipping send.');
    return;
  }
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465, // true for 465, false otherwise
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  const info = await transporter.sendMail({
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to,
    subject,
    html,
  });
  console.log(`SMTP message id: ${info.messageId}`);
}

// --- main -------------------------------------------------------------------
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
  });
  const page = await context.newPage();

  const result = {
    ok: false, // set true when we are confident no alert is needed
    reason: 'init',
    lastSender: 'Unknown',
    snippet: '',
  };

  try {
    // Go straight to conversation URL (will redirect to login if needed)
    await page.goto(CONVERSATION_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    // If login form appears, sign in
    const emailSel = 'input[type="email"], input[name="email"]';
    const passSel = 'input[type="password"], input[name="password"]';
    const loginBtnSel =
      'button:has-text("Sign in"), button:has-text("Log in"), button[type="submit"]';

    const hasEmail = await page.$(emailSel);
    if (hasEmail) {
      await page.fill(emailSel, BOOM_USER);
      await page.fill(passSel, BOOM_PASS);
      await page.click(loginBtnSel);
      await page.waitForLoadState('networkidle', { timeout: 90_000 });
    } else {
      // If not, still ensure the app settled
      await page.waitForLoadState('networkidle', { timeout: 90_000 });
    }

    await snap(page, 'login');

    // Make sure we’re on the conversation detail page
    // If the app uses a loading spinner, give it a moment
    await page.waitForTimeout(1500);

    // Heuristics to find the *last visible chat bubble* and who sent it.
    // 1) Prefer explicit bubbles: text bubble containers commonly end up as divs
    //    with message-ish classes. Grab the last with some text content.
    const bubbleCandidates = await page.$$(
      [
        // common message areas we've observed
        'div[class*="v-messages__wrapper"] div[class*="message"]',
        'div[class*="message"]',
        // generic “card text” content areas often used inside bubbles
        'div[class*="v-card__text"]',
        // final fallback: any reasonably sized text block
        'div[class*="mt-"], div[class*="mb-"]',
      ].join(', ')
    );

    let lastText = '';
    for (const el of bubbleCandidates) {
      const txt = cleanText(await el.innerText().catch(() => ''));
      if (txt && txt.length > 2) lastText = txt; // keep walking; the last non-trivial wins
    }

    // Try to infer sender:
    // If the last bubble is marked as "Agent" nearby, we treat it as agent; if it
    // contains obvious system/counter rows, we consider it status; otherwise Guest.
    let inferredSender = 'Unknown';
    if (lastText) {
      if (looksLikeStatusRow(lastText)) {
        inferredSender = 'Unknown';
      } else {
        // Look for a nearby "Agent" affordance on page (badge/text)
        const agentBadge = await page.$('text=Agent, role=button[name="Agent"]');
        inferredSender = agentBadge ? 'Agent' : 'Guest';
      }
    }

    result.lastSender = inferredSender;
    result.snippet = lastText;
    result.ok = inferredSender === 'Agent' || !shouldAlert(result);
    result.reason = inferredSender === 'Agent' ? 'agent_reply' : (lastText ? 'heuristic' : 'no_text');

    // snapshot after analysis
    await snap(page, 't2');

    console.log('Second check result:', {
      ok: result.ok,
      reason: result.reason,
      lastSender: result.lastSender,
      snippet: result.snippet ? result.snippet.slice(0, 80) : '',
    });

    if (shouldAlert(result)) {
      const subject = 'SLA breach (>5 min): Boom guest message unanswered';
      const link = `<a href="${CONVERSATION_URL}">Open in Boom</a>`;
      const body = `
        <p>Hi Rohit,</p>
        <p>A Boom guest message appears unanswered after 5 minutes.</p>
        <p><b>Conversation:</b> ${link}<br>
           <b>Last sender detected:</b> ${result.lastSender}<br>
           <b>Last message sample:</b> ${result.snippet ? result.snippet : '(none)'}
        </p>
        <p>– Automated alert</p>
      `;
      console.log('Sending email to', TO_EMAILS);
      await sendEmail({ to: TO_EMAILS, subject, html: body });
    } else {
      console.log('No alert sent (not confident or not guest/unanswered).');
    }
  } catch (err) {
    console.error('ERROR:', err?.message || err);
  } finally {
    await browser.close();
  }
})();
