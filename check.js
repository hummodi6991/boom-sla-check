import { chromium } from "playwright";
import nodemailer from "nodemailer";
import fs from "fs/promises";
import path from "path";

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

// Try many likely selectors; we'll pick the first that returns nodes
const MESSAGE_SELECTOR_CANDIDATES = [
  "div.message-item",
  ".message-item",
  ".message",
  ".message-row",
  ".chat-message",
  ".msg",
  "[data-testid*='message']",
  "[class*='message']",
  "[class*='Message']",
  "[role='listitem']",
];

const SELECTORS = {
  loginUser: 'input[type="email"], input[name="email"], input[name="username"]',
  loginPass: 'input[type="password"]',
  loginSubmit: 'button[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Login")'
};

const GUEST_HINTS = ["guest", "customer"];
const AGENT_HINTS = ["agent", "staff", "support", "team", "you", "oaktree", "boom"];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const hasHint = (hints, hay) => hints.some(h => hay.includes(h));

async function saveArtifacts(page, tag) {
  const png = `/tmp/nomsg_${tag}.png`;
  const html = `/tmp/nomsg_${tag}.html`;
  try {
    await page.screenshot({ path: png, fullPage: true });
    await fs.writeFile(html, await page.content(), "utf8");
    console.log(`📎 Saved artifacts: ${png}, ${html}`);
  } catch (e) {
    console.log("Could not save artifacts:", e?.message || e);
  }
}

async function findMessageSelector(page) {
  for (const sel of MESSAGE_SELECTOR_CANDIDATES) {
    const nodes = await page.$$(sel);
    if (nodes.length > 0) return { selector: sel, nodes };
  }
  return { selector: null, nodes: [] };
}

async function checkOnce(url, tag) {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });

    // Login if prompted
    if (await page.$(SELECTORS.loginUser)) {
      console.log("🔐 Login form detected — signing in…");
      await page.fill(SELECTORS.loginUser, BOOM_USER);
      await page.fill(SELECTORS.loginPass, BOOM_PASS);
      await page.click(SELECTORS.loginSubmit);
      await page.waitForLoadState("networkidle", { timeout: 60_000 });
      await sleep(1500);
    }

    const { selector, nodes } = await findMessageSelector(page);
    if (!selector || nodes.length === 0) {
      console.log("⚠️  No message elements found with known selectors.");
      await saveArtifacts(page, tag);
      await browser.close();
      return { isAnswered: false, lastSender: "Unknown", reason: "no_selector" };
    }

    console.log(`✅ Using selector: "${selector}" (found ${nodes.length} nodes)`);
    const last = nodes[nodes.length - 1];
    const cls = ((await last.getAttribute("class")) || "").toLowerCase();
    const txt = ((await last.innerText()) || "").toLowerCase();

    let lastSender = "Unknown";
    if (hasHint(GUEST_HINTS, cls) || hasHint(GUEST_HINTS, txt)) lastSender = "Guest";
    if (hasHint(AGENT_HINTS, cls) || hasHint(AGENT_HINTS, txt)) lastSender = "Agent";

    await browser.close();
    return { isAnswered: lastSender === "Agent", lastSender };
  } catch (e) {
    console.error("Check error:", e?.message || e);
    try { await saveArtifacts(page, `${tag}_err`); } catch {}
    try { await browser.close(); } catch {}
    return { isAnswered: false, lastSender: "Unknown", reason: "error" };
  }
}

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
