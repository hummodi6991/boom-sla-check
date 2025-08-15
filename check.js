// check.js
// Boom SLA checker: opens a Boom conversation, figures out who sent the last *real* message,
// and emails an alert if the last sender looks like a Guest (i.e., guest message appears unanswered).

const { chromium } = require('playwright');
const nodemailer = require('nodemailer');
const fs = require('fs/promises');
const path = require('path');

const OUTPUT_DIR = '/tmp';
const now = () => new Date().toISOString().replace(/[:.]/g, '-');

function env(name, fallback = undefined) {
  const v = process.env[name];
  if (v === undefined || v === null || v === '') return fallback;
  return String(v);
}

const CONFIG = {
  boomUser: env('BOOM_USER'),
  boomPass: env('BOOM_PASS'),
  conversationUrl:
    process.argv.find(a => /^https?:\/\//i.test(a)) ||
    env('CONVERSATION_URL'),
  smtp: {
    host: env('SMTP_HOST'),
    port: Number(env('SMTP_PORT') || '587'),
    user: env('SMTP_USER'),
    pass: env('SMTP_PASS')
  },
  fromName: env('FROM_NAME', 'Oaktree Boom SLA Bot'),
  // Who to notify; comma- or semicolon-separated allowed. Fallback to SMTP_USER.
  alertTo: (env('ALERT_TO') || env('ROHIT_EMAIL') || env('SMTP_USER') || '')
    .split(/[;,]/)
    .map(s => s.trim())
    .filter(Boolean),
};

function validateConfig() {
  const missing = [];
  if (!CONFIG.conversationUrl) missing.push('CONVERSATION_URL (or argv URL)');
  if (!CONFIG.boomUser) missing.push('BOOM_USER');
  if (!CONFIG.boomPass) missing.push('BOOM_PASS');
  if (!CONFIG.smtp.host) missing.push('SMTP_HOST');
  if (!CONFIG.smtp.port) missing.push('SMTP_PORT');
  if (!CONFIG.smtp.user) missing.push('SMTP_USER');
  if (!CONFIG.smtp.pass) missing.push('SMTP_PASS');
  if (!CONFIG.alertTo.length) missing.push('ALERT_TO/ROHIT_EMAIL/SMTP_USER');
  if (missing.length) {
    throw new Error(`Missing required configuration: ${missing.join(', ')}`);
  }
}

async function saveArtifacts(page, tag) {
  const png = path.join(OUTPUT_DIR, `shot_${tag}_${now()}.png`);
  const html = path.join(OUTPUT_DIR, `page_${tag}_${now()}.html`);
  await page.screenshot({ path: png, fullPage: true });
  await fs.writeFile(html, await page.content(), 'utf8');
  return { png, html };
}

async function loginIfNeeded(page) {
  // We treat any presence of an email input or "Dashboard Login" as the login page.
  const onLogin =
    (await page.locator('input[type="email"]').count()) > 0 ||
    (await page.getByText(/Dashboard Login/i).count()) > 0;

  if (!onLogin) return false;

  await page.fill('input[type="email"]', CONFIG.boomUser, { timeout: 15000 });
  await page.fill('input[type="password"]', CONFIG.boomPass, { timeout: 15000 });

  // Try a few likely login buttons
  const loginBtn = page.locator(
    'button:has-text("Login"), button:has-text("Sign in"), input[type="submit"]'
  );
  if ((await loginBtn.count()) > 0) {
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 30000 }),
      loginBtn.first().click()
    ]);
  } else {
    // Fallback: press Enter in password field
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 30000 }),
      page.keyboard.press('Enter')
    ]);
  }
  return true;
}

// Core extraction: find the last *real* message text and try to decide sender.
// We filter out AI suggestion cards like "Confidence / APPROVE / REJECT / Escalation".
async function extractLastMessageInfo(page) {
  // 1) Gather candidate blocks in the page context.
  const res = await page.evaluate(() => {
    function visible(el) {
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }

    const NOISE = [
      'Confidence',
      'APPROVE',
      'REJECT',
      'Escalation',
      'Detected Policy',
      'Fun Level Changed',
      'TRAIN',
      'Help Center',
      'Search listings, reservations, and navigation'
    ];

    const blocks = [];
    const nodes = document.querySelectorAll('div,li,article,section,p');

    for (const el of nodes) {
      if (!visible(el)) continue;
      const text = (el.innerText || '').trim();
      if (!text) continue;
      if (text.length < 2 || text.length > 1200) continue;
      if (NOISE.some(n => text.includes(n))) continue;

      const rect = el.getBoundingClientRect();
      // Bias toward bottom half (where the chat lives)
      const weight = rect.top + rect.height / 2;
      blocks.push({ text, y: weight });
    }

    blocks.sort((a, b) => a.y - b.y);
    const last = blocks[blocks.length - 1];

    const snippet = last ? last.text.replace(/\s+/g, ' ').slice(0, 160) : '';
    return {
      hasCandidate: !!last,
      snippet,
      lastSender: 'Unknown', // we’ll refine outside
    };
  });

  let { hasCandidate, snippet, lastSender } = res;

  // 2) Heuristic: if we can see the little footer like "via channel • …" or "via email • Auto"
  // near the bottom of the thread, consider that an Agent message.
  if (lastSender === 'Unknown') {
    const footer = page.locator('text=/via (channel|email)/i').last();
    if (await footer.count()) {
      lastSender = 'Agent';
    }
  }

  // 3) Very light alignment heuristic: right-aligned last visible text often means Agent
  if (lastSender === 'Unknown') {
    // Grab the last visible leaf-ish element's computed text-align
    const align = await page.evaluate(() => {
      const leaves = Array.from(
        document.querySelectorAll('div,li,p,article,section')
      )
        .filter(el => {
          const s = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return (
            s.visibility !== 'hidden' &&
            s.display !== 'none' &&
            r.width > 0 &&
            r.height > 0 &&
            (el.innerText || '').trim().length > 1
          );
        })
        .sort(
          (a, b) =>
            a.getBoundingClientRect().top - b.getBoundingClientRect().top
        );

      const last = leaves[leaves.length - 1];
      if (!last) return '';
      const s = getComputedStyle(last);
      return s.textAlign || s.alignSelf || '';
    });

    if (align && /right|end/i.test(align)) lastSender = 'Agent';
  }

  // 4) If we still don’t know, default to Guest **only if** we actually have text;
  // otherwise we’ll report "no_text".
  if (lastSender === 'Unknown' && hasCandidate && snippet) {
    // We prefer to be conservative; leave as Unknown to avoid false alerts.
    // lastSender stays 'Unknown'
  }

  return { ok: !!snippet, snippet, lastSender };
}

async function sendEmail({ subject, html }) {
  const secure = CONFIG.smtp.port === 465;
  const transporter = nodemailer.createTransport({
    host: CONFIG.smtp.host,
    port: CONFIG.smtp.port,
    secure,
    auth: { user: CONFIG.smtp.user, pass: CONFIG.smtp.pass },
    tls: { rejectUnauthorized: false }
  });

  const info = await transporter.sendMail({
    from: `"${CONFIG.fromName}" <${CONFIG.smtp.user}>`,
    to: CONFIG.alertTo.join(', '),
    subject,
    html
  });
  return info;
}

(async () => {
  validateConfig();

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 }
  });
  const page = await context.newPage();

  console.log(`▶ Run node check.js --conversation "${CONFIG.conversationUrl}"`);

  // Step 1: open the conversation (could be a tracking link or the final Boom URL)
  await page.goto(CONFIG.conversationUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await saveArtifacts(page, 't1');

  // Step 2: login if shown the login screen
  const didLogin = await loginIfNeeded(page);
  if (didLogin) {
    // Give Boom a moment to route to the conversation
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  }

  // If we’re still not on app.boomnow.com, let navigation settle and continue anyway
  const currentUrl = page.url();
  if (!/app\.boomnow\.com/.test(currentUrl)) {
    // Some emails wrap links in a redirector; just wait a bit for meta/JS redirect
    await page.waitForTimeout(3000);
  }

  // Step 3: extract last message + sender
  const { ok, snippet, lastSender } = await extractLastMessageInfo(page);

  // Save after parsing (t2)
  await saveArtifacts(page, 't2');

  // Decision:
  // - We only *alert* if we have real text (ok) AND the last sender looks like a Guest.
  const shouldAlert = ok && lastSender === 'Guest';

  const result = {
    ok,
    reason: ok ? (shouldAlert ? 'guest_unanswered' : 'no_text_or_agent') : 'no_text',
    lastSender,
    snippet
  };

  console.log('Second check result:', result);

  if (shouldAlert) {
    const subj = 'SLA breach (>5 min): Boom guest message unanswered';
    const html = `
      <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.5">
        <p>Hi Rohit,</p>
        <p>A Boom guest message appears unanswered after 5 minutes.</p>
        <p><strong>Conversation:</strong> <a href="${CONFIG.conversationUrl}">Open in Boom</a></p>
        <p><strong>Last sender detected:</strong> Guest</p>
        ${snippet ? `<p><strong>Last message sample:</strong><br><em>${snippet}</em></p>` : ''}
        <p>– Automated alert</p>
      </div>`.trim();

    try {
      const info = await sendEmail({ subject: subj, html });
      console.log('SMTP message id:', info.messageId || '(sent)');
    } catch (err) {
      console.error('SMTP error:', err);
    }
  } else {
    console.log('No alert sent (not confident or not guest/unanswered).');
  }

  await browser.close();
})().catch(err => {
  console.error(err);
  process.exit(1);
});
