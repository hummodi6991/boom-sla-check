// check.js
// Boom SLA checker – robust "last sender" detection from header line.
// Works with WhatsApp/Email/etc channels and emoji-only messages.

const { chromium } = require('playwright');
const nodemailer = require('nodemailer');

const BOOM_USER   = process.env.BOOM_USER;
const BOOM_PASS   = process.env.BOOM_PASS;
const CONVO_URL   = process.argv.slice(2).join(' ') || process.env.CONVERSATION_URL || '';
const SMTP_HOST   = process.env.SMTP_HOST;
const SMTP_PORT   = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER   = process.env.SMTP_USER;
const SMTP_PASS   = process.env.SMTP_PASS;
const FROM_NAME   = process.env.FROM_NAME || 'Oaktree Boom SLA Bot';
const ROHIT_EMAIL = process.env.ROHIT_EMAIL || '';

/** Build recipient list: send to Rohit and to the mailbox we’re sending from */
const ALERT_TO = [ROHIT_EMAIL, SMTP_USER].filter(Boolean).join(',');

/** Simple helpers **/
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const nowIso = () => new Date().toISOString().replace(/[:.]/g, '-');

async function saveArtifacts(page, tag) {
  try {
    const shot = `/tmp/shot_${tag}.png`;
    const html = `/tmp/page_${tag}.html`;
    await page.screenshot({ path: shot, fullPage: true });
    await require('fs').promises.writeFile(html, await page.content(), 'utf8');
  } catch (_) {}
}

/** Login if the dashboard login is shown */
async function loginIfNeeded(page) {
  // Heuristic: Boom login has "Dashboard Login" and two inputs
  const hasLogin = await page.locator('text=Dashboard Login').first().isVisible().catch(() => false);
  if (!hasLogin) return;

  await page.fill('input[type="email"]', BOOM_USER);
  await page.fill('input[type="password"]', BOOM_PASS);
  await Promise.all([
    page.waitForLoadState('networkidle'),
    page.click('button:has-text("Login")')
  ]);
  // allow redirects to settle
  await sleep(1500);
}

/** Follow short/redirect tracking to final Boom URL */
async function resolveFinalUrl(page, url) {
  if (!url) return '';
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(()=>{});
  return page.url();
}

/** Scroll to bottom so latest headers are in DOM/viewport */
async function scrollToBottom(page) {
  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, 2000);
    await sleep(200);
  }
  await page.keyboard.press('End').catch(()=>{});
  await sleep(500);
}

/**
 * Core: find the bottom-most “message header line” and classify sender.
 * We look for either:
 *   Guest:  "<name> • via <channel>"   => has "• via"
 *   Agent:  "via <channel> • <name>"   => has "via ... •"
 * We ignore AI cards/system rows by excluding elements that contain obvious
 * markers like "Agent" label with APPROVE/REJECT buttons, "Fun level changed",
 * "Escalation", "Detected Policy", etc.
 */
async function detectLastSender(context) {
  return await context.evaluate(() => {
    function visible(el) {
      const style = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return style && style.visibility !== 'hidden' && style.display !== 'none' && r.width > 0 && r.height > 0;
    }

    const GUEST_RE = /•\s*via\s*(channel|email|sms|whatsapp|instagram|facebook|webchat|airbnb|booking|vrbo)?/i;
    const AGENT_RE = /\bvia\s*(channel|email|sms|whatsapp|instagram|facebook|webchat|airbnb|booking|vrbo)?\s*•/i;

    // Collect many textual blocks; limit to avoid huge pages.
    const nodes = Array.from(document.querySelectorAll('div, p, span'))
      .filter(n => {
        const t = (n.innerText || '').trim();
        if (t.length < 6) return false;
        if (!visible(n)) return false;
        // Must contain "via" and a bullet to be considered a header
        if (!t.includes('via') || !t.includes('•')) return false;

        // Exclude AI cards and system rows
        const txt = t.toLowerCase();
        if (txt.includes('agent') && (txt.includes('approve') || txt.includes('regenerate') || txt.includes('reject'))) return false;
        if (txt.includes('fun level changed') || txt.includes('escalation') || txt.includes('detected policy')) return false;

        // Likely header
        return GUEST_RE.test(t) || AGENT_RE.test(t);
      })
      .map(el => {
        const rect = el.getBoundingClientRect();
        const text = (el.innerText || '').trim();
        let who = 'Unknown';
        let pattern = '';
        if (GUEST_RE.test(text) && !AGENT_RE.test(text)) { who = 'Guest'; pattern = 'guest_header'; }
        else if (AGENT_RE.test(text) && !GUEST_RE.test(text)) { who = 'Agent'; pattern = 'agent_header'; }
        else if (GUEST_RE.test(text) && AGENT_RE.test(text)) {
          // Prefer whichever occurs last in the line
          const gi = text.search(GUEST_RE);
          const ai = text.search(AGENT_RE);
          if (gi > ai) { who = 'Guest'; pattern = 'guest_header_both'; }
          else { who = 'Agent'; pattern = 'agent_header_both'; }
        }
        return {
          y: rect.top + rect.height / 2,
          textSample: text.slice(0, 160),
          who,
          pattern
        };
      });

    if (!nodes.length) {
      return { ok: false, reason: 'no_header_found', lastSender: 'Unknown', snippet: '' };
    }

    // Bottom-most header = latest message header
    nodes.sort((a, b) => a.y - b.y);
    const last = nodes[nodes.length - 1];

    return {
      ok: last.who !== 'Unknown',
      reason: last.pattern || 'header',
      lastSender: last.who,
      snippet: last.textSample
    };
  });
}

/** Send the alert email */
async function sendAlert({ toList, fromEmail, fromName, conversationUrl, lastSender, snippet }) {
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });

  const subject = 'SLA breach (>5 min): Boom guest message unanswered';
  const html = `
    <p>Hi Rohit,</p>
    <p>A Boom guest message appears unanswered after 5 minutes.</p>
    <p><b>Conversation:</b> <a href="${conversationUrl}">Open in Boom</a><br/>
       <b>Last sender detected:</b> ${lastSender || 'Unknown'}<br/>
       <b>Last message sample:</b> ${snippet ? `<i>${snippet}</i>` : '(emoji/blank)'}</p>
    <p>– Automated alert</p>`;

  await transporter.sendMail({
    from: `"${fromName}" <${fromEmail}>`,
    to: toList,
    subject,
    html
  });
}

/** MAIN */
(async () => {
  if (!BOOM_USER || !BOOM_PASS) {
    console.error('Missing required env vars: BOOM_USER/BOOM_PASS');
    process.exit(2);
  }
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    console.error('Missing SMTP configuration (SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS).');
    process.exit(2);
  }
  if (!CONVO_URL) {
    console.error('Missing conversation URL (pass as arg or set CONVERSATION_URL).');
    process.exit(2);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  let finalUrl = CONVO_URL;
  try {
    // Step 1: open link (might be a short/redirect link from Power Automate)
    finalUrl = await resolveFinalUrl(page, CONVO_URL);
    // Step 2: login if needed
    await loginIfNeeded(page);
    // Step 3: if we landed on dashboard, navigate again (some redirects need a second go)
    if (!page.url().includes('/dashboard/')) {
      await page.goto(finalUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(()=>{});
      await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(()=>{});
      await loginIfNeeded(page);
    }

    await saveArtifacts(page, 't1_login');

    // Step 4: load conversation content and scroll to bottom
    await scrollToBottom(page);
    await saveArtifacts(page, 't2_bottom');

    // Step 5: scan main frame + iframes for the last sender header
    const frames = [page, ...page.frames()];
    let best = { ok: false, reason: 'no_header_found', lastSender: 'Unknown', snippet: '' };
    for (const f of frames) {
      try {
        const r = await detectLastSender(f);
        // Prefer a positive identification over unknown
        if (r.ok) { best = r; }
        // keep scanning; bottom-most in main frame normally wins, but we use first ok match
      } catch (_) {}
    }

    // Decide alert: if lastSender is Guest -> unanswered (we already are at the bottom)
    const shouldAlert = best.ok && best.lastSender === 'Guest';

    const outcome = {
      ok: best.ok,
      reason: best.reason,
      lastSender: best.lastSender,
      snippet: best.snippet || ''
    };

    console.log('Second check result:', outcome);

    if (shouldAlert) {
      await sendAlert({
        toList: ALERT_TO,
        fromEmail: SMTP_USER,   // sender is the authenticated mailbox
        fromName: FROM_NAME,
        conversationUrl: finalUrl,
        lastSender: best.lastSender,
        snippet: best.snippet
      });
    } else {
      console.log('No alert sent (not confident or not guest/unanswered).');
    }

    // Always save artifacts at the end too
    await saveArtifacts(page, 't2_final');
  } catch (err) {
    console.error(err);
    await saveArtifacts(page, 'error');
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
