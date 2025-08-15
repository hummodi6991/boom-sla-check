// check.js — Boom SLA checker (ESM)
// Node 20+; "type":"module" in package.json

import { chromium } from 'playwright';
import nodemailer from 'nodemailer';

const CONVERSATION_ARG = process.argv.find(a => a.startsWith('http'));
const CONVERSATION_URL = process.env.CONVERSATION_URL || CONVERSATION_ARG || '';

const BOOM_USER = process.env.BOOM_USER;
const BOOM_PASS = process.env.BOOM_PASS;

// SMTP settings & recipients
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || '587');
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const FROM_NAME = process.env.FROM_NAME || 'Oaktree Boom SLA Bot';
const ROHIT_EMAIL = process.env.ROHIT_EMAIL;

// who receives the alert
const RECIPIENTS = [ROHIT_EMAIL, SMTP_USER].filter(Boolean);

// ---------- tiny helpers ----------
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const nowIso = () => new Date().toISOString();

// Filters used to ignore system cards / UI chrome
const BAD_TEXT_RE = /(fun level changed|detected policy|confidence\s*:\s*\d+|approve|reject|regenerate|train|help center)/i;

// Accept even short messages (including emoji)
const MIN_LAST_TEXT_CHARS = 1;

// ---------- email ----------
async function sendAlert({ url, snippet, lastSender, why }) {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || RECIPIENTS.length === 0) {
    console.log('Email not configured; skipping send.', {
      hasHost: !!SMTP_HOST, hasUser: !!SMTP_USER, hasPass: !!SMTP_PASS, recipients: RECIPIENTS
    });
    return;
  }

  const transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  const subject = `SLA breach (>5 min): Boom guest message unanswered`;
  const html = `
    <p>Hi Rohit,</p>
    <p>A Boom guest message appears unanswered after 5 minutes.</p>
    <p><b>Conversation:</b> <a href="${url}">Open in Boom</a><br/>
       <b>Last sender detected:</b> ${lastSender || 'Unknown'}<br/>
       <b>Last message sample:</b> ${snippet || '(none)'}<br/>
       <b>Reason:</b> ${why}
    </p>
    <p style="color:#888">– Automated alert</p>
  `;

  const info = await transport.sendMail({
    from: `"${FROM_NAME}" <${SMTP_USER}>`,
    to: RECIPIENTS.join(','),
    subject,
    html,
  });

  console.log('SMTP message id:', info.messageId);
}

// ---------- page logic ----------
async function loginIfNeeded(page) {
  // if already authenticated, Boom will redirect straight into app
  await page.goto('https://app.boomnow.com/login', { waitUntil: 'load' });
  try {
    await page.waitForSelector('input[type="email"]', { timeout: 5_000 });
  } catch {
    // looks logged in already
    return;
  }

  await page.fill('input[type="email"]', BOOM_USER, { timeout: 30_000 });
  await page.fill('input[type="password"]', BOOM_PASS, { timeout: 30_000 });
  // login button commonly says "Login"
  const loginBtn = page.locator('button:has-text("Login")');
  if (await loginBtn.count()) {
    await loginBtn.first().click();
  } else {
    await page.keyboard.press('Enter');
  }

  // land on dashboard
  await page.waitForURL('**/dashboard/**', { timeout: 30_000 });
}

function sanitize(text) {
  return (text || '')
    .replace(/\s+/g, ' ')
    .replace(/\u200e|\u200f/g, '') // LRM/RLM
    .trim();
}

async function inspectConversation(page) {
  // Give the page a moment to settle, then collect bottom region candidates.
  await sleep(1000);

  const result = await page.evaluate(
    ({ BAD_TEXT_RE_SOURCE, MIN_LAST_TEXT_CHARS }) => {
      const BAD_RE = new RegExp(BAD_TEXT_RE_SOURCE, 'i');

      const vh = window.innerHeight;

      // Gather textual blocks in the lower half of the viewport
      const blocks = Array.from(document.querySelectorAll('div'))
        .map(el => {
          const rect = el.getBoundingClientRect();
          const text = (el.innerText || '').trim();
          const html = el.innerHTML || '';
          const classes = el.className || '';
          return { el, text, html, classes, rect };
        })
        .filter(x =>
          x.rect.height > 10 &&
          x.rect.width > 40 &&
          (x.rect.top + x.rect.height / 2) > vh * 0.45
        )
        .filter(x => x.text && !BAD_RE.test(x.text));

      // Find Agent suggestion card (very strong ‘guest before this’ hint)
      const hasAgentSuggestion =
        blocks.some(b => /(^|\s)Agent(\s|$)/i.test(b.text) && /Confidence\s*:\s*\d+/i.test(b.text));

      // Candidate message snippets (short ok; allow emoji)
      const msgs = blocks
        .map(b => ({ ...b, clean: (b.text || '').replace(/\s+/g, ' ').trim() }))
        .filter(b => b.clean.length >= MIN_LAST_TEXT_CHARS)
        .sort((a, b) => (a.rect.top + a.rect.height / 2) - (b.rect.top + b.rect.height / 2));

      // Bottom-most readable block
      const last = msgs[msgs.length - 1];

      // Helper: near a block, is there a label that looks like "• via whatsapp/sms/email" ?
      const looksGuestMetaNear = (anchor) => {
        if (!anchor) return false;
        const near = document.elementFromPoint(anchor.rect.left + 10, Math.min(anchor.rect.bottom + 8, window.innerHeight - 2));
        const text = (near?.closest('div')?.innerText || '') + ' ' + (anchor.el.parentElement?.innerText || '');
        return /•\s*via\s+(whatsapp|sms|email|phone|web)/i.test(text);
      };

      // Helper: near a block, is there an "via channel" agent meta?
      const looksAgentMetaNear = (anchor) => {
        if (!anchor) return false;
        const neighbor = (anchor.el.parentElement?.innerText || '') + ' ' + (anchor.el.nextElementSibling?.innerText || '');
        return /via channel/i.test(neighbor);
      };

      let lastSender = 'Unknown';
      let why = 'no_selector';
      let snippet = last ? anchorText(last.clean) : '';

      function anchorText(t) {
        return t.length > 160 ? `${t.slice(0, 160)}…` : t;
      }

      if (last) {
        if (looksAgentMetaNear(last)) {
          lastSender = 'Agent';
          why = 'neighbor_agent_meta';
        } else if (looksGuestMetaNear(last)) {
          lastSender = 'Guest';
          why = 'neighbor_guest_meta';
        } else if (hasAgentSuggestion) {
          // typically appears right after a guest message
          lastSender = 'Guest';
          why = 'agent_suggestion_present';
        } else {
          // Fallback: if the bubble is left-aligned vs right, many UIs use that for guests.
          const centerX = last.rect.left + last.rect.width / 2;
          if (centerX < window.innerWidth * 0.5) {
            lastSender = 'Guest';
            why = 'geo-heuristic-left-bubble';
          } else {
            lastSender = 'Unknown';
            why = 'heuristic';
          }
        }
      } else {
        // No text blocks? Still fallback to suggestion card signal.
        if (hasAgentSuggestion) {
          lastSender = 'Guest';
          snippet = '';
          why = 'agent_suggestion_present_no_text';
        }
      }

      // Final OK decision:
      const ok = lastSender === 'Guest';

      return {
        ok,
        lastSender,
        snippet,
        reason: why,
        hasAgentSuggestion,
        centerX: last ? last.rect.left + last.rect.width / 2 : null,
        vw: window.innerWidth,
        ts: new Date().toISOString(),
      };
    },
    {
      BAD_TEXT_RE_SOURCE: BAD_TEXT_RE.source,
      MIN_LAST_TEXT_CHARS,
    }
  );

  return result;
}

async function run() {
  if (!CONVERSATION_URL) {
    console.error('Missing conversation URL!');
    process.exit(2);
  }
  if (!BOOM_USER || !BOOM_PASS) {
    console.error('Missing BOOM_USER/BOOM_PASS!');
    process.exit(2);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log('Saved artifacts for t1');

    await loginIfNeeded(page);

    // Jump to conversation
    console.log('Navigating to conversation…');
    await page.goto(CONVERSATION_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});

    // Some runs arrive on a tracking/redirect link. Let’s resolve it.
    if (!/\/dashboard\/guest-experience\//.test(page.url())) {
      await page.waitForURL('**/dashboard/guest-experience/**', { timeout: 45_000 }).catch(() => {});
    }
    console.log('Resolved Boom URL:', page.url());

    const second = await inspectConversation(page);
    console.log('Second check result:', second);

    if (second.ok) {
      await sendAlert({
        url: page.url(),
        snippet: second.snippet,
        lastSender: second.lastSender,
        why: second.reason,
      });
    } else {
      console.log('No alert sent (not confident or not guest/unanswered).');
    }

    console.log('Saved artifacts for t2');
  } catch (err) {
    console.error('Fatal error:', err);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

run();
