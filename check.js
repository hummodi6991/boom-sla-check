// check.js
// Boom "guest unanswered" SLA checker + email alert
// Works with the secrets listed in the README above.

const { chromium } = require("playwright");
const nodemailer = require("nodemailer");
const fs = require("fs/promises");
const path = require("path");

const env = process.env;

// ---------- Config from env ----------
const BOOM_USER = env.BOOM_USER;
const BOOM_PASS = env.BOOM_PASS;
const CONVERSATION_URL = env.CONVERSATION_URL; // must be provided by the workflow
const AGENT_SIDE = (env.AGENT_SIDE || "").toLowerCase();

const SMTP_HOST = env.SMTP_HOST;
const SMTP_PORT = Number(env.SMTP_PORT || 465);
const SMTP_USER = env.SMTP_USER;
const SMTP_PASS = env.SMTP_PASS;

// From / recipients
const FROM_NAME = env.FROM_NAME || "Oaktree Boom SLA Bot";
const FROM_ADDR = env.FROM_EMAIL || SMTP_USER; // fallback to SMTP_USER if no FROM_EMAIL
const FROM = `${FROM_NAME} <${FROM_ADDR}>`;

// Recipients logic:
// 1) RECIPIENTS overrides everything (comma-separated)
// 2) else default to [ROHIT_EMAIL, SMTP_USER] (dedup) and CC SMTP_USER if not already included
const explicitRecipients = (env.RECIPIENTS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

let toList = [];
let ccList = [];
if (explicitRecipients.length) {
  toList = [...new Set(explicitRecipients.map(s => s.toLowerCase()))];
} else {
  const base = [env.ROHIT_EMAIL, SMTP_USER].filter(Boolean);
  toList = [...new Set(base.map(s => s.toLowerCase()))];
  if (!toList.includes(SMTP_USER.toLowerCase())) ccList.push(SMTP_USER);
}

// ---------- Guards ----------
function requireEnv(name, val) {
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    process.exit(2);
  }
}
[
  ["BOOM_USER", BOOM_USER],
  ["BOOM_PASS", BOOM_PASS],
  ["CONVERSATION_URL", CONVERSATION_URL],
  ["SMTP_HOST", SMTP_HOST],
  ["SMTP_PORT", SMTP_PORT],
  ["SMTP_USER", SMTP_USER],
  ["SMTP_PASS", SMTP_PASS],
].forEach(([k, v]) => requireEnv(k, v));

// ---------- Mailer ----------
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465, // SSL on 465
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});

// Helper: send email
async function sendAlertEmail({ subject, html }) {
  const info = await transporter.sendMail({
    from: FROM,
    to: toList.join(","),
    cc: ccList.length ? ccList.join(",") : undefined,
    subject,
    html,
  });
  console.log(`SMTP message id: ${info.messageId}`);
}

// ---------- Playwright helpers ----------
async function saveArtifact(page, tag) {
  const shot = `/tmp/shot_${tag}.png`;
  const html = `/tmp/page_${tag}.html`;
  await page.screenshot({ path: shot, fullPage: true });
  await fs.writeFile(html, await page.content(), "utf-8");
  console.log(`Saved artifacts for ${tag}`);
}

function sanitizeSample(s, max = 240) {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

// Heuristic: follow tracking/redirect links to final Boom URL
function looksLikeTracking(u) {
  return /mjt\.lu|lnk|trk|mail|utm_/i.test(u);
}

async function resolveFinalURL(page, start) {
  if (!looksLikeTracking(start)) return start;
  await page.goto(start, { waitUntil: "load", timeout: 60_000 });
  // After redirect we should land at app.boomnow.com
  const final = page.url();
  return final;
}

// Try to log in if we see a login form
async function loginIfNeeded(page) {
  const url = page.url();
  if (/\/login/i.test(url) || (await page.locator('input[type="email"]').count()) > 0) {
    console.log("Login page detected, signing in…");
    await page.fill('input[type="email"]', BOOM_USER, { timeout: 30_000 });
    await page.fill('input[type="password"]', BOOM_PASS, { timeout: 30_000 });
    // Boom has a "Login" button; try common selectors:
    const btn = page.locator('button:has-text("Log in"), button:has-text("Login")');
    await btn.first().click({ timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 60_000 });
  }
}

// Extract “last message” + who sent it (best-effort across layouts)
async function getLastMessageInfo(page) {
  // 1) If a conversation “Suggested reply / Agent” card is present and APPROVE/REJECT are visible,
  //    it means the AI suggestion is pending (not approved).
  const hasAiSuggestion =
    (await page.locator('button:has-text("APPROVE"), button:has-text("Approve")').count()) > 0;

  // 2) Find candidate message bubbles. We’ll prefer the last non-empty text.
  const candidates = page.locator(
    [
      'div[class*="message"]',
      'div[class*="bubble"]',
      ".v-messages__wrapper",
      ".v-messages__message",
      'div[role="listitem"]',
    ].join(",")
  );

  const n = await candidates.count();
  let lastText = "";
  let lastSender = "Unknown";

  for (let i = n - 1; i >= 0; i--) {
    const el = candidates.nth(i);
    const txt = sanitizeSample(await el.innerText().catch(() => ""));
    if (!txt) continue; // skip empty (e.g., pure emoji could be empty in innerText)
    lastText = txt;

    // Try to infer sender from nearby labels / classes
    const cls = (await el.getAttribute("class")) || "";
    const side =
      /right|end/i.test(cls) ? "right" : /left|start/i.test(cls) ? "left" : "";

    if (AGENT_SIDE && side) {
      lastSender = side === AGENT_SIDE ? "Agent" : "Guest";
    } else {
      // textual hints
      if (/via channel|guest|whatsapp|sms|instagram|guest/i.test(txt)) lastSender = "Guest";
      if (/Agent/i.test(txt)) lastSender = "Agent";
    }
    break;
  }

  return { hasAiSuggestion, lastText, lastSender };
}

// Decide if we should alert:
// - last sender is Guest
// - and there’s an unapproved AI suggestion (Approve/Reject visible) OR no agent reply detected
function shouldAlert({ lastSender, hasAiSuggestion, lastText }) {
  const isGuest = lastSender === "Guest";
  // Any non-empty text from the guest counts as a message. Some emoji may be empty -> treat as ok:false but we still can rely on the suggestion state.
  const hasMeaningfulText = !!sanitizeSample(lastText);

  if (isGuest && (hasAiSuggestion || hasMeaningfulText)) return true;
  return false;
}

// ---------- Main ----------
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Step 1: resolve & open
    const finalUrl = await resolveFinalURL(page, CONVERSATION_URL);
    console.log(`Resolved Boom URL: ${finalUrl}`);
    await page.goto(finalUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await loginIfNeeded(page);

    // Wait for the conversation page to settle
    await page.waitForLoadState("networkidle", { timeout: 60_000 });

    // Save initial artifact (t1)
    await saveArtifact(page, "t1");

    // Extract info
    const info = await getLastMessageInfo(page);

    // Decide & email
    const ok = shouldAlert(info);
    const reason = ok ? "guest_unanswered" : info.lastSender === "Unknown" ? "heuristic" : "no_text";
    const snippet = sanitizeSample(info.lastText);

    console.log("Second check result:", {
      ok,
      reason,
      lastSender: info.lastSender,
      snippet,
    });

    if (ok) {
      const subject = "SLA breach (>5 min): Boom guest message unanswered";
      const html = `
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif">
          <p>Hi Rohit,</p>
          <p>A Boom guest message appears unanswered after 5 minutes.</p>
          <p><b>Conversation:</b> <a href="${finalUrl}">Open in Boom</a><br/>
             <b>Last sender detected:</b> ${info.lastSender}<br/>
             <b>Last message sample:</b> ${snippet || "(none)"}<br/>
          </p>
          <p style="color:#888">– Automated alert</p>
        </div>
      `;
      await sendAlertEmail({ subject, html });
    } else {
      console.log("No alert sent (not confident or not guest/unanswered).");
    }

    // Save final artifact (t2)
    await saveArtifact(page, "t2");
  } catch (err) {
    console.error(err);
    // Save what we can for debugging
    try { await saveArtifact(page, "error"); } catch (_) {}
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
