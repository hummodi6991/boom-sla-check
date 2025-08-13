import { chromium } from "playwright";
import nodemailer from "nodemailer";

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

if (!CONVERSATION_URL) { console.error("Missing CONVERSATION_URL"); process.exit(1); }
if (!BOOM_USER || !BOOM_PASS) { console.error("Missing BOOM_USER/BOOM_PASS"); process.exit(1); }

const SELECTORS = {
  // If needed, change this to the real message row CSS selector after first run
  messageItem: "div.message-item",
  loginUser: 'input[type="email"], input[name="email"], input[name="username"]',
  loginPass: 'input[type="password"]',
  loginSubmit: 'button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")'
};

const GUEST_HINTS = ["guest", "customer"];
const AGENT_HINTS = ["agent", "staff", "support", "team"];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const hasHint = (hints, hay) => hints.some(h => hay.includes(h));

async function checkOnce(url) {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });

    // Login if prompted
    if (await page.$(SELECTORS.loginUser)) {
      await page.fill(SELECTORS.loginUser, BOOM_USER);
      await page.fill(SELECTORS.loginPass, BOOM_PASS);
      await page.click(SELECTORS.loginSubmit);
      await page.waitForLoadState("networkidle", { timeout: 60_000 });
    }

    await page.waitForSelector(SELECTORS.messageItem, { timeout: 20_000 });
    const items = await page.$$(SELECTORS.messageItem);
    if (!items.length) { await browser.close(); return { isAnswered: false, lastSender: "Unknown", reason: "empty_list" }; }

    const last = items[items.length - 1];
    const cls = ((await last.getAttribute("class")) || "").toLowerCase();
    const txt = ((await last.innerText()) || "").toLowerCase();

    let lastSender = "Unknown";
    if (hasHint(GUEST_HINTS, cls) || hasHint(GUEST_HINTS, txt)) lastSender = "Guest";
    else if (hasHint(AGENT_HINTS, cls) || hasHint(AGENT_HINTS, txt)) lastSender = "Agent";

    await browser.close();
    return { isAnswered: lastSender === "Agent", lastSender };
  } catch (e) {
    console.error("Check error:", e?.message || e);
    try { await browser.close(); } catch {}
    return { isAnswered: false, lastSender: "Unknown", reason: "error" };
  }
}

async function sendEmailToRohit(url, lastSender) {
  if (!SMTP_USER || !SMTP_PASS || !ROHIT_EMAIL) {
    console.log("Skipping email (missing SMTP creds or ROHIT_EMAIL).");
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

  await transporter.sendMail({
    from: `"${FROM_NAME || 'Oaktree Boom SLA Bot'}" <${SMTP_USER}>`,
    to: ROHIT_EMAIL,
    replyTo: REPLY_TO || ROHIT_EMAIL,
    subject: "SLA breach (>5 min): Boom guest message unanswered",
    html
  });
}

const main = async () => {
  const res1 = await checkOnce(process.env.CONVERSATION_URL);
  console.log("First check result:", { isAnswered: res1.isAnswered, lastSender: res1.lastSender });

  if (!res1.isAnswered) {
    // Re-check after ~90s to reduce false positives
    await sleep(90_000);
    const res2 = await checkOnce(process.env.CONVERSATION_URL);
    console.log("Second check result:", { isAnswered: res2.isAnswered, lastSender: res2.lastSender });

    if (!res2.isAnswered) {
      await sendEmailToRohit(process.env.CONVERSATION_URL, res2.lastSender);
    }
  }
};

main().catch(e => { console.error(e); process.exit(1); });
