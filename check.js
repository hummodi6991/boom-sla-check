// check.js — Boom SLA checker (ESM)
// Run with Node 20+. Repo "type" should be "module".

import { chromium } from 'playwright';
import nodemailer from 'nodemailer';

// ====== ENV ======
const {
  CONVERSATION_URL,      // tracking link or Boom URL (required)
  BOOM_USER,             // Boom login email
  BOOM_PASS,             // Boom login password
  SMTP_HOST,             // e.g., smtp.gmail.com
  SMTP_PORT,             // 465 or 587
  SMTP_USER,             // the SMTP username (and default From address)
  SMTP_PASS,             // the SMTP password / app password
  FROM_NAME = 'Oaktree Boom SLA Bot',
  ALERT_TO,              // comma/space-separated recipients; SMTP_USER is added automatically if missing
  MIN_AGE_MINUTES = '5', // SLA window in minutes
} = process.env;

if (!CONVERSATION_URL) {
  console.error('Missing CONVERSATION_URL');
  process.exit(2);
}

// ====== MAIL ======
function recipients() {
  const list = [];
  if (ALERT_TO) list.push(...ALERT_TO.split(/[,\s]+/).filter(Boolean));
  if (SMTP_USER && !list.includes(SMTP_USER)) list.push(SMTP_USER);
  return list;
}

async function sendMail({ subject, html }) {
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    console.warn('SMTP not fully configured; skipping email send.');
    return;
  }
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: String(SMTP_PORT) === '465',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  const to = recipients().join(',');
  const from = `"${FROM_NAME}" <${SMTP_USER}>`;
  await transporter.sendMail({ from, to, subject, html });
}

// ====== BROWSER HELPERS ======
async function loginIfNeeded(page) {
  // If we land on the Boom login page, fill credentials
  if (/\/login/i.test(page.url())) {
    await page.waitForLoadState('domcontentloaded');
    const email = page.locator('input[type="email"], input[name="email"]');
    const pass = page.locator('input[type="password"], input[name="password"]');
    await email.waitFor({ timeout: 15000 });
    await email.fill(BOOM_USER || '');
    await pass.fill(BOOM_PASS || '');
    // Submit
    const submit = page.locator(
      'button:has-text("Log in"), button:has-text("Login"), button[type="submit"], button:has-text("تسجيل الدخول")'
    ).first();
    await Promise.all([
      page.waitForLoadState('networkidle'),
      submit.click(),
    ]);
  }
}

async function gotoConversation(browser, url) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await loginIfNeeded(page);

  // Allow any in-app redirects to complete
  try { await page.waitForLoadState('networkidle', { timeout: 10000 }); } catch {}
  return { context, page };
}

// ====== DETECTION ======
function parseAgeOK(tsText, minutes) {
  // If we can't parse a time, err on alerting (return "older" = true)
  if (!tsText) return true;
  const m = tsText.match(/(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?/);
  if (!m) return true;
  let [ , hh, mm, ap ] = m;
  let h = parseInt(hh, 10);
  const minute = parseInt(mm, 10);
  if (ap) {
    const up = ap.toUpperCase();
    if (up === 'PM' && h < 12) h += 12;
    if (up === 'AM' && h === 12) h = 0;
  }
  const now = new Date();
  const t = new Date(now);
  t.setHours(h, minute, 0, 0);
  // If the parsed time is in the future (e.g., around midnight), assume it was yesterday
  if (t.getTime() > now.getTime()) t.setDate(t.getDate() - 1);
  const diffMin = (now.getTime() - t.getTime()) / 60000;
  return diffMin >= Number(minutes || 5);
}

async function detectState(page) {
  // Always scroll to the bottom before scraping
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(700);

  // Find any AI suggestion card (approve/reject) — robust & locale-agnostic
  const approveCount = await page.locator(
    'button:has-text("APPROVE"), button:has-text("Approve"), button:has-text("اعتماد")'
  ).count();
  const rejectCount = await page.locator(
    'button:has-text("REJECT"), button:has-text("Reject"), button:has-text("رفض")'
  ).count();
  const hasAgentSuggestion = approveCount > 0 && rejectCount > 0;

  // Find the lowest (latest) header that contains "via " (e.g., "via whatsapp" / "via channel"),
  // then extract the first bubble below it as the guest's last message.
  const data = await page.evaluate(() => {
    function getTextOrAlt(el) {
      const t = (el.innerText || '').trim();
      if (t) return t;
      const img = el.querySelector('img[alt]');
      if (img) return img.getAttribute('alt') || '';
      const aria = el.querySelector('[aria-label]');
      if (aria) return aria.getAttribute('aria-label') || '';
      return '';
    }

    const nodes = Array.from(document.querySelectorAll('body *'));
    const viaNodes = nodes.filter(n => /\svia\s/i.test(n.textContent || ''));
    let target = null;
    let y = -Infinity;
    for (const n of viaNodes) {
      const r = n.getBoundingClientRect?.();
      if (r && r.y >= y) { y = r.y; target = n; }
    }
    if (!target) return { lastSender: 'Unknown', snippet: '', tsText: '' };

    // Walk forward from the header to find the first meaningful bubble
    function nextBubble(start) {
      // search following nodes within the same section first
      let el = start;
      for (let i = 0; i < 60; i++) {
        const cand = el.nextElementSibling || el.firstElementChild;
        if (!cand) break;
        el = cand;

        // ignore system meta like "Fun level changed"
        const plain = (cand.textContent || '').toLowerCase();
        if (plain.includes('fun level changed') || plain.includes('changed from')) continue;

        // ignore cards with approve/reject buttons (AI suggestions — we detect them separately)
        if (cand.querySelector('button') && /(approve|reject|اعتماد|رفض)/i.test(plain)) continue;

        const txt = getTextOrAlt(cand).trim();
        if (txt.length > 0) return { el: cand, text: txt };
      }
      return { el: null, text: '' };
    }

    const nb = nextBubble(target);
    const snippet = nb.text || '';

    // Try to read a nearby time label
    let tsText = '';
    const carrier = nb.el || target;
    if (carrier) {
      const timeLike =
        carrier.querySelector('time') ||
        carrier.querySelector('[title*="AM"], [title*="PM"], [title*="am"], [title*="pm"]');
      if (timeLike) tsText = timeLike.getAttribute('title') || (timeLike.textContent || '').trim();

      if (!tsText) {
        // skim siblings up/down for something that looks like a HH:MM label
        const pool = Array.from((carrier.parentElement || document.body).querySelectorAll('*'));
        for (let i = pool.length - 1; i >= 0; i--) {
          const s = (pool[i].textContent || '').trim();
          if (/(\d{1,2}:\d{2}\s*(AM|PM|am|pm))/.test(s)) { tsText = RegExp.$1; break; }
        }
      }
    }

    return { lastSender: 'Guest', snippet, tsText };
  });

  return { ...data, hasAgentSuggestion };
}

// ====== MAIN ======
(async () => {
  const result = {
    ok: true,
    lastSender: 'Unknown',
    hasAgentSuggestion: false,
    snippet: '',
    reason: '',
    ts: new Date().toISOString(),
  };

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  let context, page;

  try {
    ({ context, page } = await gotoConversation(browser, CONVERSATION_URL));
    await page.waitForLoadState('domcontentloaded');
    await page.screenshot({ path: '/tmp/shot_t1.png', fullPage: true });

    const state = await detectState(page);
    Object.assign(result, state);

    const ageOK = parseAgeOK(state.tsText, MIN_AGE_MINUTES);
    const isBreach = state.lastSender === 'Guest' && state.hasAgentSuggestion === true && ageOK;

    result.ok = !isBreach;
    result.reason = isBreach ? 'guest_unanswered' : 'no_breach';

    if (isBreach) {
      const url = page.url();
      const html = `
        <p>Hi,</p>
        <p>A Boom guest message appears unanswered after ${MIN_AGE_MINUTES} minutes.</p>
        <p>
          <b>Conversation:</b> <a href="${url}">Open in Boom</a><br/>
          <b>Last sender detected:</b> ${state.lastSender}<br/>
          <b>Has AI suggestion:</b> ${state.hasAgentSuggestion ? 'Yes' : 'No'}<br/>
          <b>Last message sample:</b> ${state.snippet || '(non-text, e.g., emoji)'}
        </p>
        <p>– Automated alert</p>
      `;
      await sendMail({
        subject: `SLA breach (> ${MIN_AGE_MINUTES} min): Boom guest message unanswered`,
        html,
      });
    }

    await page.screenshot({ path: '/tmp/shot_t2.png', fullPage: true });
  } catch (err) {
    // Best-effort crash report
    result.ok = false;
    result.reason = 'exception';
    result.error = err?.message || String(err);
    try { await page?.screenshot({ path: '/tmp/shot_error.png', fullPage: true }); } catch {}
    try {
      await sendMail({
        subject: 'Boom SLA check failed',
        html: `<p>Checker crashed.</p><pre>${(err?.stack || err?.message || String(err)).slice(0, 2000)}</pre>`,
      });
    } catch {}
  } finally {
    console.log('Second check result:', JSON.stringify(result, null, 2));
    await context?.close();
    await browser.close();
  }
})();
