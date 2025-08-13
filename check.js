import { chromium } from "playwright";
import nodemailer from "nodemailer";
import fs from "fs";

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
  AGENT_SIDE
} = process.env;

if (!CONVERSATION_URL) { console.error("Missing CONVERSATION_URL"); process.exit(1); }
if (!BOOM_USER || !BOOM_PASS) { console.error("Missing BOOM_USER/BOOM_PASS"); process.exit(1); }

const MESSAGE_SELECTORS = [
  // likely patterns
  "[data-testid*='message']",
  "[data-qa*='message']",
  "[class*='message-item']",
  "[class*='MessageItem']",
  "[class*='Message_message']",
  // generic chat bubbles
  ".message, .message-row, .chat-message, .bubble, .msg, li.message, div.message"
];

const GUEST_HINTS = ["guest","customer","user"];
const AGENT_HINTS = ["agent","staff","support","team","operator","admin","oaktree","boom"];
const RIGHT_HINTS = ["right","end","outgoing","sent","self","me"];
const LEFT_HINTS  = ["left","start","incoming","received"];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const save = (path, buf) => fs.writeFileSync(path, buf);
const hasAny = (arr, s) => s && arr.some(h => s.includes(h));
const countAny = (arr, s) => s ? arr.reduce((n,h)=>n + (s.split(h).length-1), 0) : 0;

async function waitForAnySelector(frame, sels, timeout = 45000) {
  for (const sel of sels) {
    try {
      await frame.waitForSelector(sel, { timeout });
      return sel;
    } catch {}
  }
  return null;
}

async function queryAllFramesForMessages(page, sel) {
  for (const f of page.frames()) {
    const els = await f.$$(sel);
    if (els.length) return { frame: f, elements: els };
  }
  return { frame: null, elements: [] };
}

async function collectMessages(frame, elements, take = 12) {
  const docWidth = await frame.evaluate(() => document.documentElement.clientWidth || 1200);
  const out = [];
  for (const el of elements.slice(-take)) {
    const box = await el.boundingBox();
    const center = box ? (box.x + box.width / 2) : 0;
    const cls = ((await el.getAttribute("class")) || "").toLowerCase();
    const txt = ((await el.innerText()) || "").toLowerCase().slice(0, 400);

    const parent = await el.evaluateHandle(n => n.parentElement);
    const grand  = await el.evaluateHandle(n => n.parentElement?.parentElement || null);
    const parentCls = (await (await parent.getProperty("className")).jsonValue() || "").toString().toLowerCase();
    const grandCls  = (await (await grand?.getProperty?.("className")).jsonValue?.() || "").toString().toLowerCase();

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
  if (AGENT_SIDE === "left" || AGENT_SIDE === "right") {
    return { agentSide: AGENT_SIDE, guestSide: AGENT_SIDE === "left" ? "right" : "left" };
  }
  const left  = msgs.filter(m => m.side === "left");
  const right = msgs.filter(m => m.side === "right");
  const leftAgent  = left.reduce((n,m)=>n+m.agentScore,0);
  const leftGuest  = left.reduce((n,m)=>n+m.guestScore,0);
  const rightAgent = right.reduce((n,m)=>n+m.agentScore,0);
  const rightGuest = right.reduce((n,m)=>n+m.guestScore,0);

  if ((rightAgent > leftAgent) || (leftGuest > rightGuest)) return { agentSide: "right", guestSide: "left" };
  if ((leftAgent > rightAgent) || (rightGuest > leftGuest)) return { agentSide: "left", guestSide: "right" };
  return { agentSide: "right", guestSide: "left" };
}

async function ensureMessagesVisible(frame) {
  // try scroll to bottom to materialize virtualized lists
  for (let i=0;i<6;i++) {
    await frame.mouse.wheel(0, 800);
    await sleep(200);
  }
}

async function checkOnce(url) {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    save("/tmp/before_login.png", await page.screenshot());

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
      await page.waitForLoadState("networkidle", { timeout: 60_000 });
      // Navigate AGAIN to the conversation (some apps drop you on a dashboard after login)
      await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
      save("/tmp/after_login.png", await page.screenshot());
    }

    await page.waitForLoadState("networkidle", { timeout: 60_000 });
    save("/tmp/after_regoto.png", await page.screenshot());

    // Look for messages on the main page first
    let sel = await waitForAnySelector(page, MESSAGE_SELECTORS, 30000);
    let found = { frame: null, elements: [] };
    if (sel) {
      await ensureMessagesVisible(page);
      found = { frame: page, elements: await page.$$(sel) };
    } else {
      // scan iframes
      for (const s of MESSAGE_SELECTORS) {
        const r = await queryAllFramesForMessages(page, s);
        if (r.elements.length) { sel = s; found = r; break; }
      }
    }

    if (!sel || !found.elements.length) {
      console.log("No message elements found with known selectors.");
      save("/tmp/nomsg_t1.png", await page.screenshot({ fullPage: true }));
      save("/tmp/nomsg_t1.html", Buffer.from(await page.content()));
      await browser.close();
      return { isAnswered: false, lastSender: "Unknown", reason: "no_selector_match" };
    }

    console.log(`Matched selector: ${sel} (count=${found.elements.length})`);

    const msgs = await collectMessages(found.frame, found.elements, 12);
    const last = msgs.at(-1);
    const { agentSide, guestSide } = decideSides(msgs);

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
    try {
      save("/tmp/nomsg_t2.png", await page.screenshot({ fullPage: true }));
      save("/tmp/nomsg_t2.html", Buffer.from(await page.content()));
    } catch {}
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

const sleepMsBetweenChecks = 90_000; // ~1.5 min

const main = async () => {
  const res1 = await checkOnce(CONVERSATION_URL);
  console.log("First check result:", { isAnswered: res1.isAnswered, lastSender: res1.lastSender });

  if (!res1.isAnswered) {
    await sleep(sleepMsBetweenChecks);
    const res2 = await checkOnce(CONVERSATION_URL);
    console.log("Second check result:", { isAnswered: res2.isAnswered, lastSender: res2.lastSender });
    if (!res2.isAnswered) {
      await sendEmailToRohit(CONVERSATION_URL, res2.lastSender);
    }
  }
};

main().catch(e => { console.error(e); process.exit(1); });
