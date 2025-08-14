// check.js
// Boom “unanswered >5 min” checker — Playwright + Gmail SMTP
// Triggers an email ONLY when the last message in the Boom conversation
// is confidently detected as coming from the Guest.

const { chromium } = require('playwright');
const nodemailer = require('nodemailer');

// ---- Secrets from GitHub Actions ----
const {
  BOOM_USER,
  BOOM_PASS,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  FROM_NAME,
  ROHIT_EMAIL,
} = process.env;

const CONVERSATION_URL = process.argv.includes('--conversation')
  ? process.argv[process.argv.indexOf('--conversation') + 1]
  : '';

if (!CONVERSATION_URL) {
  console.error('No conversation URL provided');
  process.exit(1);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Heuristics for sender detection (English + Arabic keywords)
const GUEST_HINTS = [
  'guest', 'customer', 'visitor', 'lead',
  'ضيف', 'الضيف', 'النزيل', 'عميل' // عميل is “customer” but appears for Agent in some CRMs; used carefully
];

const AGENT_HINTS = [
  'agent', 'staff', 'team', 'operator', 'human',
  'ai', 'autopilot', 'assistant', 'confidence',
  'موظف', 'وكيل', 'الوكيل', 'الدعم', 'مساعد' // staff/agent/support/assistant
];

// Candidate selectors for message nodes (kept deliberately broad)
const MESSAGE_SELECTORS = [
  // common “message/bubble” patterns
  '[class*="message"]:not([class*="error"]):not([class*="help"])',
  '[class*="bubble"]',
  '[class*="chat"][class*="msg"]',
  '[data-test*="message"], [data-testid*="message"]',
  // Vuetify cards often wrap messages
  '.v-card:has(.v-card-text), .v-list-item:has(.v-list-item__content)',
  '.v-messages__message, .v-messages__wrapper',
  // Fallback to blocks with decent text
  '.v-card-text, .text-body-2, .text-body-1, .v-list-item__content'
];

// Utility: get inner text safely
async function getTextSafe(locator) {
  try { return (await locator.innerText()).trim(); } catch { return ''; }
}

// Try to resolve tracking/redirect links to the real Boom page
async function resolveLink(browser, url) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  try {
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // If it’s already the Boom app, return it
    if (p.url().includes('app.boomnow.com')) {
      const finalUrl = p.url();
      await ctx.close();
      return finalUrl;
    }
    // Click-through redirects if any
    await sleep(1000);
    const finalUrl = p.url();
    await ctx.close();
    return finalUrl;
  } catch (e) {
    await ctx.close();
    return url; // fall back
  }
}

// Login helper
async function ensureLoggedIn(page) {
  // If we’re on login, sign in
  if (page.url().includes('/login')) {
    // Wait inputs
    const emailSel = 'input[type="email"], input[name="email"]';
    const passSel  = 'input[type="password"], input[name="password"]';
    await page.waitForSelector(emailSel, { timeout: 30000 });
    await page.fill(emailSel, BOOM_USER);
    await page.fill(passSel, BOOM_PASS);
    await Promise.all([
      page.click('button:has-text("Login"), button:has-text("Sign in"), button:has-text("تسجيل الدخول")'),
      page.waitForLoadState('domcontentloaded')
    ]);
    // Let the app settle
    await page.waitForTimeout(1500);
  }
}

// Find last message element + sender guess
async function detectLastMessageAndSender(page) {
  const contexts = [page, ...page.frames()];
  let best = null;

  for (const ctx of contexts) {
    for (const sel of MESSAGE_SELECTORS) {
      const nodes = ctx.locator(sel);
      const count = await nodes.count().catch(() => 0);
      if (!count) continue;

      // Walk from the end to get the last message-like node
      for (let i = count - 1; i >= 0; i--) {
        const node = nodes.nth(i);
        // Ignore invisible or empty nodes
        const visible = await node.isVisible().catch(() => false);
        if (!visible) continue;

        // Extract a small text sample
        const text = (await getTextSafe(node)).replace(/\s+/g, ' ').slice(0, 280);
        if (!text) continue;

        // Skip obvious non-message blocks (tabs/counters/menus)
        if (/\b(UNANSWERED|AI ESCALATIONS|RESERVED|FOLLOW UPS|MY TICKETS|AWAITING PAYMENT|RECENTLY CONFIRMED|ALL)\b/i.test(text)) {
          continue;
        }

        // Work upward to a reasonable container of this bubble
        const container = node; // good enough in Vuetify layouts

        // Gather text around the bubble to infer sender
        const around = (await getTextSafe(container)).toLowerCase();
        let sender = 'Unknown';
        let scoreGuest = 0, scoreAgent = 0;

        for (const w of GUEST_HINTS) if (around.includes(w)) scoreGuest++;
        for (const w of AGENT_HINTS) if (around.includes(w)) scoreAgent++;

        // Strong signals: specific badges/labels
        if (/\b(agent|staff|team)\b/i.test(around)) scoreAgent += 2;
        if (/\b(guest|customer|visitor)\b/i.test(around) || /ضيف|الضيف|النزيل/.test(around)) scoreGuest += 2;

        // Decide
        if (scoreGuest === 0 && scoreAgent === 0) {
          sender = 'Unknown';
        } else if (scoreAgent >= scoreGuest + 1) {
          sender = 'Agent';
        } else if (scoreGuest >= scoreAgent + 1) {
          sender = 'Guest';
        } else {
          sender = 'Unknown'; // too close
        }

        best = {
          sender,
          textSample: text,
          selUsed: sel
        };
        break; // we found a candidate at this selector
      }
      if (best) break; // stop scanning other selectors
    }
    if (best) break; // stop scanning other frames
  }

  return best || { sender: 'Unknown', textSample: '', selUsed: '(none)' };
}

// Send email via SMTP (Gmail app password etc.)
async function sendAlertEmail({ conversationUrl, lastSender, snippet }) {
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: Number(SMTP_PORT || 587) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });

  const subject = 'SLA breach (>5 min): Boom guest message unanswered';
  const html = `
    <p>Hi Rohit,</p>
    <p>A Boom guest message appears unanswered after 5 minutes.</p>
    <p><b>Conversation:</b> <a href="${conversationUrl}">Open in Boom</a><br>
    <b>Last sender detected:</b> ${lastSender}<br>
    <b>Last message sample:</b> <i>${snippet || '(none)'}</i></p>
    <p>– Automated alert</p>
  `;

  const info = await transporter.sendMail({
    from: `"${FROM_NAME || 'Oaktree Boom SLA Bot'}" <${SMTP_USER}>`,
    to: ROHIT_EMAIL,
    subject,
    html
  });
  console.log(`SMTP message id: ${info.messageId}`);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // 1) resolve link (handles tracking URL from the email)
  const resolved = await resolveLink(browser, CONVERSATION_URL);
  console.log('Resolved Boom URL:', resolved);

  // 2) open & login if needed
  await page.goto(resolved, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await ensureLoggedIn(page);

  // 3) small settle
  await page.waitForTimeout(1200);

  // 4) find the last message + sender
  const last = await detectLastMessageAndSender(page);
  console.log('Second check result:', {
    isAnswered: !(last.sender === 'Guest'),
    lastSender: last.sender,
    reason: last.selUsed === '(none)' ? 'no_selector' : 'geo-heuristic',
    selUsed: last.selUsed,
    snippet: last.textSample
  });

  // 5) decide & email
  if (last.sender === 'Guest') {
    await sendAlertEmail({
      conversationUrl: resolved,
      lastSender: 'Guest',
      snippet: last.textSample
    });
  } else {
    console.log('No alert sent (not confident or not guest/unanswered).');
  }

  await browser.close();
})().catch(err => {
  console.error(err);
  process.exit(1);
});
