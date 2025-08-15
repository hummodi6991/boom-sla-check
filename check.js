/**
 * Boom SLA check
 * ------------------------------------------------------------
 * What it does
 *   1) Opens the Boom conversation URL (handles tracked/redirect links too)
 *   2) Logs in if needed (email/password from env)
 *   3) Scrolls to the bottom and finds the last REAL message:
 *        - Ignores AI/Agent suggestion cards (anything with APPROVE/REJECT)
 *        - Ignores toolbars and system chips
 *   4) Determines the sender (Guest vs Agent) using heuristics:
 *        - “via …” labels (via channel / via whatsapp / via email / via web / via sms)
 *        - presence of “Auto”/agent name
 *        - left/right alignment of the chat bubble (fallback)
 *   5) Checks if there is a later Agent message after the last Guest message
 *   6) Sends an email alert if last sender is Guest and not answered
 *   7) Saves artifacts (screens + html) to /tmp for GitHub Actions to upload
 *
 * Required env vars (set in your workflow):
 *   CONVERSATION_URL   – conversation link (can be a tracking link)
 *   BOOM_EMAIL         – Boom login email
 *   BOOM_PASSWORD      – Boom login password
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS – SMTP to send alert
 *   ALERT_FROM         – From: address (what shows as the bot)
 *   ALERT_TO           – Comma-separated list of recipients
 *
 * Optional:
 *   HEADLESS           – '0' to see the browser locally, default headless in CI
 *   SLA_MINUTES        – informational only (email copy), defaults to 5
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const nodemailer = require('nodemailer');

const {
  CONVERSATION_URL,
  BOOM_EMAIL,
  BOOM_PASSWORD,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  ALERT_FROM,
  ALERT_TO,
  SLA_MINUTES = '5',
  HEADLESS
} = process.env;

function required(name, v) {
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(2);
  }
}
required('CONVERSATION_URL', CONVERSATION_URL);
required('SMTP_HOST', SMTP_HOST);
required('SMTP_PORT', SMTP_PORT);
required('SMTP_USER', SMTP_USER);
required('SMTP_PASS', SMTP_PASS);
required('ALERT_FROM', ALERT_FROM);
required('ALERT_TO', ALERT_TO);

// ---------- helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function saveArtifacts(page, tag) {
  const dir = '/tmp';
  const png = path.join(dir, `shot_${tag}.png`);
  const html = path.join(dir, `page_${tag}.html`);

  await page.screenshot({ path: png, fullPage: true });
  const content = await page.content();
  fs.writeFileSync(html, content, 'utf8');
}

function normText(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

// Very generic "is this element part of a suggestions card?" check
function elementLooksLikeSuggestion(el) {
  const txt = (el.innerText || '').toLowerCase();
  if (!txt) return false;
  // APPROVE / REJECT buttons are always present on suggestion cards
  if (txt.includes('approve') && txt.includes('reject')) return true;
  // Confidence chip is usually there
  if (txt.includes('confidence')) return true;
  // “Agent” header on the card
  const header = (el.querySelector('*')?.innerText || '').toLowerCase();
  return header.includes('agent') && (txt.includes('approve') || txt.includes('reject'));
}

// decide if candidate is probably in the chat column (vs top bars)
function looksLikeChatArea(el) {
  const rect = el.getBoundingClientRect();
  const h = Math.max(document.documentElement.clientHeight, window.innerHeight || 0);
  // Discard tiny or offscreen snippets
  if (rect.height < 12 || rect.width < 30) return false;
  if (rect.bottom < 50) return false; // above header region
  if (rect.top > h - 40) return false; // overlapping input bar
  return true;
}

// ---------- Playwright main

(async () => {
  const browser = await chromium.launch({
    headless: process.env.CI ? true : HEADLESS !== '0'
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  let finalUrl = CONVERSATION_URL;

  try {
    // 1) Navigate (handles tracked links that redirect)
    const resp = await page.goto(CONVERSATION_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForLoadState('load', { timeout: 60_000 }).catch(() => {});
    finalUrl = page.url();
    console.log(`Resolved Boom URL: ${finalUrl}`);

    await saveArtifacts(page, 't1_login');

    // 2) Login if needed
    const needsLogin =
      await page.$('input[placeholder*="Email" i]') ||
      await page.$('input[type="email"]');

    if (needsLogin && BOOM_EMAIL && BOOM_PASSWORD) {
      required('BOOM_EMAIL', BOOM_EMAIL);
      required('BOOM_PASSWORD', BOOM_PASSWORD);

      const emailInput =
        (await page.$('input[placeholder*="Email" i]')) ||
        (await page.$('input[type="email"]'));

      const passInput =
        (await page.$('input[placeholder*="Password" i]')) ||
        (await page.$('input[type="password"]'));

      if (emailInput && passInput) {
        await emailInput.fill(BOOM_EMAIL);
        await passInput.fill(BOOM_PASSWORD);
        const loginBtn =
          (await page.$('button:has-text("Login")')) ||
          (await page.$('button:has-text("Sign in")'));
        if (loginBtn) {
          await loginBtn.click();
          await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
        }
      }
    }

    // give the conversation UI a moment to settle and then scroll bottom
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(1500);

    // 3) Analyze messages in the DOM
    const analysis = await page.evaluate(() => {
      // utilities (duplicated inside page context)
      const isVisible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        if (!style) return false;
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 4 && rect.height > 8;
      };

      const looksLikeSuggestion = (el) => {
        if (!el) return false;
        const txt = (el.innerText || '').toLowerCase();
        if (!txt) return false;
        if (txt.includes('approve') && txt.includes('reject')) return true;
        if (txt.includes('confidence')) return true;
        // suggestion cards often have “Agent” header and train button
        if (txt.includes(' agent ') && (txt.includes('approve') || txt.includes('reject'))) return true;
        return false;
      };

      const scrH = Math.max(document.documentElement.clientHeight, window.innerHeight || 0);

      // Find the main scrollable area by the "Type your message..." box (works on Boom)
      let composer = Array.from(document.querySelectorAll('textarea,input'))
        .find((el) => (el.placeholder || '').toLowerCase().includes('type your message'));
      let scrollRoot = document.body;
      if (composer) {
        let p = composer.parentElement;
        while (p && p.scrollHeight <= p.clientHeight) p = p.parentElement;
        if (p) scrollRoot = p;
      }

      const candidates = [];
      for (const el of Array.from(scrollRoot.querySelectorAll('*'))) {
        if (!isVisible(el)) continue;

        const text = (el.innerText || '').trim();
        if (!text) continue;

        // Skip obvious UI chrome
        const t = text.toLowerCase();
        if (t.includes('help center')) continue;
        if (t.includes('search listings')) continue;
        if (t.includes('assignee')) continue;
        if (t.includes('ai escalated') || t.includes('ai live') || t.includes('ai paused')) continue;

        const rect = el.getBoundingClientRect();
        if (rect.bottom < 60 || rect.top > scrH - 40) continue;

        candidates.push({ el, rect, text });
      }

      // The last REAL message: scan from bottom to top, skip suggestion cards
      candidates.sort((a, b) => a.rect.bottom - b.rect.bottom);

      // Helper to label sender for an element
      const guessSenderFor = (n) => {
        let sender = 'Unknown';
        let node = n.el;
        let ancestorText = '';
        for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
          const txt = (node.innerText || '').toLowerCase();
          ancestorText += ' ' + txt;
          if (looksLikeSuggestion(node)) return { sender: 'Suggestion', reject: true };
        }

        // via … label heuristic
        if (
          ancestorText.includes('via channel') ||
          ancestorText.includes('via whatsapp') ||
          ancestorText.includes('via email') ||
          ancestorText.includes('via web') ||
          ancestorText.includes('via sms')
        ) {
          if (ancestorText.includes('auto') || ancestorText.includes('agent')) {
            sender = 'Agent';
          } else {
            sender = 'Guest';
          }
        } else {
          // alignment heuristic: guest bubbles are typically on the left, agent on right
          const center = n.rect.left + n.rect.width / 2;
          const mid = window.innerWidth / 2;
          sender = center < mid ? 'Guest' : 'Agent';
        }
        return { sender, reject: false };
      };

      let lastReal = null;
      let lastRealIdx = -1;
      for (let i = candidates.length - 1; i >= 0; i--) {
        const c = candidates[i];
        // ignore suggestion cards
        let node = c.el;
        let isSuggest = false;
        for (let j = 0; j < 6 && node; j++, node = node.parentElement) {
          if (looksLikeSuggestion(node)) { isSuggest = true; break; }
        }
        if (isSuggest) continue;

        lastReal = c;
        lastRealIdx = i;
        break;
      }

      if (!lastReal) {
        return {
          ok: false,
          reason: 'no_text',
          lastSender: 'Unknown',
          snippet: ''
        };
      }

      const lastSenderInfo = guessSenderFor(lastReal);
      if (lastSenderInfo.reject || lastSenderInfo.sender === 'Suggestion') {
        // extremely defensive – shouldn’t happen because we filtered
        return {
          ok: false,
          reason: 'suggestion_only',
          lastSender: 'Unknown',
          snippet: lastReal.text.slice(0, 200)
        };
      }

      // Find if there is an Agent message posted AFTER the last guest message
      // (not a suggestion). Look strictly below lastRealIdx
      let answered = false;
      if (lastSenderInfo.sender === 'Guest') {
        for (let k = lastRealIdx + 1; k < candidates.length; k++) {
          const c = candidates[k];

          // skip suggestions
          let node = c.el, isSuggest = false;
          for (let j = 0; j < 6 && node; j++, node = node.parentElement) {
            if (looksLikeSuggestion(node)) { isSuggest = true; break; }
          }
          if (isSuggest) continue;

          const g = guessSenderFor(c);
          if (g.sender === 'Agent') {
            answered = true;
            break;
          }
        }
      }

      return {
        ok: true,
        snippet: lastReal.text.slice(0, 200),
        lastSender: lastSenderInfo.sender,
        isAnswered: answered,
        reason: lastSenderInfo.sender === 'Guest'
          ? (answered ? 'guest_then_agent' : 'guest_no_agent_after')
          : 'agent_last'
      };
    });

    console.log('Second check result:', analysis);

    await saveArtifacts(page, 't2_after');

    // 4) Decide whether to alert
    const shouldAlert =
      analysis &&
      analysis.ok &&
      analysis.lastSender === 'Guest' &&
      analysis.isAnswered === false;

    if (shouldAlert) {
      await sendEmail({
        to: ALERT_TO,
        from: ALERT_FROM,
        subject: `SLA breach (>${SLA_MINUTES} min): Boom guest message unanswered`,
        html: renderEmail({
          link: finalUrl,
          lastSender: analysis.lastSender,
          snippet: analysis.snippet
        })
      });
      console.log('Alert email sent.');
    } else {
      console.log('No alert sent (not guest unanswered or low confidence).');
    }

    await browser.close();
    process.exit(0);
  } catch (err) {
    console.error(err);
    try { await saveArtifacts(page, 'error'); } catch {}
    await browser.close();
    process.exit(1);
  }
})();

// ---------- email

async function sendEmail({ to, from, subject, html }) {
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465, // 465=true, others usually false (STARTTLS)
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });

  const recipients = to.split(',').map(s => s.trim()).filter(Boolean);

  await transporter.sendMail({
    from,
    to: recipients,
    subject,
    html
  });
}

function renderEmail({ link, lastSender, snippet }) {
  const safeSnippet = snippet ? snippet.replace(/</g, '&lt;').replace(/>/g, '&gt;') : '';
  return `
  <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.5">
    <p>Hi Rohit,</p>
    <p>A Boom guest message appears unanswered after ${SLA_MINUTES} minutes.</p>
    <p><b>Conversation:</b> <a href="${link}">Open in Boom</a><br/>
       <b>Last sender detected:</b> ${lastSender}<br/>
       <b>Last message sample:</b> ${safeSnippet || '(none)'}
    </p>
    <p>– Automated alert</p>
  </div>`;
}
