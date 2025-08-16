// check.js  — ESM (package.json has { "type": "module" })
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import nodemailer from 'nodemailer';

// ----------- config (keeps your existing secrets) -----------
const {
  BOOM_USER,
  BOOM_PASS,
  FROM_NAME,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  ROHIT_EMAIL,        // primary recipient (kept)
  ALERT_TO,           // optional override (comma-separated)
  ALERT_CC,           // optional CC (comma-separated)
  CONVERSATION_URL,   // optional direct URL (Power Automate may pass this)
  SLA_MINUTES,        // optional override, default 5
} = process.env;

const SLA = Number(SLA_MINUTES || 5);

// Fallback recipients: prefer ALERT_TO, else ROHIT_EMAIL.
function getRecipients() {
  const to = (ALERT_TO && ALERT_TO.trim()) || (ROHIT_EMAIL && ROHIT_EMAIL.trim());
  const cc = (ALERT_CC && ALERT_CC.trim()) || '';
  return { to, cc };
}

// ---------- helpers ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function saveArtifact(page, name) {
  try { await page.screenshot({ path: `/tmp/${name}.png`, fullPage: true }); } catch {}
}

async function saveText(name, text) {
  try { await fs.writeFile(`/tmp/${name}`, text, 'utf8'); } catch {}
}

function parseMinutesAgoMaybe(tsText) {
  // We only use this if Boom shows relative text like “5 minutes ago”.
  if (!tsText) return null;
  const t = tsText.trim().toLowerCase();
  const m = t.match(/(\d+)\s*(min|minute)s?\s*ago/);
  if (m) return Number(m[1] || 0);
  return null;
}

// ---------- login flow ----------
async function loginIfNeeded(page) {
  const url = page.url();

  // If we’re on login page, sign in.
  if (url.includes('/login')) {
    // Try simple email/password form (selectors are tolerant).
    const emailSel = 'input[type="email"], input[name="email"], input[autocomplete="username"]';
    const passSel  = 'input[type="password"], input[name="password"], input[autocomplete="current-password"]';
    const btnSel   = 'button:has-text("Log in"), button:has-text("Sign in"), button[type="submit"]';

    await page.waitForSelector(emailSel, { timeout: 15000 });
    await page.fill(emailSel, BOOM_USER);
    await page.fill(passSel, BOOM_PASS);
    await page.click(btnSel);
    await page.waitForLoadState('networkidle', { timeout: 45000 });
  }
}

// ---------- detection ----------
async function getLastMessageInfo(page) {
  // Scroll to bottom slowly so virtualized lists render latest items
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('End');
    await sleep(200);
  }

  // Pick a broad transcript container
  const threadLocator = page.locator(
    '[data-testid*="conversation"], [data-test*="conversation"], [class*="conversation"], main'
  );

  // Give Playwright a little time to see something
  let hasThread = true;
  try {
    await threadLocator.first().waitFor({ state: 'visible', timeout: 4000 });
  } catch {
    hasThread = false;
  }

  const info = await page.evaluate(() => {
    const out = {
      lastSender: 'Unknown',
      hasAgentSuggestion: false,
      snippet: '',
      reason: '',
      tsText: '',
      ts: null,
    };

    // Find a transcript-ish root
    const root =
      document.querySelector('[data-testid*="conversation"]') ||
      document.querySelector('[data-test*="conversation"]') ||
      document.querySelector('[class*="conversation"]') ||
      document.querySelector('main') ||
      document.body;

    if (!root) {
      out.reason = 'no_selector';
      return out;
    }

    // Helper: is an AI suggestion card?
    function isSuggestion(el) {
      // Cards typically contain "Agent" + "Confidence" + REJECT/APPROVE
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (!t) return false;
      const hasAgent = /\bAgent\b/i.test(t);
      const hasConf  = /\bConfidence\b/i.test(t);
      const hasAct   = /(REJECT|APPROVE|REGENERATE)/i.test(t);
      // Also, suggestion cards are often bordered blocks with buttons within
      const hasButtons = el.querySelector('button');
      return (hasAgent && hasConf && hasAct) || (hasAgent && hasButtons);
    }

    // Collect the last ~400 leaf-ish nodes to inspect bottom area
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    const elems = [];
    let node;
    while ((node = walker.nextNode())) elems.push(node);
    const last = elems.slice(-400);

    // Skip suggestion cards and grab candidate “header lines” that mention "via"
    const headers = last.filter(el => {
      if (isSuggestion(el)) return false;
      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!txt) return false;
      // Boom keeps “via whatsapp / via channel” in English even when the chat is Arabic.
      return txt.includes(' via ') || /^via\s/i.test(txt) || /\s•\s*via\s/i.test(txt);
    });

    // If there is any suggestion card near the bottom, mark it so we don’t consider it an agent reply
    out.hasAgentSuggestion = last.some(isSuggestion);

    // Take the last suitable header
    const headerEl = headers.reverse().find(Boolean);
    if (!headerEl) {
      out.reason = 'no_header';
      return out;
    }

    const headerText = (headerEl.textContent || '').replace(/\s+/g, ' ').trim();
    out.snippet = headerText.slice(0, 140);

    // Heuristic:
    // Guest header looks like:  "Nasser AlHarthi • via channel"
    // Agent header looks like:   "via whatsapp • Amal Alawad"
    const bulletIdx = headerText.indexOf('•');
    const viaIdx = headerText.toLowerCase().indexOf('via ');
    if (viaIdx !== -1 && bulletIdx !== -1) {
      out.lastSender = viaIdx < bulletIdx ? 'Agent' : 'Guest';
    } else if (/^via\s/i.test(headerText)) {
      out.lastSender = 'Agent';
    } else if (/•\s*via\s/i.test(headerText)) {
      out.lastSender = 'Guest';
    } else {
      out.lastSender = 'Unknown';
      out.reason = 'ambiguous_header';
    }

    // Try to pull a time-ish element near the header
    const timeEl =
      headerEl.closest('*')?.querySelector('time, [class*="time"], [class*="timestamp"]') ||
      headerEl.parentElement?.querySelector('time, [class*="time"], [class*="timestamp"]');

    out.tsText = timeEl ? (timeEl.textContent || '').trim() : '';

    return out;
  });

  // Save the transcript region HTML for debugging
  try {
    const thread = await threadLocator.first();
    const html = await thread.evaluate(el => el.outerHTML);
    await saveText('thread.html', html);
  } catch {
    // fallback: whole page
    await saveText('thread.html', await page.content());
  }

  return info;
}

// ---------- mail ----------
async function sendAlertEmail(subject, html) {
  const { to, cc } = getRecipients();
  if (!to) {
    console.log('Alert needed, but no recipients are configured.');
    return;
  }

  const transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  await transport.sendMail({
    from: `"${FROM_NAME || 'Boom SLA Bot'}" <${SMTP_USER}>`,
    to,
    cc: cc || undefined,
    subject,
    html,
  });
}

// ---------- main ----------
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext();
  const page = await context.newPage();

  const url = (CONVERSATION_URL && CONVERSATION_URL.trim()) || process.argv.slice(2).join(' ').trim();
  if (!url) {
    console.log('No CONVERSATION_URL provided — nothing to check.');
    await browser.close();
    process.exit(0);
  }

  console.log('Navigating to conversation…');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 60000 });

  // If we hit login, sign in then go again.
  await loginIfNeeded(page);
  if (!page.url().includes('/dashboard/guest-experience/')) {
    // Sometimes redirect to /login after initial load
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 60000 });
  }

  // settle & screenshot
  await sleep(600);
  await saveArtifact(page, 'boom-1');

  const info = await getLastMessageInfo(page);

  // try one more tiny settle and shot
  await sleep(400);
  await saveArtifact(page, 'boom-2');

  // minutes ago (best effort from text; many Boom threads don’t expose a relative time)
  const minsAgo = parseMinutesAgoMaybe(info.tsText);

  // Decide whether to alert:
  //  - must be guest last
  //  - and (minsAgo >= SLA) OR (no time available but we still want to flag older threads manually)
  let shouldAlert = false;
  let decision = 'no_breach';

  if (info.lastSender === 'Guest') {
    if (minsAgo == null) {
      // we don’t know the age -> conservative: treat as breach candidate
      shouldAlert = true;
      decision = 'guest_last_no_age';
    } else if (minsAgo >= SLA) {
      shouldAlert = true;
      decision = 'guest_last_sla';
    } else {
      decision = 'guest_last_but_within_sla';
    }
  } else if (info.lastSender === 'Unknown') {
    decision = info.reason || 'unknown';
  } else {
    decision = 'agent_last';
  }

  const result = {
    ok: !shouldAlert,
    reason: decision,
    lastSender: info.lastSender,
    hasAgentSuggestion: info.hasAgentSuggestion,
    snippet: info.snippet,
    tsText: info.tsText,
    minsAgo,
  };

  console.log('Second check result:', JSON.stringify(result, null, 2));

  // Save summary JSON artifact for deeper debugging
  await saveText('summary.json', JSON.stringify(result, null, 2));

  if (shouldAlert) {
    const subject = `SLA breach (>${SLA} min?): Boom guest message unanswered`;
    const html = `
      <div style="font-family:system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;">
        <p>Hi,</p>
        <p>A Boom guest message appears unanswered beyond the SLA.</p>
        <p><b>Conversation:</b> <a href="${url}">Open in Boom</a></p>
        <p><b>Last sender detected:</b> ${info.lastSender}</p>
        <p><b>Last message sample:</b> ${info.snippet || '(none)'} </p>
        <p><b>Timestamp text:</b> ${info.tsText || '(n/a)'} — <b>minsAgo:</b> ${minsAgo ?? '(unknown)'} </p>
        <p style="margin-top:16px;color:#777">– Automated alert</p>
      </div>
    `;
    await sendAlertEmail(subject, html);
  } else {
    console.log('No alert sent (not guest/unanwered beyond SLA).');
  }

  await browser.close();
  process.exit(0);
})().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
