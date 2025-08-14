// check.js
// Runs in GitHub Actions. Logs into Boom, opens a conversation, decides if last message is from Guest and unanswered,
// then optionally emails an alert.

const { chromium } = require('playwright');
const nodemailer = require('nodemailer');

const BOOM_USER = process.env.BOOM_USER;
const BOOM_PASS = process.env.BOOM_PASS;
const TO_EMAIL  = process.env.ROHIT_EMAIL;
const FROM_USER = process.env.SMTP_USER;      // Gmail address
const FROM_NAME = process.env.FROM_NAME || 'Oaktree Boom SLA Bot';
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_PASS = process.env.SMTP_PASS;

const CONV_URL  = process.argv.includes('--conversation')
  ? process.argv[process.argv.indexOf('--conversation') + 1]
  : '';

if (!BOOM_USER || !BOOM_PASS || !TO_EMAIL || !FROM_USER || !SMTP_HOST || !SMTP_PASS || !CONV_URL) {
  console.error('Missing required env or args.');
  process.exit(1);
}

async function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function buildTransport() {
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: FROM_USER, pass: SMTP_PASS },
  });
}

/** Return a trimmed first line preview to show in email logs */
function preview(text, len = 160) {
  if (!text) return '';
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > len ? one.slice(0, len - 1) + '…' : one;
}

/**
 * Heuristic to classify a bubble's footer and sender.
 * We treat anything with "via email • Auto" or "via channel • <name>" as Agent.
 * If we see words like Guest / WhatsApp / Booking.com etc we call it Guest.
 */
function classifyFooter(t) {
  const x = t.toLowerCase();
  if (x.includes('via email • auto') || x.includes('via channel •') || x.includes('agent •') || x.includes('staff')) {
    return 'Agent';
  }
  if (x.includes('guest') || x.includes('whatsapp') || x.includes('airbnb') || x.includes('booking') || x.includes('agoda')) {
    return 'Guest';
  }
  return 'Unknown';
}

/**
 * Extract last real message (ignoring AI suggestion cards and KPI panels).
 * Returns {sender, text, debug, ok, reason, selUsed, snippet}
 */
async function detectLastMessage(page) {
  // 1) Remove obviously irrelevant regions (KPI cards & AI suggestion stacks)
  // These are the things we saw in artifacts: "UNANSWERED 44" tabs and "Agent / APPROVE" suggestion cards.
  const removeSelectors = [
    // KPI tabs / counters area
    'div.v-tabs', 'div[class*="v-tabs"]', 'div[class*="mb-"]', 'div[class*="mt-"]',
    // AI suggestion cards (contain APPROVE / REJECT buttons and "Agent / Confidence")
    'div:has(button:has-text("APPROVE"))',
    'div:has(button:has-text("REJECT"))',
    'div:has-text("Confidence:")',
  ];

  // For debugging, we won’t actually remove nodes (Playwright can’t easily), but we’ll exclude them in queries.
  // 2) Candidate selectors for *real* message bubbles
  // We rely on two cues we consistently saw in your artifacts:
  //  - message footer lines contain "via ..." bullets (e.g., "via email • Auto", "via channel • Amal Alawad")
  //  - message text areas live near those footers
  const footerCandidates = page.locator('xpath=//div[.//text()[contains(., "via ") and contains(., "•")]]');

  // If footers not found, as a fallback find generic message-looking blocks that contain a short paragraph and a time (":")
  const genericCandidates = page.locator('xpath=//div[(p or span) and .//text()[contains(.,":")]]');

  // Prefer footer candidates (more precise)
  let candidates = footerCandidates;
  if ((await candidates.count()) === 0) candidates = genericCandidates;

  const n = await candidates.count();
  // Take last visible candidate as the last message region
  let idx = -1;
  for (let i = n - 1; i >= 0; i--) {
    const el = candidates.nth(i);
    if (await el.isVisible()) { idx = i; break; }
  }
  if (idx < 0) {
    return { ok:false, reason:'no_selector', lastSender:'Unknown', snippet:'' };
  }

  const last = candidates.nth(idx);

  // Extract footer text (if any)
  let footerText = '';
  try {
    const footer = await last.locator('xpath=.//div[contains(text(),"via ") and contains(text(),"•")]').first();
    if (await footer.count()) footerText = (await footer.innerText()).trim();
  } catch {}

  // Extract message text (avoid APPROVE/REJECT chunks)
  let msgText = '';
  try {
    const possible = await last.locator('xpath=.//div|.//p|.//span').allInnerTexts();
    if (possible && possible.length) {
      // Pick the longest non-control line that isn’t the footer
      const cleaned = possible
        .map(t => t.trim())
        .filter(t => t && !/approve|reject|confidence|ai live|ai escalated/i.test(t))
        .filter(t => t !== footerText);
      msgText = cleaned.sort((a,b)=>b.length-a.length)[0] || '';
    }
  } catch {}

  // Classify sender from footer; if unknown, try a few hints from the block text
  let sender = classifyFooter(footerText || '');
  if (sender === 'Unknown') {
    const blockAll = ((await last.allInnerTexts())||[]).join(' ').toLowerCase();
    if (/via email\s*•\s*auto/.test(blockAll) || /via channel\s*•/.test(blockAll)) sender = 'Agent';
    else if (/guest|whatsapp|airbnb|booking|agoda/.test(blockAll)) sender = 'Guest';
  }

  const snippet = preview(msgText, 140);
  const debug = { footerText, textSample: snippet };

  // Decide: unanswered guest only if last sender is Guest
  const isGuest = sender === 'Guest';
  return {
    ok: isGuest,              // only "OK to alert" if last is Guest
    isAnswered: !isGuest,     // answered if not guest (Agent/Auto/Unknown treated as answered or inconclusive)
    lastSender: sender,
    reason: sender === 'Guest' ? 'guest_last' : 'agent_or_auto_last',
    selUsed: 'footer+geo',
    snippet,
    debug
  };
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // 0) Go straight to the conversation URL (Power Automate gives us the tracking link; we resolve it)
  await page.goto(CONV_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('domcontentloaded');

  // 1) If we see the login page, sign in
  const needLogin = await page.locator('input[type="email"], input[name="email"]').first().count();
  if (needLogin) {
    // Save first screenshot for debugging
    await page.screenshot({ path: '/tmp/login_t1.png', fullPage: true }).catch(()=>{});
    // Try common fields
    const emailField = page.locator('input[type="email"], input[name="email"]').first();
    const passField  = page.locator('input[type="password"], input[name="password"]').first();

    await emailField.fill(BOOM_USER);
    await passField.fill(BOOM_PASS);
    await page.getByRole('button', { name: /login/i }).click().catch(async () => {
      // fallback click by text
      const btn = page.locator('button:has-text("Login")').first();
      if (await btn.count()) await btn.click();
    });

    await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(()=>{});
    await sleep(1800);
  }

  // 2) The tracking URL may redirect to the final Boom “guest experience” page; follow it
  // If we’re already on app.boomnow.com, do nothing
  if (!/app\.boomnow\.com/.test(page.url())) {
    try {
      await page.waitForURL(/app\.boomnow\.com/, { timeout: 25000 });
    } catch {}
  }

  // 3) Open the conversation tab if there’s a left nav (sometimes the URL itself opens it)
  // We’ll try clicking the last “Open in Boom” link if presented, else just wait a bit.
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(()=>{});
  await sleep(1200);

  // 4) Detect last message (ignoring AI cards & KPI tabs)
  const result = await detectLastMessage(page);
  console.log('Second check result:', result);

  // 5) Decide alert
  let shouldAlert = false;
  let reason = '';
  if (result.ok && result.lastSender === 'Guest') {
    // We only alert if last is Guest (means unanswered by agent/auto at the moment of check)
    shouldAlert = true;
    reason = 'guest_unanswered';
  } else {
    shouldAlert = false;
    reason = 'not_guest_or_answered';
  }

  if (!shouldAlert) {
    console.log('No alert sent (not confident or not guest/unanswered).');
    await browser.close();
    return;
  }

  // 6) Send email
  const transporter = buildTransport();
  const mail = {
    from: `"${FROM_NAME}" <${FROM_USER}>`,
    to: TO_EMAIL,
    subject: 'SLA breach (>5 min): Boom guest message unanswered',
    html: `
      <p>Hi Rohit,</p>
      <p>A Boom guest message appears unanswered after 5 minutes.</p>
      <p>Conversation: <a href="${page.url()}" target="_blank">Open in Boom</a><br/>
      Last sender detected: <b>${result.lastSender || 'Unknown'}</b><br/>
      Last message sample: <i>${result.snippet || '(none found)'}</i></p>
      <p>– Automated alert</p>
    `,
  };
  const info = await transporter.sendMail(mail);
  console.log('SMTP message id:', info.messageId);

  await browser.close();
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
