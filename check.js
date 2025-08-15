// check.js
// Run with: node check.js --conversation "<Boom conversation URL or tracking URL>"
//
// Env vars required (set as GitHub Action secrets):
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
//   MAIL_FROM, MAIL_TO (comma-separated to send to multiple people)
// Optional:
//   ALERT_THRESHOLD_SEC (default 120) - delay between T1 and T2
//   HEADFUL (set to "1" to see the browser in local tests)

const { chromium } = require('playwright');
const nodemailer = require('nodemailer');
const fs = require('fs/promises');
const path = require('path');

function arg(name, def = '') {
  const ix = process.argv.indexOf(`--${name}`);
  return ix >= 0 ? process.argv[ix + 1] : def;
}

const CONVERSATION_URL = arg('conversation') || process.env.CONVERSATION_URL || '';
if (!CONVERSATION_URL) {
  console.error('Missing --conversation "<URL>"');
  process.exit(1);
}

const ALERT_THRESHOLD_SEC = parseInt(process.env.ALERT_THRESHOLD_SEC || '120', 10);

async function saveArtifact(page, label) {
  const dir = '/tmp';
  const shot = path.join(dir, `shot_${label}.png`);
  const html = path.join(dir, `page_${label}.html`);
  try {
    await page.screenshot({ path: shot, fullPage: true });
    const content = await page.content();
    await fs.writeFile(html, content, 'utf8');
  } catch (e) {
    console.warn('Artifact save failed:', e.message);
  }
}

function mkTransport() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) throw new Error('Missing SMTP_* env vars');
  return nodemailer.createTransport({
    host, port, secure: port === 465,
    auth: { user, pass },
  });
}

async function sendAlert({ boomUrl, lastSender, snippet }) {
  const transporter = mkTransport();
  const from = process.env.MAIL_FROM;
  const to = (process.env.MAIL_TO || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!from || !to.length) throw new Error('Missing MAIL_FROM or MAIL_TO');

  const subject = 'SLA breach (>5 min): Boom guest message unanswered';
  const html = `
    <p>Hi Rohit,</p>
    <p>A Boom guest message appears unanswered after ${ALERT_THRESHOLD_SEC/60} minutes.</p>
    <p><b>Conversation:</b> <a href="${boomUrl}">Open in Boom</a><br/>
       <b>Last sender detected:</b> ${lastSender || 'Unknown'}<br/>
       <b>Last message sample:</b><br/>
       <i>${snippet || '(empty)'}</i>
    </p>
    <p>– Automated alert</p>
  `;

  const info = await transporter.sendMail({ from, to, subject, html });
  console.log('SMTP message id:', info.messageId);
}

// --- DOM helpers executed inside the page context ---
function pageScript() {
  // returns array of candidate human message containers (in DOM order)
  function findHumanMessageNodes() {
    // Human bubbles consistently have a tiny footer like “via channel • Name” or “via email • Auto”
    const footers = Array.from(
      document.querySelectorAll('body *')
    ).filter(el => {
      const t = (el.textContent || '').trim();
      if (!t) return false;
      const s = t.toLowerCase();
      return s.includes('via channel') || s.includes('via email');
    });

    // For each footer, climb to a sensible container for that single message
    function messageContainer(el) {
      // climb until a box that has some padding and not the entire feed
      let cur = el;
      for (let i = 0; i < 6; i++) {
        if (!cur) break;
        const txt = (cur.innerText || '').toLowerCase();
        const cls = cur.className ? String(cur.className) : '';
        const style = window.getComputedStyle(cur);
        const height = cur.getBoundingClientRect().height;

        // Heuristics: container whose text includes the footer and some content,
        // not the whole list, and not an Agent suggestion card.
        const hasApprove = /\bapprove\b/i.test(txt) || /\breject\b/i.test(txt);
        const hasAgentHeader = /\bagent\b/i.test(txt) && /\bconfidence\b/i.test(txt);
        const looksLikeMsg = height > 40 && style.display !== 'inline' && style.visibility !== 'hidden';

        if (looksLikeMsg && !hasApprove && !hasAgentHeader) {
          return cur;
        }
        cur = cur.parentElement;
      }
      return el;
    }

    const uniq = [];
    for (const f of footers) {
      const c = messageContainer(f);
      if (!c) continue;
      if (!uniq.includes(c)) uniq.push(c);
    }
    return uniq;
  }

  function sanitizeText(s) {
    if (!s) return '';
    // Remove UI words not part of user message
    const lines = s.split('\n').map(x => x.trim()).filter(Boolean).filter(line => {
      const L = line.toLowerCase();
      if (L.includes('approve') || L.includes('reject')) return false;
      if (L.includes('confidence')) return false;
      if (L.includes('escalation')) return false;
      if (L.includes('detected policy')) return false;
      if (L.includes('fun level changed')) return false;
      if (L.startsWith('via channel') || L.startsWith('via email')) return false;
      return true;
    });
    return lines.join(' ').replace(/\s+/g, ' ').trim();
  }

  function lastMessageInfo() {
    const nodes = findHumanMessageNodes();
    if (!nodes.length) return { ok:false, reason:'no_selector' };

    const width = document.documentElement.clientWidth || window.innerWidth || 1200;
    const items = nodes.map(el => {
      const rect = el.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const side = centerX < width / 2 ? 'left' : 'right'; // common chat layout
      const raw = el.innerText || '';
      const snippet = sanitizeText(raw).slice(0, 180);

      // Footer for hints
      const rawLower = raw.toLowerCase();
      const isAutoEmail = rawLower.includes('via email') && rawLower.includes('auto');

      // Identify if this is clearly an “Agent suggestion” card (extra guard)
      const isSuggestion = (/\bagent\b/i.test(raw) && /\bconfidence\b/i.test(raw)) ||
                           (/\bapprove\b/i.test(raw) && /\breject\b/i.test(raw));

      return { el, side, raw, snippet, isAutoEmail, isSuggestion };
    });

    // Drop suggestion cards just in case
    const filtered = items.filter(i => !i.isSuggestion);
    const last = (filtered.length ? filtered : items)[ (filtered.length ? filtered : items).length - 1 ];

    // Classify sender
    let lastSender = 'Unknown';
    if (last.isAutoEmail) lastSender = 'Agent';
    else lastSender = (last.side === 'left') ? 'Guest' : 'Agent';

    return {
      ok: !!last.snippet,
      reason: last.snippet ? 'ok' : 'no_text',
      lastSender,
      snippet: last.snippet
    };
  }

  return { lastMessageInfo: lastMessageInfo() };
}

// --- Playwright flow ---
async function runCheck() {
  const browser = await chromium.launch({
    headless: process.env.HEADFUL ? false : true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  // 1) Navigate (handle tracking links automatically)
  console.log(`Run node check.js --conversation "${CONVERSATION_URL}"`);
  await page.goto(CONVERSATION_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });

  // If it’s a tracking/redirect link, wait for the real Boom URL to appear
  try {
    await page.waitForLoadState('load', { timeout: 30_000 });
  } catch (_) {}
  // If still not on app.boomnow.com, try to follow link targets inside the page
  if (!/app\.boomnow\.com/.test(page.url())) {
    // Some trackers show an <a> “continue” – click best candidate
    const candidate = page.locator('a[href*="app.boomnow.com"]').first();
    if (await candidate.count()) {
      await candidate.click({ timeout: 10_000 });
      await page.waitForLoadState('load', { timeout: 30_000 });
    }
  }

  const finalUrl = page.url();
  console.log('Resolved Boom URL:', finalUrl);

  // 2) If the login page is shown, Playwright will still be able to render it, but
  // we only rely on DOM text around “via channel / via email”, which appears post-login.
  // Try to wait for anything meaningful; still save artifacts regardless.
  await saveArtifact(page, 't1');

  // Snapshot T1
  const t1 = await page.evaluate(pageScript);
  // If we’re on a login page or haven’t reached the conversation feed yet,
  // t1 may be { ok:false, reason:'no_selector' }. We still continue to T2 after a delay
  // to give Boom time to render after SSO.
  await page.waitForTimeout(ALERT_THRESHOLD_SEC * 1000);

  // Snapshot T2
  await saveArtifact(page, 't2');
  const t2 = await page.evaluate(pageScript);

  // Logging: this is what you see in the Actions log
  console.log('Second check result:', {
    ok: t2.lastMessageInfo?.ok || false,
    reason: t2.lastMessageInfo?.reason || 'unknown',
    lastSender: t2.lastMessageInfo?.lastSender || 'Unknown',
    snippet: t2.lastMessageInfo?.snippet || ''
  });

  let shouldAlert = false;
  let lastSender = t2.lastMessageInfo?.lastSender || 'Unknown';
  let snippet = t2.lastMessageInfo?.snippet || '';

  // Guardrails:
  // - Have text
  // - Last sender is Guest
  // - Message didn’t change between T1 and T2 (still unanswered)
  const t1Info = t1.lastMessageInfo || {};
  const t2Info = t2.lastMessageInfo || {};

  if (t2Info.ok && t2Info.lastSender === 'Guest') {
    // If t1 had a valid snippet and it matches, we’re confident nothing changed
    if (t1Info.ok && t1Info.snippet === t2Info.snippet) {
      shouldAlert = true;
    } else if (!t1Info.ok) {
      // If T1 was on login/redirect and T2 is the first valid read,
      // we can’t confirm stasis; be conservative and don’t alert.
      shouldAlert = false;
    }
  }

  if (shouldAlert) {
    await sendAlert({ boomUrl: finalUrl, lastSender, snippet });
  } else {
    console.log('No alert sent (not confident or not guest/unanswered).');
  }

  await browser.close();
}

runCheck().catch(err => {
  console.error(err);
  process.exit(1);
});
