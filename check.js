// check.js — Boom SLA checker (ESM)
// Last-sender detection that ignores AI suggestion cards; alerts when Guest is last and beyond SLA.
// Uses ONLY your existing secrets. No new secret names.
//
// Env you already have (email/login):
//   BOOM_USER, BOOM_PASS, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, FROM_NAME, ROHIT_EMAIL
//
// Optional non-secret knobs (all default off):
//   SLA_MIN=5           -> minutes threshold (default 5)
//   IGNORE_SLA=1        -> for manual tests on old threads, fire if Guest regardless of minutes
//   DEBUG=1             -> save /tmp/t1,t2 screenshots + html
//
// Run: CONVERSATION_URL="https://app.boomnow.com/..." node check.js

import { chromium } from 'playwright';
import nodemailer from 'nodemailer';
import fs from 'fs/promises';

const CONVERSATION_URL = process.env.CONVERSATION_URL || process.argv[2] || '';
const BOOM_USER = process.env.BOOM_USER || '';
const BOOM_PASS = process.env.BOOM_PASS || '';

const SLA_MIN = Number(process.env.SLA_MIN || 5);
const IGNORE_SLA = /^(1|true|yes)$/i.test(process.env.IGNORE_SLA || '0');
const DEBUG = /^(1|true|yes)$/i.test(process.env.DEBUG || '1');

// ---------- small utils ----------
async function ensureDir(p) { try { await fs.mkdir(p, { recursive: true }); } catch {} }
async function scrollToBottom(page, times = 7) {
  for (let i = 0; i < times; i++) {
    await page.mouse.wheel(0, 99999);
    await page.waitForTimeout(350);
  }
}

function parseMinsAgoFromBlock(blockText) {
  // looks for "12:47 PM" near the tail of the text block (same-day only)
  const tail = blockText.split('\n').slice(-4).join(' ');
  const m = tail.match(/\b(1[0-2]|0?[1-9]):([0-5]\d)\s*(AM|PM)\b/i);
  if (!m) return null;
  try {
    const now = new Date();
    let h = Number(m[1]), mm = Number(m[2]);
    const ap = m[3].toUpperCase();
    if (ap === 'PM' && h !== 12) h += 12;
    if (ap === 'AM' && h === 12) h = 0;

    const then = new Date(now);
    then.setHours(h, mm, 0, 0);
    const diff = now.getTime() - then.getTime();
    if (diff < 0) return null; // probably previous day; ignore
    return Math.round(diff / 60000);
  } catch { return null; }
}

function classifySenderFromHeader(headerLine, fullText) {
  // Guest bubbles are "Name • via whatsapp/channel"
  // Agent bubbles are "via whatsapp/channel • Name" OR have TRAIN badge text nearby
  const h = headerLine.trim();
  const hasTrain = /\bTRAIN\b/i.test(fullText);

  const endsWithVia = /\b•\s*via\s+(whatsapp|channel)\b/i.test(h);
  const startsWithVia = /^\s*via\s+(whatsapp|channel)\b/i.test(h);

  if (startsWithVia || hasTrain) return 'Agent';
  if (endsWithVia) return 'Guest';
  return 'Unknown';
}

// ---------- main ----------
(async () => {
  if (!CONVERSATION_URL) {
    console.log('Missing CONVERSATION_URL; nothing to do.');
    process.exit(0);
  }

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const outDir = '/tmp';
  await ensureDir(outDir);

  const result = {
    ok: true,                      // ok=false => will send alert
    reason: 'no_breach',
    lastSender: 'Unknown',
    snippet: '',
    minsAgo: null,
    hasAgentSuggestion: false,
  };

  try {
    await page.goto(CONVERSATION_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // login if form present and creds provided (safe selectors only)
    const emailSel = 'input[type="email"], input[name="email"]';
    const passSel  = 'input[type="password"], input[name="password"]';
    if ((await page.locator(emailSel).first().count()) && BOOM_USER && BOOM_PASS) {
      await page.fill(emailSel, BOOM_USER).catch(()=>{});
      await page.fill(passSel,  BOOM_PASS).catch(()=>{});
      await Promise.any([
        page.click('button:has-text("Log in")'),
        page.click('button:has-text("Sign in")'),
        page.click('[type="submit"]')
      ]).catch(()=>{});
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(()=>{});
    }

    await scrollToBottom(page);

    if (DEBUG) {
      await page.screenshot({ path: `${outDir}/t1.png`, fullPage: true }).catch(()=>{});
      await fs.writeFile(`${outDir}/t1.html`, await page.content()).catch(()=>{});
    }

    // Detect presence of AI suggestion card (for logging only)
    result.hasAgentSuggestion = !!(await page
      .locator('div:has-text("Agent")')
      .filter({ hasText: 'APPROVE' })
      .first()
      .count()
    );

    // Extract candidate human bubbles: contain "via whatsapp/channel", exclude system rows & AI cards
    const candidates = await page.$$eval('div', (nodes) => {
      const take = nodes.slice(-500);
      const wanted = [];
      for (const n of take) {
        const t = (n.innerText || '').trim();
        if (!t) continue;

        // must mention via channel/whatsapp
        if (!/\bvia\s+(whatsapp|channel)\b/i.test(t)) continue;

        // exclude system/events and the Agent suggestion card
        if (/Fun level changed|Moved to closed|de-escalated|Escalation\b/i.test(t)) continue;
        if (/\bConfidence:\s*\d\b/i.test(t) && /\bAPPROVE\b/i.test(t)) continue; // AI card

        const rect = n.getBoundingClientRect?.();
        wanted.push({
          y: rect ? rect.top : 0,
          text: t,
        });
      }
      // sort top->bottom, keep last as newest
      wanted.sort((a, b) => a.y - b.y);
      return wanted;
    });

    if (candidates.length === 0) {
      result.ok = false;
      result.reason = 'no_selector';
    } else {
      const last = candidates[candidates.length - 1];
      const lines = last.text.split('\n').map(s => s.trim()).filter(Boolean);
      const header = lines[0] || last.text.slice(0, 120);

      result.lastSender = classifySenderFromHeader(header, last.text);
      result.snippet = lines.slice(1).join(' ').slice(0, 160);

      const mins = parseMinsAgoFromBlock(last.text);
      result.minsAgo = mins;

      const beyondSla = IGNORE_SLA ? true : (typeof mins === 'number' && mins >= (isFinite(SLA_MIN) ? SLA_MIN : 5));

      if (result.lastSender === 'Guest') {
        if (beyondSla) {
          result.ok = false;
          result.reason = 'guest_unanswered';
        } else {
          result.ok = true;
          result.reason = 'guest_within_sla';
        }
      } else if (result.lastSender === 'Agent') {
        result.ok = true;
        result.reason = 'agent_last';
      } else {
        // unknown classification: be conservative and alert, so we don't miss true breaches
        result.ok = false;
        result.reason = 'unknown';
      }
    }

    if (DEBUG) {
      await page.screenshot({ path: `${outDir}/t2.png`, fullPage: true }).catch(()=>{});
      await fs.writeFile(`${outDir}/t2.html`, await page.content()).catch(()=>{});
      await fs.writeFile(`${outDir}/result.json`, JSON.stringify(result, null, 2)).catch(()=>{});
    }

    console.log('Second check result:', JSON.stringify(result, null, 2));

    // ---------- email only when needed ----------
    if (!result.ok && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.ROHIT_EMAIL) {
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 465),
        secure: true,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });

      const subject = 'SLA breach (>5 min): Boom guest message unanswered';
      const lines = [
        `Hi Rohit,`,
        ``,
        `A Boom guest message appears unanswered${IGNORE_SLA ? ' (manual test, SLA ignored)' : ''}.`,
        ``,
        `Conversation: ${CONVERSATION_URL}`,
        `Last sender detected: ${result.lastSender}`,
        result.snippet ? `Last message sample: ${result.snippet}` : '',
        (result.minsAgo !== null) ? `Approx minutes since last message: ${result.minsAgo}` : '',
        ``,
        `— Automated alert`
      ].filter(Boolean);

      await transporter.sendMail({
        from: `"${process.env.FROM_NAME || 'Boom SLA Bot'}" <${process.env.SMTP_USER}>`,
        to: process.env.ROHIT_EMAIL,
        subject,
        text: lines.join('\n'),
      });

      console.log('Alert email sent to ROHIT_EMAIL.');
    } else if (!result.ok) {
      console.log('Alert needed, but SMTP/recipient envs are not fully set.');
    } else {
      console.log('No alert needed.');
    }
  } catch (err) {
    console.log('Error:', err?.message || String(err));
  } finally {
    await browser.close();
  }
})();
