// check.js — Boom SLA checker (ESM)
// Usage: node check.js
// Env: BOOM_USER, BOOM_PASS, CONVERSATION_URL (or POWER AUTOMATE tracking URL)
//      SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, FROM_NAME (optional)
//      ROHIT_EMAIL (optional, second recipient)
//      BREACH_MINUTES (optional, default 5)

import { chromium } from 'playwright';
import nodemailer from 'nodemailer';

const {
  BOOM_USER,
  BOOM_PASS,
  CONVERSATION_URL,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  FROM_NAME = 'Oaktree Boom SLA Bot',
  ROHIT_EMAIL,
  BREACH_MINUTES = '5',
} = process.env;

if (!BOOM_USER || !BOOM_PASS || !CONVERSATION_URL) {
  console.error('Missing required env: BOOM_USER, BOOM_PASS, CONVERSATION_URL');
  process.exit(2);
}

function parseClockLabel(label) {
  if (!label) return null;
  const m = label.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ampm = m[3].toUpperCase();
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, min, 0);
}

async function loginIfNeeded(page) {
  // If the tracking link redirects to the login page, sign in.
  await page.waitForLoadState('domcontentloaded');
  const needsLogin =
    (await page.locator('input[type="email"]').count()) > 0 ||
    page.url().includes('/login');

  if (needsLogin) {
    await page.fill('input[type="email"]', BOOM_USER, { timeout: 15000 });
    await page.fill('input[type="password"]', BOOM_PASS, { timeout: 15000 });
    // Support different button labels
    const loginBtn = page.locator('button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Login")');
    await loginBtn.first().click();
    await page.waitForLoadState('networkidle', { timeout: 45000 });
  }
}

async function openConversation(page, url) {
  // The link could be a tracking redirect — just navigate; Playwright will follow.
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await loginIfNeeded(page);
  // After login, Boom may redirect to /dashboard then to the conversation.
  // Give it time, then force to the final URL if it still looks like a dashboard.
  if (!/guest-experience\/sales\//.test(page.url())) {
    // Try to extract the final link from the page (PowerAutomate redirects embed it)
    const href = await page.evaluate(() => {
      const a = [...document.querySelectorAll('a')].find(x =>
        x.href && x.href.includes('/guest-experience/sales/'));
      return a?.href || null;
    }).catch(() => null);
    if (href) await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  // Ensure everything loads
  await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
  // Scroll to bottom so the latest messages are in view
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
}

async function analyzeConversation(page) {
  // Save a “before” shot
  await page.screenshot({ path: '/tmp/shot_before.png', fullPage: true }).catch(() => {});

  const data = await page.evaluate(() => {
    const vw = window.innerWidth;

    const EXCLUDE_PHRASES = [
      'Agent', 'Confidence', 'REJECT', 'APPROVE', 'REGENERATE',
      'Fun level changed', 'Escalation', 'Detected Policy',
      'Conversation has been de-escalated', 'Moved to closed',
      'SALE', 'Assignee', 'AI ESCALATED'
    ];

    function visible(el) {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 24 && r.height > 12 && st.visibility !== 'hidden' && st.display !== 'none';
    }
    function txt(el) {
      return (el.innerText || '').trim().replace(/\s+/g, ' ');
    }

    // Rough detector for AI suggestion card: buttons with APPROVE/REJECT near bottom
    const hasAgentSuggestion = (() => {
      const buttons = [...document.querySelectorAll('button')].map(b => (b.innerText || '').trim());
      const approve = buttons.some(t => /approve/i.test(t));
      const reject = buttons.some(t => /reject/i.test(t));
      return approve && reject;
    })();

    // Harvest candidate “message bubbles”: visible, textual, not system or card UI
    const candidates = [...document.querySelectorAll('div, li, article, section')]
      .filter(visible)
      .map(el => {
        const t = txt(el);
        if (!t) return null;
        if (EXCLUDE_PHRASES.some(p => t.includes(p))) return null;
        // Skip obvious containers (huge blocks with nested buttons)
        if (el.querySelector('button')) return null;
        const r = el.getBoundingClientRect();
        return {
          t,
          cx: r.left + r.width / 2,
          cy: r.top + r.height / 2,
          w: r.width,
          h: r.height,
          hasWhatsApp: /via whatsapp/i.test(t),
          hasChannel: /via channel/i.test(t),
        };
      })
      .filter(Boolean)
      // Keep items that look like chat bubbles: enough width/height OR short text but “balloonish” size
      .filter(n => n.h >= 18 && (n.w >= 80 || n.t.length <= 5))
      .sort((a, b) => a.cy - b.cy);

    const last = candidates[candidates.length - 1] || null;

    // Find a recent time label anywhere near the bottom of the thread
    const timeLabel = (() => {
      const labels = [...document.querySelectorAll('*')]
        .slice(-800) // recent nodes
        .map(el => (el.textContent || '').trim())
        .filter(Boolean);
      const times = labels.filter(s => /\b\d{1,2}:\d{2}\s*(AM|PM)\b/i.test(s));
      return times.length ? times[times.length - 1] : '';
    })();

    return { last, hasAgentSuggestion, vw, timeLabel };
  });

  const result = {
    ok: false,
    lastSender: 'Unknown',
    hasAgentSuggestion: !!data?.hasAgentSuggestion,
    snippet: data?.last?.t?.slice(0, 140) || '',
    reason: 'indeterminate',
    tsText: data?.timeLabel || '',
    ts: null
  };

  // Decide sender by geometry (left half ~ guest; right half ~ agent)
  if (data?.last) {
    result.lastSender = (data.last.cx < (data.vw / 2)) ? 'Guest' : 'Agent';
    result.reason = 'geo';
  }

  // Parse a time if available (best effort)
  const ts = parseClockLabel(result.tsText);
  if (ts) result.ts = ts.toISOString();

  // Compute age in minutes if we have a time label
  let ageMin = null;
  if (ts) {
    ageMin = Math.max(0, (Date.now() - ts.getTime()) / 60000);
  }

  // Breach decision:
  // - If we confidently see an Agent last → no breach.
  // - If we confidently see a Guest last AND age >= threshold (or timestamp missing) → breach.
  // - If we can’t tell (Unknown) but we *do* see a bubble candidate → treat conservatively as breach.
  const threshold = Number(BREACH_MINUTES) || 5;

  if (result.lastSender === 'Agent') {
    result.ok = true;
    result.reason = 'agent_last';
  } else if (result.lastSender === 'Guest') {
    const oldEnough = ageMin == null ? true : ageMin >= threshold;
    result.ok = !oldEnough; // ok=true means no alert
    result.reason = oldEnough ? 'guest_unanswered' : 'no_breach_yet';
  } else {
    // Unknown → if we had any candidate, assume breach (safer)
    const hadCandidate = !!data?.last;
    if (hadCandidate) {
      result.ok = false;
      result.reason = 'heuristic';
    } else {
      result.ok = true;
      result.reason = 'no_breach';
    }
  }

  // Save an “after” shot with latest viewport
  await page.screenshot({ path: '/tmp/shot_after.png', fullPage: true }).catch(() => {});
  await page.content().then(html => {
    // Keep a small HTML copy for debugging
    return import('node:fs').then(fs => fs.writeFileSync('/tmp/page_dump.html', html, 'utf8'));
  }).catch(() => {});

  return result;
}

async function sendAlertEmail(summary) {
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: Number(SMTP_PORT || 587) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  // Recipients: SMTP_USER + optional ROHIT_EMAIL
  const toList = [SMTP_USER, ROHIT_EMAIL].filter(Boolean).join(', ');

  const subject = `SLA breach (> ${BREACH_MINUTES} min): Boom guest message unanswered`;
  const html = `
    <p>Hi Rohit,</p>
    <p>A Boom guest message appears unanswered after ${BREACH_MINUTES} minutes.</p>
    <p><strong>Conversation:</strong> <a href="${CONVERSATION_URL}">Open in Boom</a></p>
    <p><strong>Last sender detected:</strong> ${summary.lastSender}</p>
    <p><strong>Last message sample:</strong> ${summary.snippet || '(none)'} </p>
    <hr/>
    <p><em>– Automated alert</em></p>
  `;

  await transporter.sendMail({
    from: `${FROM_NAME} <${SMTP_USER}>`,
    to: toList,
    subject,
    html,
  });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  let finalUrl = CONVERSATION_URL;

  try {
    await openConversation(page, finalUrl);
    // If we were still on a generic page, try to resolve the final Boom link once more
    const resolved = page.url();
    finalUrl = resolved || finalUrl;

    const result = await analyzeConversation(page);

    console.log('Second check result:', JSON.stringify(result, null, 2));

    const shouldAlert = !result.ok && (result.reason === 'guest_unanswered' || result.reason === 'heuristic');

    if (shouldAlert) {
      await sendAlertEmail({ lastSender: result.lastSender, snippet: result.snippet });
      console.log('Alert sent.');
    } else {
      console.log('No alert sent (not confident or not guest/unanswered).');
    }
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
})();
