// check.js  — robust "last sender" + SLA check that ignores AI suggestions
import { chromium } from 'playwright';
import nodemailer from 'nodemailer';

const {
  BOOM_USER,
  BOOM_PASS,
  CONVERSATION_URL,        // optional: passed by workflow
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  FROM_NAME,
  ALERT_TO,                // resolved by workflow (fallbacks to SMTP_USER)
  ALERT_CC,                // optional
  SLA_MINUTES              // optional (default 5)
} = process.env;

const SLA = Number(SLA_MINUTES || 5);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function loginIfNeeded(page) {
  // If we hit a login form, sign in
  if (/\/login/i.test(page.url()) || await page.locator('input[type="email"], input[name="email"]').first().isVisible().catch(() => false)) {
    await page.locator('input[type="email"], input[name="email"]').first().fill(BOOM_USER, { timeout: 20000 });
    await page.locator('input[type="password"], input[name="password"]').first().fill(BOOM_PASS, { timeout: 20000 });
    // Click the first submit-looking button
    const submit = page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")').first();
    if (await submit.count()) await submit.click();
    // Wait for app shell
    await page.waitForLoadState('networkidle', { timeout: 60000 });
  }
}

function parseTimeToday(tsText) {
  // Accept strings like "12:46 PM" / "05:07 pm"
  if (!tsText) return null;
  const m = tsText.match(/\b([0]?[1-9]|1[0-2]):([0-5][0-9])\s*(AM|PM)\b/i);
  if (!m) return null;
  let [ , hh, mm, ap ] = m;
  let h = Number(hh);
  const minutes = Number(mm);
  const upper = ap.toUpperCase();
  if (upper === 'PM' && h !== 12) h += 12;
  if (upper === 'AM' && h === 12) h = 0;

  const now = new Date();
  const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, minutes, 0, 0);
  return dt;
}

async function detectStatus(page) {
  // Scroll down to make sure latest UI is rendered
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(300);

  // Work entirely in the page to read geometry/text
  const data = await page.evaluate(() => {
    const reMeta = /via (whatsapp|channel)/i;
    const timeRe = /\b([0]?[1-9]|1[0-2]):[0-5][0-9]\s*(AM|PM)\b/i;

    // Find every element that looks like the metadata line of a real bubble
    const nodes = Array.from(document.querySelectorAll('body *'))
      .filter(el => {
        const t = (el.innerText || '').trim();
        return t && reMeta.test(t);
      })
      .map(el => {
        const r = el.getBoundingClientRect();
        return {
          x: r.left + r.width / 2,
          y: r.top + r.height / 2,
          meta: el.innerText.trim()
        };
      })
      .sort((a, b) => a.y - b.y);

    const lastMeta = nodes[nodes.length - 1] || null;

    // Very conservative AI-suggestion detection: any of these words anywhere
    const pageText = (document.body.innerText || '').toUpperCase();
    const hasAgentSuggestion =
      (pageText.includes('APPROVE') && pageText.includes('REJECT')) ||
      pageText.includes('REGENERATE') ||
      /CONFIDENCE\s*:\s*\d+/.test(pageText);

    // Try to find the closest time text to the last meta line
    let tsText = '';
    if (lastMeta) {
      const timeCandidates = Array.from(document.querySelectorAll('body *'))
        .map(el => ({ t: (el.innerText || '').trim(), r: el.getBoundingClientRect() }))
        .filter(it => timeRe.test(it.t));

      let best = null, bestDy = Infinity;
      for (const c of timeCandidates) {
        const cy = c.r.top + c.r.height / 2;
        const dy = Math.abs(cy - lastMeta.y);
        if (dy < bestDy) { best = c; bestDy = dy; }
      }
      if (best && bestDy < 140) {
        const m = best.t.match(timeRe);
        if (m) tsText = m[0];
      }
    }

    // Decide sender side by alignment (guest bubbles are left; agent bubbles are right)
    // Use viewport midpoint as divider.
    const vw = window.innerWidth || 1200;
    let lastSender = 'Unknown';
    if (lastMeta) lastSender = (lastMeta.x > vw / 2) ? 'Agent' : 'Guest';

    return { lastSender, tsText, hasAgentSuggestion };
  });

  // Calculate minutes since last bubble (if we found a time)
  let ts = null;
  let minsAgo = null;
  if (data.tsText) {
    ts = parseTimeToday(data.tsText);
    if (ts) minsAgo = Math.floor((Date.now() - ts.getTime()) / 60000);
  }

  // Decide breach
  let ok = false;
  let reason = '';
  if (data.lastSender === 'Agent') {
    ok = true;
    reason = 'agent_last';
  } else if (data.lastSender === 'Guest') {
    if (minsAgo == null) {
      ok = false;
      reason = 'guest_last_but_no_time';
    } else if (minsAgo < SLA) {
      ok = false;
      reason = 'guest_last_recent';
    } else {
      ok = true;
      reason = 'guest_unanswered';
    }
  } else {
    ok = false;
    reason = 'unknown';
  }

  return {
    ok,
    reason,
    lastSender: data.lastSender,
    hasAgentSuggestion: data.hasAgentSuggestion,
    tsText: data.tsText || '',
    minsAgo
  };
}

async function sendAlert(result, page) {
  const to = (ALERT_TO && ALERT_TO.trim()) || SMTP_USER;
  const cc = (ALERT_CC || '').trim();

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: Number(SMTP_PORT || 587) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });

  const subject = `SLA breach (> ${SLA} min): Boom guest message unanswered`;
  const url = CONVERSATION_URL || '(not provided)';
  const html = `
    <p>Hi,</p>
    <p>A Boom guest message appears unanswered after ${SLA} minutes.</p>
    <p><b>Conversation:</b> <a href="${url}">Open in Boom</a><br/>
       <b>Last sender detected:</b> ${result.lastSender}<br/>
       <b>AI suggestion visible:</b> ${result.hasAgentSuggestion ? 'Yes' : 'No'}<br/>
       <b>Last message time (page):</b> ${result.tsText || 'Unknown'}${result.minsAgo != null ? ` (${result.minsAgo} min ago)` : ''}</p>
    <p>– Automated alert</p>`;

  await transporter.sendMail({
    from: `"${FROM_NAME || 'Boom SLA Bot'}" <${SMTP_USER}>`,
    to,
    cc: cc || undefined,
    subject,
    html
  });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  try {
    if (!BOOM_USER || !BOOM_PASS) throw new Error('Missing BOOM_USER/BOOM_PASS');
    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !SMTP_PORT) {
      throw new Error('Missing SMTP_* secrets');
    }

    const target = CONVERSATION_URL;
    if (!target) console.warn('No CONVERSATION_URL provided; script will exit after login.');
    await page.goto(target || 'https://app.boomnow.com/login', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await loginIfNeeded(page);

    if (target) {
      // Make sure we landed on the conversation (if redirect happened)
      if (/\/login/i.test(page.url())) {
        // Sometimes app redirects back to login, try again
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await loginIfNeeded(page);
      }
    }

    // Give the timeline a moment to settle
    await sleep(500);

    const result = await detectStatus(page);

    // Save a “what I saw” screenshot for debugging
    try {
      await page.screenshot({ path: '/tmp/boom-after.png', fullPage: true });
    } catch {}

    console.log('Second check result:', JSON.stringify(result, null, 2));

    // Fire only when guest is last and beyond SLA
    if (result.ok && result.reason === 'guest_unanswered') {
      await sendAlert(result, page);
      console.log('Alert sent.');
    } else {
      console.log('No alert sent (not guest/unanswered beyond SLA).');
    }
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
