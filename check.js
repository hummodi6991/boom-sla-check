// check.js
// Node ESM. Your package.json should have: { "type": "module" }
import { chromium } from 'playwright';
import nodemailer from 'nodemailer';

const {
  CONVERSATION_URL,            // optional; Power Automate or manual
  BOOM_USER,
  BOOM_PASS,

  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  FROM_NAME,                   // e.g., "Oaktree Boom SLA Bot"
  ROHIT_EMAIL,                 // primary recipient
} = process.env;

const TIMEOUT = 30_000;        // per wait
const NAV_TIMEOUT = 60_000;    // initial nav
const ART_BASE = '/tmp/boom';  // artifact prefix

// --- helpers ---------------------------------------------------------------

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function saveShot(page, tag) {
  const f = `${ART_BASE}-${tag}.png`;
  try { await page.screenshot({ path: f, fullPage: true }); } catch {}
}

async function loginIfNeeded(page) {
  // If redirected to login, fill BOOM credentials
  const isLogin = await page.locator('input[type="email"], input[name="email"]').first().isVisible().catch(() => false);
  if (!isLogin) return;

  if (!BOOM_USER || !BOOM_PASS) throw new Error('Missing BOOM_USER/BOOM_PASS');

  await page.fill('input[type="email"], input[name="email"]', BOOM_USER, { timeout: TIMEOUT });
  // Not all forms use type="password"
  const pwSel = 'input[type="password"], input[name="password"]';
  await page.fill(pwSel, BOOM_PASS, { timeout: TIMEOUT });

  // Try common submit buttons
  const btn = page.locator('button:has-text("Log in"), button:has-text("Sign in"), button[type="submit"]');
  if (await btn.first().isVisible().catch(() => false)) {
    await btn.first().click({ timeout: TIMEOUT });
  } else {
    // Fallback: press Enter in password field
    await page.locator(pwSel).press('Enter');
  }

  await page.waitForLoadState('load', { timeout: NAV_TIMEOUT });
  await sleep(1000);
}

async function ensureConversationLoaded(page) {
  // Scroll to bottom a couple of times to force lazy content
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(400);
  }

  // Quick sanity: presence of the composer input strongly indicates we’re in a conversation
  const composerVisible = await page.locator('textarea, [placeholder*="Type your message"]').first().isVisible().catch(() => false);
  if (!composerVisible) {
    return { ok: false, reason: 'not_conversation' };
  }
  return { ok: true };
}

async function detectAgentSuggestion(page) {
  // Agent suggestions consistently show action buttons in English
  // APPROVE / REJECT (and often REGENERATE). We only need APPROVE to be robust.
  const approve = page.locator('role=button[name=/^approve$/i], button:has-text("APPROVE")');
  return await approve.first().isVisible().catch(() => false);
}

async function detectLastSender(page) {
  // Strategy:
  // 1) Find all visible elements in the message column that contain "via ".
  // 2) Take the last one and classify:
  //    - text starts with "via " => likely Agent
  //    - text includes " • via " after a name => likely Guest
  // 3) Try to grab a short snippet from the bubble body near that header.
  //
  // We limit the scan to the central column by anchoring near the composer.
  const data = await page.evaluate(() => {
    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    }

    const results = [];
    // Anchor: the composer area is usually near the bottom; walk up to find the column
    const composer = document.querySelector('textarea, [placeholder*="Type your message"]');
    let column = composer?.closest('main, [role="main"], [class*="conversation"], [class*="thread"]') || document.body;

    const all = column.querySelectorAll('*');
    for (const el of all) {
      if (!isVisible(el)) continue;
      const t = (el.textContent || '').trim();
      if (!t) continue;
      // English UI shows "via whatsapp" / "via channel" in Latin letters
      if (/via\s+(whatsapp|channel)/i.test(t)) {
        // Exclude obvious Agent suggestion wrapper by presence of action buttons nearby
        const hasApprove = el.closest('article, section, div')?.querySelector('button, a')?.textContent?.toLowerCase().includes('approve');
        results.push({
          text: t.replace(/\s+/g, ' '),
          html: el.innerHTML.slice(0, 400),
          hasApprove: !!hasApprove,
          snippet: (() => {
            // Try to find nearby bubble text (previous sibling or parent)
            let s = '';
            const cand = el.parentElement;
            if (cand) {
              // search a few preceding siblings for text blocks
              let prev = cand.previousElementSibling;
              let hop = 0;
              while (prev && hop < 5 && s.length < 160) {
                const tt = prev.textContent?.trim() || '';
                if (tt && !/via\s+(whatsapp|channel)/i.test(tt)) {
                  s = tt;
                  break;
                }
                prev = prev.previousElementSibling; hop++;
              }
            }
            return s.replace(/\s+/g, ' ').slice(0, 120);
          })(),
        });
      }
    }
    return results;
  });

  if (!data || data.length === 0) {
    return { lastSender: 'Unknown', snippet: '', reason: 'no_selector' };
  }

  const last = data[data.length - 1];

  // Heuristic classification:
  // - Agent message headers often *start* with "via ..."
  // - Guest message headers generally look like "Name • via ...", i.e., "via ..." is toward the end.
  // - If the element is inside the suggestion card (has approve), it’s NOT a sent agent message; treat separately.
  let lastSender = 'Unknown';
  const txt = last.text;
  if (/^via\s+/i.test(txt)) {
    // Likely a human Agent sent a message
    lastSender = 'Agent';
  } else if (/•\s*via\s+/i.test(txt)) {
    // Likely Guest (Name • via whatsapp/channel)
    lastSender = 'Guest';
  }

  // If this header lives inside an Agent suggestion wrapper (approve visible nearby),
  // do NOT call it an Agent message; keep lastSender as Guest if it fits that pattern.
  // (In practice, suggestion cards have their own header area; this guard prevents misclassification.)
  if (last.hasApprove) {
    // Header belongs to the suggestion card itself—don’t treat as a real reply.
    // Re-classify to Guest if it matches the guest pattern; otherwise Unknown.
    if (/•\s*via\s+/i.test(txt)) {
      lastSender = 'Guest';
    } else {
      lastSender = 'Unknown';
    }
  }

  return {
    lastSender,
    snippet: last.snippet || '',
    reason: lastSender === 'Unknown' ? 'heuristic' : 'ok',
  };
}

function buildTransport() {
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    return null;
  }
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

async function sendAlertEmail({ url, lastSender, snippet }) {
  const to = ROHIT_EMAIL;        // keep your current recipient
  const cc = SMTP_USER || '';    // copy the mailbox you own (as you requested)
  const fromName = FROM_NAME || 'Oaktree Boom SLA Bot';

  if (!to) {
    console.log('Alert needed, but no ROHIT_EMAIL is configured.');
    return;
  }
  const transport = buildTransport();
  if (!transport) {
    console.log('Alert needed, but SMTP settings are not fully set.');
    return;
  }

  const subj = 'SLA breach (>0 min): Boom guest message unanswered';
  const html = `
    <p>Hi team,</p>
    <p>A Boom guest message appears unanswered.</p>
    <p><b>Conversation:</b> <a href="${url}">Open in Boom</a></p>
    <p><b>Last sender detected:</b> ${lastSender}</p>
    <p><b>Last message sample:</b> ${snippet ? snippet : '(empty)'} </p>
    <p>— Automated alert</p>
  `;

  await transport.sendMail({
    from: `"${fromName}" <${SMTP_USER}>`,
    to,
    cc,
    subject: subj,
    html,
  });
}

// --- main ------------------------------------------------------------------

(async () => {
  const url = (process.argv[2] && !process.argv[2].startsWith('--'))
    ? process.argv[2]
    : (CONVERSATION_URL || '').trim();

  if (!url) {
    console.log('Second check result:', {
      ok: false,
      reason: 'no_url',
      lastSender: 'Unknown',
      hasAgentSuggestion: false,
      snippet: '',
    });
    process.exit(0);
  }

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  try {
    await page.goto(url, { timeout: NAV_TIMEOUT, waitUntil: 'load' });
    await loginIfNeeded(page);
    await ensureConversationLoaded(page);

    // Always scroll to bottom and take a shot for debugging
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(400);
    await saveShot(page, 't1');

    // Detect presence of an Agent suggestion card (unapproved)
    const hasSuggestion = await detectAgentSuggestion(page);

    // Detect last human sender (guest vs agent)
    const { lastSender, snippet, reason } = await detectLastSender(page);

    // Decide on alert:
    // Fire when last human sender is Guest AND there is an unapproved Agent suggestion visible.
    const needsAlert = (lastSender === 'Guest' && hasSuggestion === true);

    const result = {
      ok: !needsAlert,
      reason: needsAlert ? 'guest_unanswered' : reason || 'no_breach',
      lastSender,
      hasAgentSuggestion: hasSuggestion,
      snippet: snippet || '',
    };

    console.log('Second check result:', result);

    if (needsAlert) {
      await sendAlertEmail({ url, lastSender, snippet });
    }

    await saveShot(page, 't2');
  } catch (err) {
    console.log('Second check result:', {
      ok: false,
      reason: 'exception',
      lastSender: 'Unknown',
      hasAgentSuggestion: false,
      snippet: (err && err.message) ? String(err.message).slice(0, 160) : '',
    });
    await saveShot(page, 'err');
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
