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
  REPLY_TO,
  // Optional override: set to "right" or "left" in repo Secrets if you know which side is Agent
  AGENT_SIDE
} = process.env;

if (!CONVERSATION_URL) { console.error("Missing CONVERSATION_URL"); process.exit(1); }
if (!BOOM_USER || !BOOM_PASS) { console.error("Missing BOOM_USER/BOOM_PASS"); process.exit(1); }

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

const GUEST_HINTS = ["guest", "customer", "user"];
const AGENT_HINTS = ["agent", "staff", "support", "team", "operator", "admin", "oaktree", "boom"];
const RIGHT_HINTS = ["right", "end", "outgoing", "sent", "self", "me"];
const LEFT_HINTS  = ["left", "start", "incoming", "received"];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const hasAny = (hints, s) => s && hints.some(h => s.includes(h));
const countAny = (hints, s) => s ? hints.reduce((n,h)=>n + (s.split(h).length-1), 0) : 0;

async function waitForAnySelector(frame, selectors, timeoutMs = 45000) {
  const waits = selectors.map(sel =>
    frame.waitForSelector(sel, { timeout: timeoutMs }).then(() => sel).catch(() => null)
  );
  const results = await Promise.all(waits);
  return results.find(Boolean);
}

async function queryAllFramesForMessages(page, selector) {
  for (const f of page.frames()) {
    const els = await f.$$(selector);
    if (els.length) return { frame: f, elements: els };
  }
  return { frame: null, elements: [] };
}

async function collectMessages(frame, elements, take = 10) {
  const docWidth = await frame.evaluate(() => document.documentElement.clientWidth || 1200);
  const out = [];
  for (const el of elements.slice(-take)) {
    const box = await el.boundingBox();
    const center = box ? (box.x + box.width / 2) : 0;
    const cls = ((await el.getAttribute("class")) || "").toLowerCase();
    const txt = ((await el.innerText()) || "").toLowerCase().slice(0, 400);

    // climb a bit, lots of frameworks put role classes on ancestors
    const parent = await el.evaluateHandle(n => n.parentElement);
    const grand  = await el.evaluateHandle(n => n.parentElement?.parentElement || null);
    const g2 = grand ? await grand.getProperty("className") : null;

    const parentCls = (await (await parent.getProperty("className")).jsonValue() || "").toString().toLowerCase();
    const grandCls  = (await (g2?.jsonValue?.() ?? Promise.resolve(""))).toString().toLowerCase();

    // merged strings for heuristics
    const blob = [cls, parentCls, grandCls, txt].join(" ");

    const isRightByPos = center > (docWidth / 2);
    const alignHints = (RIGHT_HINTS.some(h => blob.includes(h)) && "right")
                    || (LEFT_HINTS.some(h => blob.includes(h))  && "left")
                    || null;

    out.push({
      element: el, center, docWidth,
      cls, parentCls, grandCls, txt, blob,
      side: alignHints || (isRightByPos ? "right" : "left"),
      guestScore: countAny(GUEST_HINTS, blob),
      agentScore: countAny(AGENT_HINTS, blob)
    });
  }
  return out;
}

function decideSides(msgs) {
  // group by side
  const left  = msgs.filter(m => m.side === "left");
  const right = msgs.filter(m => m.side === "right");

  // If user explicitly configured AGENT_SIDE, honor it
  if (AGENT_SIDE === "left" || AGENT_SIDE === "right") {
    return { agentSide: AGENT_SIDE, guestSide: AGENT_SIDE === "left" ? "right" : "left" };
  }

  // Use scores if any side has stronger "agent" or "guest" hints
  const leftAgent  = left.reduce((n,m)=>n+m.agentScore,0);
  const leftGuest  = left.reduce((n,m)=>n+m.guestScore,0);
  const rightAgent = right.reduce((n,m)=>n+m.agentScore,0);
  const rightGuest = right.reduce((n,m)=>n+m.guestScore,0);

  if ((rightAgent > leftAgent) || (leftGuest > rightGuest)) return { agentSide: "right", guestSide: "left" };
  if ((leftAgent > rightAgent) || (rightGuest > leftGuest)) return { agentSide: "left", guestSide: "right" };

  // Fallback: many CRMs render staff on the right
  return { agentSide: "right", guestSide: "left" };
}

async function checkOnce(url) {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });

    // Login if needed
    const loginUserSel = 'input[type="email"], input[name="email"], input[name="username"]';
    if (await page.$(loginUserSel)) {
      await page.fill(loginUserSel, BOOM_USER);
      await page.fill('input[type="password"]', BOOM_PASS);
      await Promise.race([
        page.click('button[type="submit"]').catch(()=>{}),
        page.click('button:has-text("Sign in")').catch(()=>{}),
        page.click('button:has-text("Log in")').catch(()=>{}),
      ]);
    }

    await page.waitForLoadState("networkidle", { timeout: 60_000 });

    // Find message selector/frame
    let sel = await waitForAnySelector(page, MESSAGE_SELECTORS, 45000);
    let found = { frame: null, elements: [] };
    if (sel) {
      found = { frame: page, elements: await page.$$(sel) };
    } else {
      for (const s of MESSAGE_SELECTORS) {
        const r = await queryAllFramesForMessages(page, s);
        if (r.elements.length) { sel = s; found = r; break; }
      }
    }
    if (!sel || !found.elements.length) {
      console.log("No message elements found with any known selector.");
      await browser.close();
      return { isAnswered: false, lastSender: "Unknown", reason: "no_selector_match" };
    }
    console.log(`Matched selector: ${sel} (count=${found.elements.length})`);

    // Collect last few messages and decide sides
    const msgs = await collectMessages(found.frame, found.elements, 10);
    const { agentSide, guestSide } = decideSides(msgs);
    const last = msgs[msgs.length - 1];

    // Verbose log to help once, then you can delete
    console.log(`Side mapping → Agent: ${agentSide}, Guest: ${guestSide}`);
    console.log(`Last bubble side: ${last?.side}, scores A:${last?.agentScore} G:${last?.guestScore}`);

    let lastSender = "Unknown";
    if (last) {
      if (last.side === agentSide) lastSender = "Agent";
      else if (last.side === guestSide) lastSender = "Guest";
    }

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
    await sleep(90_000); // brief backoff
    const res2 = await checkOnce(process.env.CONVERSATION_URL);
    console.log("Second check result:", { isAnswered: res2.isAnswered, lastSender: res2.lastSender });

    if (!res2.isAnswered) {
      await sendEmailToRohit(process.env.CONVERSATION_URL, res2.lastSender);
    }
  }
};

main().catch(e => { console.error(e); process.exit(1); });
