import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import {
  CARD, MSG_BOX, TIME_ROW, AI_COMPONENT,
  EMAIL_INPUT, PASS_INPUT, LOGIN_BTN,
  IS_AGENT_SIDE, IS_GUEST_SIDE
} from "./selectors.mjs";
import { sendAlert } from "./email.mjs";

/** ---------- Config ----------
 * SLA minutes: default 10, override with SLA_MINUTES input.
 * Timezone is TZ=Asia/Riyadh in the workflow.
 */
const SLA_MIN = Number(process.env.SLA_MINUTES || 10);
const CONV_URL = process.env.CONVERSATION_URL;
const BOOM_USER = process.env.BOOM_USER;
const BOOM_PASS = process.env.BOOM_PASS;
const AGENT_SIDE_SECRET = (process.env.AGENT_SIDE || "").toLowerCase();

const ART = (name) => path.join("/tmp", `boom-${name}`);

// Parse a string like: "29 Jul 2025, 10:45 PM" in Riyadh time.
function parseRiyadhTs(str) {
  if (!str) return null;
  // Add explicit timezone offset for robust parsing:
  const withTZ = `${str} +03:00`;
  const d = new Date(withTZ);
  return isNaN(d.getTime()) ? null : d;
}

function minutesAgo(date) {
  if (!date) return null;
  const now = new Date();
  return Math.round((now.getTime() - date.getTime()) / 60000);
}

// Extract a list of real messages, newest last.
async function scrapeMessages(page) {
  // Collect ALL candidate cards, then filter out AI suggestions and non-message cards.
  const nodes = await page.$$(CARD);

  const results = [];
  for (const el of nodes) {
    // Ignore if this card is inside an AI suggestion wrapper
    // or has an AI suggestion sibling right at the same level.
    const hasAIAncestor = await el.evaluate((n, AI_COMPONENT) => {
      return !!n.closest(AI_COMPONENT);
    }, AI_COMPONENT);
    if (hasAIAncestor) continue;

    // Require a real bubble text
    const msgEl = await el.$(MSG_BOX);
    if (!msgEl) continue;

    // Grab text & time row
    const text = (await msgEl.textContent())?.trim() || "";

    // Ignore empty system blips
    if (!text) continue;

    const timeRow = await el.$(TIME_ROW);
    let tsText = "";
    if (timeRow) tsText = (await timeRow.textContent())?.trim() || "";

    // Determine side from class list
    const classList = await el.evaluate(n => n.className || "");
    const isAgent = IS_AGENT_SIDE(classList) || (AGENT_SIDE_SECRET && classList.includes(AGENT_SIDE_SECRET));
    const isGuest = !isAgent && IS_GUEST_SIDE(classList);

    results.push({
      side: isAgent ? "agent" : (isGuest ? "guest" : "unknown"),
      text,
      tsText
    });
  }

  return results;
}

async function ensureLoggedIn(page) {
  // If already inside app, bail
  if (/app\.boomnow\.com/.test(page.url())) return;
  await page.goto("https://app.boomnow.com/login", { waitUntil: "domcontentloaded" });

  // Detect login form
  const email = await page.$(EMAIL_INPUT);
  const pass  = await page.$(PASS_INPUT);
  if (email && pass) {
    await email.fill(BOOM_USER || "");
    await pass.fill(BOOM_PASS || "");
    const btn = await page.$(LOGIN_BTN);
    if (btn) await Promise.all([
      page.waitForLoadState("networkidle"),
      btn.click()
    ]);
  }
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  const out = {
    ok: false,
    reason: "unknown",
    lastSender: "Unknown",
    hasAgentSuggestion: false,
    snippet: "",
    tsText: "",
    minsAgo: null
  };

  try {
    // Navigate (will redirect to login if needed)
    await page.goto(CONV_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
    if (!/app\.boomnow\.com/.test(page.url())) {
      await ensureLoggedIn(page);
      await page.goto(CONV_URL, { waitUntil: "domcontentloaded" });
    }

    // Small wait to let lazy content render
    await page.waitForTimeout(800);

    // Screenshot + DOM dump (before analysis)
    await page.screenshot({ path: ART("before.png"), fullPage: true }).catch(() => {});
    await fs.promises.writeFile(ART("dom.html"), await page.content()).catch(() => {});

    // If we see an AI suggestion block in view, note it (we still ignore it for sender logic)
    out.hasAgentSuggestion = !!(await page.$(AI_COMPONENT));

    // Scrape messages
    const msgs = await scrapeMessages(page);
    await fs.promises.writeFile(ART("messages.json"), JSON.stringify(msgs, null, 2)).catch(() => {});

    if (!msgs.length) {
      out.reason = "no_selector";
      console.log("Second check result:", JSON.stringify(out, null, 2));
      return finish(out, page, browser);
    }

    const last = msgs[msgs.length - 1];
    out.ok = true;
    out.lastSender = last.side === "agent" ? "Agent" : (last.side === "guest" ? "Guest" : "Unknown");
    out.snippet = last.text.slice(0, 160);
    out.tsText = last.tsText;

    // Parse timestamp safely
    const tsMatch = last.tsText?.match(/\d{1,2}\s\w{3}\s\d{4},\s\d{1,2}:\d{2}\s[AP]M/);
    if (tsMatch) {
      const ts = parseRiyadhTs(tsMatch[0]);
      out.minsAgo = minutesAgo(ts);
    }

    // Decision: alert if last is GUEST and (minsAgo >= SLA_MIN or unknown time while SLA_MIN==0)
    let shouldAlert = false;
    if (out.lastSender === "Guest") {
      if (typeof out.minsAgo === "number") {
        shouldAlert = out.minsAgo >= SLA_MIN;
      } else {
        // If we can't parse time, be conservative: do not alert automatically.
        shouldAlert = false;
        out.reason = "guest_last_but_time_unknown";
      }
    } else {
      out.reason = out.lastSender === "Agent" ? "agent_last" : "not_conversation";
    }

    console.log("Second check result:", JSON.stringify(out, null, 2));

    // If alert needed, send email
    if (shouldAlert) {
      const subj = `🚨 Boom SLA breach: guest unanswered ${out.minsAgo}m`;
      const link = CONV_URL;
      const html = `
        <p><strong>Guest unanswered</strong> for <strong>${out.minsAgo} minutes</strong> (SLA ${SLA_MIN}m).</p>
        <p><a href="${link}">Open conversation</a></p>
        <pre>${escapeHtml(out.snippet)}</pre>
      `;
      const text = `Guest unanswered for ${out.minsAgo} minutes (SLA ${SLA_MIN}m).\n${link}\n\n${out.snippet}`;
      await sendAlert({ subject: subj, html, text });
    }

    // After screenshot for artifacts
    await page.screenshot({ path: ART("after.png"), fullPage: true }).catch(() => {});
  } catch (err) {
    out.ok = false;
    out.reason = `error:${err.message}`;
    console.log("Second check result:", JSON.stringify(out, null, 2));
  } finally {
    await finish(out, page, browser);
  }
})();

function escapeHtml(s = "") {
  return s.replace(/[&<>"]/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]
  ));
}

async function finish(out, page, browser) {
  // Make the outcome easy to scan in GH Actions logs
  if (out.ok && out.lastSender === "Guest" && typeof out.minsAgo === "number" && out.minsAgo >= SLA_MIN) {
    console.log("Alert path triggered (guest unanswered beyond SLA).");
  } else {
    console.log("No alert sent (not guest/unanswered).");
  }
  try { await page.close(); } catch {}
  try { await browser.close(); } catch {}
}
