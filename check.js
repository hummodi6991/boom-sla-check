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
  // Set in repo Secrets to force side mapping: "right" or "left"
  AGENT_SIDE
} = process.env;

if (!CONVERSATION_URL) { console.error("Missing CONVERSATION_URL"); process.exit(1); }
if (!BOOM_USER || !BOOM_PASS) { console.error("Missing BOOM_USER/BOOM_PASS"); process.exit(1); }

const MESSAGE_SELECTORS = [
  // Common Boom/CRM patterns
  "div.message-item",
  "[data-testid='message-item']",
  "[data-testid*='message']",
  "[class*='message-item']",
  "[class*='message__item']",
  "[class*='message']",
  "[class*='chat-message']",
  "div[class*='bubble']",
  "[data-message-id]",
  "li[class*='message']",
  "[role='listitem'][class*='message']",
];

const GUEST_HINTS = ["guest", "customer", "user"];
const AGENT_HINTS = ["agent", "staff", "support", "team", "operator", "admin", "oaktree", "boom"];
const RIGHT_HINTS = ["right", "end", "outgoing", "sent", "self", "me"];
const LEFT_HINTS  = ["left", "start", "incoming", "received"];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const countAny = (hints, s) => s ? hints.reduce((n,h)=>n + (s.split(h).length-1), 0) : 0;

async function dumpArtifacts(page, tag) {
  try {
    const png = `/tmp/${tag}.png`;
    const html = `/tmp/${tag}.html`;
    await page.screenshot({ path: png, fullPage: true });
    fs.writeFileSync(html, await page.content(), "utf8");
    console.log(`Saved artifacts: ${png}, ${html}`);
  } catch (e) {
    console.log("Artifact save failed:", e.message || e);
  }
}

async function waitForAnySelector(frame, selectors, timeoutMs = 45000) {
  for (const sel of selectors) {
    try {
      await frame.waitForSelector(sel, { timeout: Math.max(2000, Math.floor(timeoutMs / selectors.length)) });
      return sel;
    } catch (_) {}
  }
  return null;
}

async function queryAllFramesForMessages(page, selector) {
  for (const f of page.frames()) {
    const els = await f.$$(selector);
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
    const g2 = grand ? await grand.getProperty("className") : null;
    const grandCls  = (await (g2?.jsonValue?.() ?? Promise.resolve(""))).toString().toLowerCase();

    const blob = [cls, parentCls, grandCls, txt].join(" ");

    const isRightByPos = center > (docWidth / 2);
    const alignHints = (RIGHT_HINTS.some(h => blob.includes(h)) && "right")
                    || (LEFT_HINTS.some(h => blob.includes(h))  && "left")
                    || null;

    out.push({
      side: alignHints || (isRightByPos ? "right" : "left"),
      agentScore: countAny(AGENT_HINTS, blob),
      guestScore: countAny(GUEST_HINTS, blob)
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
  return { agentSide: "right", guestSide: "left" }; // sensible default
}

async function openConversation(page, url) {
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
}

async function findMessages(page) {
  // Try on main page first
  let sel = await waitForAnySelector(page, MESSAGE_SELECTORS, 45000);
  if (sel) {
    // Scroll to bottom to load latest bubbles
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(800);
    const els = await page.$$(sel);
    if (els.length) return { frame: page, sel, elements: els };
  }
  // Try every frame
  for (const s of MESSAGE_SELECTORS) {
    const r = await queryAllFramesForMessages(page, s);
    if (r.elements.length) return { frame: r.frame, sel: s, elements: r.elements };
  }
  return { frame: null, sel: null, elements: [] };
}

async function checkOnce(url, tag) {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await openConversation(page, url);
    const found = await findMessages(page);
    if (!found.elements.length) {
      console.log("No message elements found with known selectors.");
      await dumpArtifacts(page, `nomsg_${tag}`);
      await browser.close();
      return { isAnswered: false, lastSender: "Unknown", reason: "no_selector_match" };
    }
    console.log(`Matched selector: ${found.sel} (count=${found.elements.length})`);
    const msgs = await collectMessages(found.frame, found.elements, 12);
    const { agentSide, guestSide } = decideSides(msgs);
    const last = msgs[msgs.length - 1];
    console.log(`Side mapping → Agent: ${agentSide}, Guest: ${guestSide}`);
    console.log(`Last bubble side: ${last?.side}, scores A:${last?.agentScore} G:${last?.guestScore}`);
    await browser.close();

    const lastSender = last?.side === agentSide ? "Agent"
                     : last?.side === guestSide ? "Guest"
                     : "Unknown";

    return { isAnswered: lastSender === "Agent", lastSender };

  } catch (e) {
    console.error("Check error:", e?.message || e);
    try { await dumpArtifacts(page, `error_${tag}`); } catch {}
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
  const res1 = await checkOnce(process.env.CONVERSATION_URL, "t1");
  console.log("First check result:", { isAnswered: res1.isAnswered, lastSender: res1.lastSender });

  if (!res1.isAnswered) {
    await sleep(90_000); // ~1.5 minutes, complements the 4-min delay in Power Automate
    const res2 = await checkOnce(process.env.CONVERSATION_URL, "t2");
    console.log("Second check result:", { isAnswered: res2.isAnswered, lastSender: res2.lastSender });

    if (!res2.isAnswered) {
      await sendEmailToRohit(process.env.CONVERSATION_URL, res2.lastSender);
    }
  }
};

main().catch(e => { console.error(e); process.exit(1); });
