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

// Try a bunch of likely message-row selectors (case-insensitive substring matches)
const MESSAGE_SELECTORS = [
  "[data-testid*='message']",
  "[class*='message']",
  "[class*='chat-message']",
  "div.message",
  "li.message",
  ".message-row",
  ".chat__message",
  ".conversation__message",
  "[role='listitem']",
];

// Possible hints that identify who sent the message
const GUEST_HINTS = ["guest", "customer", "user"];
const AGENT_HINTS = ["agent", "staff", "support", "team", "operator", "admin"];

// Some UIs align guest/agent bubbles differently; use as a weak hint
const RIGHT_HINTS = ["right", "end", "outgoing", "sent"];
const LEFT_HINTS  = ["left", "start", "incoming", "received"];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const hasHint = (hints, hay) => hay && hints.some(h => hay.includes(h));

async function waitForAnySelector(frame, selectors, timeoutMs = 45000) {
  // Wait in parallel for any selector to appear
  const waits = selectors.map(sel =>
    frame.waitForSelector(sel, { timeout: timeoutMs }).then(() => sel).catch(() => null)
  );
  const results = await Promise.all(waits);
  return results.find(Boolean); // first non-null selector that appeared
}

async function queryAllFramesForMessages(page, selector) {
  const frames = page.frames();
  for (const f of frames) {
    const els = await f.$$(selector);
    if (els.length) return { frame: f, elements: els };
  }
  return { frame: null, elements: [] };
}

async function detectLastSender(frame, elements) {
  const last = elements[elements.length - 1];
  if (!last) return { isAnswered: false, lastSender: "Unknown" };

  const cls = ((await last.getAttribute("class")) || "").toLowerCase();
  const txt = ((await last.innerText()) || "").toLowerCase();

  // Look one level up as well (some frameworks attach role classes to parent)
  const parent = await last.evaluateHandle(el => el.parentElement);
  const parentCls = (parent && (await parent.getProperty("className")).toString().toLowerCase()) || "";

  let lastSender = "Unknown";

  if (hasHint(GUEST_HINTS, cls) || hasHint(GUEST_HINTS, txt) || hasHint(GUEST_HINTS, parentCls)) {
    lastSender = "Guest";
  } else if (hasHint(AGENT_HINTS, cls) || hasHint(AGENT_HINTS, txt) || hasHint(AGENT_HINTS, parentCls)) {
    lastSender = "Agent";
  } else {
    // Alignment heuristic (weak). Inspect classes up the tree.
    const bubble = await last.evaluateHandle(el => {
      let n = el;
      for (let i = 0; i < 3 && n; i++) n = n.parentElement;
      return n;
    });

    let bubbleCls = "";
    try {
      bubbleCls = (await (await bubble.getProperty("className")).jsonValue() || "").toLowerCase();
    } catch (_) {}

    if (hasHint(RIGHT_HINTS, cls + " " + bubbleCls)) {
      // Often agent bubbles are on the right
      lastSender = "Agent";
    } else if (hasHint(LEFT_HINTS, cls + " " + bubbleCls)) {
      lastSender = "Guest";
    }
  }

  return { isAnswered: lastSender === "Agent", lastSender };
}

async function checkOnce(url) {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });

    // If login form appears, log in
    const loginUserSel = 'input[type="email"], input[name="email"], input[name="username"]';
    if (await page.$(loginUserSel)) {
      await page.fill(loginUserSel, BOOM_USER);
      await page.fill('input[type="password"]', BOOM_PASS);
      await Promise.race([
        page.click('button[type="submit"]'),
        page.click('button:has-text("Sign in")').catch(()=>{}),
        page.click('button:has-text("Log in")').catch(()=>{}),
      ]);
    }

    // Wait until network settles and UI renders
    await page.waitForLoadState("networkidle", { timeout: 60_000 });

    // Try to find a selector that actually exists (search main frame first)
    let matchedSelector = await waitForAnySelector(page, MESSAGE_SELECTORS, 45000);
    let found = { frame: null, elements: [] };

    if (matchedSelector) {
      found = { frame: page, elements: await page.$$(matchedSelector) };
    } else {
      // Maybe content is inside an iframe; try each selector across frames
      for (const sel of MESSAGE_SELECTORS) {
        const result = await queryAllFramesForMessages(page, sel);
        if (result.elements.length) { matchedSelector = sel; found = result; break; }
      }
    }

    if (!matchedSelector || !found.elements.length) {
      console.log("No message elements found with any known selector.");
      await browser.close();
      return { isAnswered: false, lastSender: "Unknown", reason: "no_selector_match" };
    }

    console.log(`Matched selector: ${matchedSelector} (count=${found.elements.length})`);
    const verdict = await detectLastSender(found.frame, found.elements);

    await browser.close();
    return verdict;

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
    await sleep(90_000); // brief backoff to reduce false positives
    const res2 = await checkOnce(process.env.CONVERSATION_URL);
    console.log("Second check result:", { isAnswered: res2.isAnswered, lastSender: res2.lastSender });

    if (!res2.isAnswered) {
      await sendEmailToRohit(process.env.CONVERSATION_URL, res2.lastSender);
    }
  }
};

main().catch(e => { console.error(e); process.exit(1); });
