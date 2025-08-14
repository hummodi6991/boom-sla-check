import { chromium } from "playwright";
import nodemailer from "nodemailer";
import fs from "fs/promises";

/* ====== Env ====== */
const {
  CONVERSATION_URL,
  BOOM_USER,
  BOOM_PASS,
  ROHIT_EMAIL,
  SMTP_USER,
  SMTP_PASS,
  SMTP_HOST = "smtp.gmail.com",
  SMTP_PORT = "587",
  FROM_NAME,
  REPLY_TO
} = process.env;

if (!CONVERSATION_URL) { console.error("❌ Missing CONVERSATION_URL"); process.exit(1); }
if (!BOOM_USER || !BOOM_PASS) { console.error("❌ Missing BOOM_USER/BOOM_PASS"); process.exit(1); }

/* ====== Selectors ====== */
/* Put any good, specific chat-row selector you discover at the TOP later */
const MESSAGE_SELECTOR_CANDIDATES = [
  // "[data-testid='message']",   // <-- add yours here once you find it
  ".chat-message",
  ".message-row",
  "div.message-item",
  ".message-item",
  ".msg",
  "[role='listitem']",
  "[class*='message']",         // generic; often matches non-chat too
  "[class*='Message']"
];

/* Things we know are NOT chat messages (Vuetify validation wrappers, help text, etc.) */
const BLACKLIST_CLASSES = [
  "v-messages__wrapper",        // <-- the one you saw in logs
  "v-messages__message",
  "helper-text",
  "validation",
  "tooltip",
  "snackbar",
  "toast"
];

const SELECTORS = {
  loginUser: 'input[type="email"], input[name="email"], input[name="username"]',
  loginPass: 'input[type="password"]',
  loginSubmit: 'button[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Login")'
};

/* Heuristics to label sender */
const GUEST_HINTS = ["guest", "customer", "incoming", "received", "theirs", "left"];
const AGENT_HINTS = ["agent", "staff", "support", "team", "oaktree", "boom", "you", "outgoing", "sent", "yours", "right"];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const hasHint = (hints, hay) => hints.some(h => hay.includes(h));

/* ====== Artifact helpers ====== */
async function savePageAndFrames(page, tag) {
  try { await page.screenshot({ path: `/tmp/shot_${tag}.png`, fullPage: true }); } catch {}
  try { await fs.writeFile(`/tmp/page_${tag}.html`, await page.content(), "utf8"); } catch {}
  const frames = page.frames();
  for (let i = 0; i < frames.length; i++) {
    try {
      const f = frames[i];
      const url = (f.url() || "").replace(/[^a-z0-9]+/gi, "_").slice(0,120);
      await fs.writeFile(`/tmp/frame_${i}_${tag}_${url}.html`, await f.content(), "utf8");
    } catch {}
  }
  console.log(`📎 Saved artifacts for ${tag} (page + ${page.frames().length} frames)`);
}

/* ====== Find messages anywhere (page or iframes), filter noise ====== */
async function searchMessagesAnyFrame(page) {
  const places = [page, ...page.frames()];
  console.log(`🔎 Searching ${places.length} contexts (page + ${places.length-1} frames)…`);

  for (const [pi, ctx] of places.entries()) {
    const ctxType = pi === 0 ? "page" : `frame#${pi-1}`;

    for (const sel of MESSAGE_SELECTOR_CANDIDATES) {
      let nodes = [];
      try { nodes = await ctx.$$(sel); } catch {}
      if (!nodes || nodes.length === 0) continue;

      // filter out false positives:
      const filtered = [];
      for (const n of nodes) {
        const cls = ((await n.getAttribute("class")) || "").toLowerCase();
        if (BLACKLIST_CLASSES.some(bad => cls.includes(bad))) continue;

        const txt = ((await n.innerText()) || "").trim();
        if (txt.length < 2) continue;              // skip empty/1-char artefacts

        filtered.push(n);
      }

      if (filtered.length > 0) {
        console.log(`✅ Using selector "${sel}" in ${ctxType} (found ${filtered.length} nodes after filtering)`);
        return { ctx, selector: sel, nodes: filtered };
      }
    }
  }
  return { ctx: null, selector: null, nodes: [] };
}

/* ====== One check ====== */
async function checkOnce(url, tag) {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });

    // Login if needed
    if (await page.$(SELECTORS.loginUser)) {
      console.log("🔐 Login form detected — signing in…");
      await page.fill(SELECTORS.loginUser, BOOM_USER);
      await page.fill(SELECTORS.loginPass, BOOM_PASS);
      await page.click(SELECTORS.loginSubmit);
      await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(()=>{});
      await sleep(1500);
    } else {
      await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(()=>{});
      await sleep(1500);
    }

    const found = await searchMessagesAnyFrame(page);
    if (!found.selector) {
      console.log("⚠️  No message elements found in page or frames.");
      await savePageAndFrames(page, tag);
      await browser.close();
      return { isAnswered: false, lastSender: "Unknown", reason: "no_selector" };
    }

    const last = found.nodes[found.nodes.length - 1];

    // Debug what the last node looks like
    const cls = ((await last.getAttribute("class")) || "").toLowerCase();
    const attrDump = await last.evaluate(el => {
      const attrs = {};
      for (const a of el.getAttributeNames?.() || []) attrs[a] = el.getAttribute(a);
      return attrs;
    });
    const txt = ((await last.innerText()) || "");
    console.log("🔎 last message debug:", { class: cls, attrs: attrDump, textSample: txt.trim().slice(0,100) });

    // Decide who sent it
    let lastSender = "Unknown";
    const hay = [cls, txt.toLowerCase(), JSON.stringify(attrDump).toLowerCase()].join(" ");
    if (hasHint(GUEST_HINTS, hay)) lastSender = "Guest";
    if (hasHint(AGENT_HINTS, hay)) lastSender = "Agent";

    await browser.close();
    return { isAnswered: lastSender === "Agent", lastSender };
  } catch (e) {
    console.error("Check error:", e?.message || e);
    try { await savePageAndFrames(page, `${tag}_err`); } catch {}
    try { await browser.close(); } catch {}
    return { isAnswered: false, lastSender: "Unknown", reason: "error" };
  }
}

/* ====== Email ====== */
async function sendEmailToRohit(url, lastSender) {
  if (!SMTP_USER || !SMTP_PASS || !ROHIT_EMAIL) {
    console.log("🚫 Skipping email (missing SMTP_USER/SMTP_PASS/ROHIT_EMAIL).");
    return;
  }
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: false,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });

  const html = `
    Hi Rohit,<br><br>
    A Boom guest message appears unanswered after 5 minutes.<br><br>
    Conversation: <a href="${url}">Open in Boom</a><br>
    Last sender detected: ${lastSender}<br><br>
    – Automated alert`;

  console.log(`📧 Sending email to ${ROHIT_EMAIL} from ${SMTP_USER}…`);
  const info = await transporter.sendMail({
    from: `"${FROM_NAME || 'Oaktree Boom SLA Bot'}" <${SMTP_USER}>`,
    to: ROHIT_EMAIL,
    replyTo: REPLY_TO || ROHIT_EMAIL,
    subject: "SLA breach (>5 min): Boom guest message unanswered",
    html
  });
  console.log("📧 SMTP response id:", info.messageId || "sent");
}

/* ====== Orchestrate: 2-pass check ====== */
const main = async () => {
  const r1 = await checkOnce(CONVERSATION_URL, "t1");
  console.log("First check result:", r1);

  if (!r1.isAnswered) {
    await sleep(90_000); // re-check to avoid false positives
    const r2 = await checkOnce(CONVERSATION_URL, "t2");
    console.log("Second check result:", r2);

    if (!r2.isAnswered) {
      await sendEmailToRohit(CONVERSATION_URL, r2.lastSender);
    }
  }
};

main().catch(e => { console.error(e); process.exit(1); });
