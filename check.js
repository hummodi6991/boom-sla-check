// check.js
// Boom SLA watchdog — Playwright + SMTP
// Usage: node check.js --conversation "<Boom conversation URL>"
// Secrets via env: BOOM_USER, BOOM_PASS, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, FROM_NAME, TO_EMAIL (comma-separated)

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const nodemailer = require('nodemailer');

const ARTIFACT_DIR = '/tmp';
const JUNK_RE = /APPROVE|REJECT|Confidence|UNANSWERED|AI ESCALATIONS|ACTIVE \(12H\)|RESERVED|FOLLOW UPS|MY TICKETS|AWAITING PAYMENT|RECENTLY CONFIRMED|ALL|Fun Level Changed/i;

function getArg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : '';
}
function maskEmail(e) {
  if (!e) return '';
  const [u, d] = e.split('@');
  if (!d) return e;
  return `${u.slice(0, 1)}***@${d}`;
}

async function saveArtifacts(page, tag) {
  const shot = path.join(ARTIFACT_DIR, `shot_${tag}.png`);
  const html = path.join(ARTIFACT_DIR, `page_${tag}.html`);
  // Page screenshot + HTML
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
  const content = await page.content().catch(() => '');
  try { fs.writeFileSync(html, content || '', 'utf8'); } catch {}

  // Also save top two frames if present
  const frames = page.frames().slice(1, 3); // skip main
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    try {
      const fHtml = path.join(ARTIFACT_DIR, `frame_${i}_${tag}.html`);
      const fContent = await f.content();
      fs.writeFileSync(fHtml, fContent, 'utf8');
    } catch {}
  }
  console.log(`Saved artifacts for ${tag}`);
}

async function resolveRedirect(page, url) {
  // If it’s a tracking/redirect link, open and wait for the real Boom URL.
  if (/mjt\.lu\/lnk|http(s)?:\/\/xwlu9\./i.test(url)) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('load').catch(() => {});
    // Wait up to 20s for app.boomnow.com to appear
    const final = await Promise.race([
      page.waitForFunction(() => location.href, { timeout: 20000 }),
      new Promise((r) => setTimeout(() => r(''), 20000)),
    ]);
    return (typeof final === 'string' && final) || page.url();
  }
  return url;
}

async function loginIfNeeded(page) {
  // A very forgiving login that adapts to minor UI changes
  const emailSel = 'input[type="email"], input[name="email"], input[autocomplete="email"], #email';
  const passSel  = 'input[type="password"], input[name="password"], input[autocomplete="current-password"], #password';
  const submitSel = 'button[type="submit"], button:has-text("Login"), button:has-text("Sign in")';

  // If we're already inside the app, bail.
  if (/app\.boomnow\.com/i.test(page.url()) && !(await page.$(emailSel))) return false;

  const emailEl = await page.$(emailSel);
  const passEl  = await page.$(passSel);

  if (emailEl && passEl) {
    console.log('Login page detected, signing in…');
    await emailEl.fill(process.env.BOOM_USER || '', { timeout: 15000 });
    await passEl.fill(process.env.BOOM_PASS || '', { timeout: 15000 });

    const btn = await page.$(submitSel);
    if (btn) {
      await Promise.allSettled([
        btn.click(),
        page.waitForLoadState('load', { timeout: 45000 })
      ]);
    } else {
      // Press Enter in password field as a fallback
      await passEl.press('Enter');
      await page.waitForLoadState('load', { timeout: 45000 }).catch(() => {});
    }
    // Small settle
    await page.waitForTimeout(1500);
    return true;
  }
  return false;
}

/**
 * Wait until a real (non-widget) message exists in the DOM.
 */
async function waitForRealMessage(page, timeoutMs = 20000) {
  await page.waitForFunction(
    (junkSource) => {
      const junk = new RegExp(junkSource, 'i');
      const root =
        document.querySelector('[class*="v-messages__wrapper"]') ||
        document.querySelector('[data-testid="message-list"]') ||
        document.querySelector('.messages');

      if (!root) return false;

      const texts = Array.from(root.querySelectorAll('div,li,p,span'))
        .map(n => (n.innerText || '').trim())
        .filter(Boolean);

      if (texts.length === 0) return false;

      return texts.some(t => !junk.test(t) && t.length > 1);
    },
    { timeout: timeoutMs },
    JUNK_RE.source
  );
}

/**
 * Try to extract the last readable message text + infer sender.
 */
async function getLastMessageInfo(page) {
  const contexts = [page, ...page.frames()];
  // Crawls a few likely containers for message text
  const selectors = [
    '[data-testid="message-list"]',
    '[class*="v-messages__wrapper"]',
    '.messages'
  ];

  let lastText = '';
  let lastSender = 'Unknown';
  let selectorUsed = '(none)';

  for (const ctx of contexts) {
    for (const sel of selectors) {
      const root = await ctx.$(sel);
      if (!root) continue;

      // Collect candidate blocks in visual order
      const blocks = await root.$$('div, li, p, span');
      let lastIdx = -1;
      let lastCandidate = null;

      for (let i = 0; i < blocks.length; i++) {
        const el = blocks[i];
        let t = '';
        try { t = (await el.innerText()).trim(); } catch {}
        if (!t) continue;
        if (JUNK_RE.test(t)) continue; // dashboard chips/widgets/etc.
        // Avoid pure emojis or single character
        if (t.length < 2) continue;

        lastIdx = i;
        lastCandidate = { el, t };
      }

      if (lastCandidate) {
        lastText = lastCandidate.t;
        selectorUsed = sel;

        // Heuristic sender detection:
        // Look at a small neighborhood around the last block for badges/labels.
        const neighbors = await ctx.$$eval(
          `${sel} *`,
          (nodes, idx) => {
            const around = [];
            for (let i = Math.max(0, idx - 6); i <= Math.min(nodes.length - 1, idx + 2); i++) {
              const n = nodes[i];
              const text = (n.innerText || '').trim();
              if (text) around.push(text);
            }
            return around;
          },
          lastIdx
        ).catch(() => []);

        const near = (neighbors || []).join(' ').toLowerCase();
        if (/agent|ai live|ai escalated|auto|approved/.test(near)) {
          lastSender = 'Agent';
        } else if (/guest|\bvia channel\b/.test(near)) {
          lastSender = 'Guest';
        } else {
          // If we can see a user name line like "via channel • <name>", treat as guest;
          // if we see "Auto" or "AI", treat as agent
          if (/\bvia channel\b/.test(near) && !/\bauto\b|\bai\b/.test(near)) {
            lastSender = 'Guest';
          }
        }

        return { ok: true, lastSender, snippet: lastText, selUsed: selectorUsed, reason: 'ok' };
      }
    }
  }

  return { ok: false, lastSender, snippet: '', selUsed: selectorUsed, reason: 'no_selector' };
}

async function sendEmail({ recipients, subject, html }) {
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = Number(process.env.SMTP_PORT || 465);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const fromName = process.env.FROM_NAME || 'Oaktree Boom SLA Bot';
  const from = `"${fromName}" <${user}>`;

  const transporter = nodemailer.createTransport({
    host, port, secure: port === 465,
    auth: { user, pass }
  });

  const info = await transporter.sendMail({
    from,
    to: recipients,
    subject,
    html
  });

  console.log(`SMTP message id: ${info.messageId}`);
}

async function main() {
  const argUrl = getArg('--conversation') || process.env.CONVERSATION_URL || '';
  if (!argUrl) {
    console.error('Missing --conversation URL');
    process.exit(1);
  }

  const TO = (process.env.TO_EMAIL || process.env.ROHIT_EMAIL || process.env.SMTP_USER || '').split(',').map(s => s.trim()).filter(Boolean);
  if (TO.length === 0) {
    console.error('No recipients configured (set TO_EMAIL or SMTP_USER).');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  const page = await context.newPage();

  let finalUrl = argUrl;
  try {
    // Stage t1: resolve final Boom URL (if the link is a tracker)
    finalUrl = await resolveRedirect(page, argUrl);
    if (!/app\.boomnow\.com/i.test(finalUrl)) finalUrl = page.url();
    console.log(`Resolved Boom URL: ${finalUrl}`);
    await saveArtifacts(page, 't1');

    // If we got bounced to login, sign in
    await loginIfNeeded(page);

    // Navigate explicitly to the final URL (in case login redirected away)
    if (page.url() !== finalUrl) {
      await page.goto(finalUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await page.waitForLoadState('load').catch(() => {});
    }

    // Stage t2: ensure a real message exists (or exit gracefully)
    try {
      await waitForRealMessage(page, 20000);
    } catch {
      console.log("Second check result: { ok: true, reason: 'no_text', lastSender: 'Unknown', snippet: '' }");
      console.log('No alert sent (not confident or not guest/unanswered).');
      await saveArtifacts(page, 't2');
      await browser.close();
      return;
    }

    // Extract last message + sender
    const info = await getLastMessageInfo(page);
    console.log(`Second check result: ${JSON.stringify(info, null, 2)}`);

    await saveArtifacts(page, 't2');

    // Decide whether to alert:
    // Only alert when the last readable bubble belongs to a Guest (i.e., unanswered).
    if (info.ok && info.lastSender === 'Guest') {
      const subject = 'SLA breach (>5 min): Boom guest message unanswered';
      const html = `
        <p>Hi Rohit,</p>
        <p>A Boom guest message appears unanswered after 5 minutes.</p>
        <p>Conversation: <a href="${finalUrl}">Open in Boom</a><br/>
        Last sender detected: <b>${info.lastSender}</b><br/>
        Last message sample: ${info.snippet ? `<i>${info.snippet}</i>` : '(none)'}<br/></p>
        <p>– Automated alert</p>
      `;

      console.log(`Sending email to ${TO.map(maskEmail).join(', ')} from ${maskEmail(process.env.SMTP_USER)}`);
      await sendEmail({ recipients: TO.join(','), subject, html });
    } else {
      console.log('No alert sent (not confident or not guest/unanswered).');
    }

  } catch (err) {
    console.error('=== ERROR ===');
    console.error(err && err.stack || err);
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

main();
