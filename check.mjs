// check.mjs
// Boom SLA checker (API-first, URL/UUID tolerant) — adds robust message fetch + link in email

import nodemailer from "nodemailer";
import { setTimeout as delay } from "timers/promises";

// ---------- Config / Inputs ----------
const {
  BOOM_USER,
  BOOM_PASS,
  ALERT_TO,
  ALERT_CC = "",
  ALERT_FROM_NAME = "Oaktree Boom SLA Bot",
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  // Optional: comma-separated fallbacks when running by hand:
  CONVERSATION_URLS = "",
  SLA_MINUTES = "5",
} = process.env;

const INPUT_URLS = (process.env["INPUT_CONVERSATION_URLS"] || "").trim();

// SLA in minutes (integer)
const SLA_MIN = Math.max(1, parseInt(SLA_MINUTES, 10) || 5);

// Base
const BOOM_ORIGIN = "https://app.boomnow.com";

// ---------- Helpers ----------
const log = (...a) => console.log(...a);
const json = (x) => JSON.stringify(x, null, 2);

function parseList(val) {
  return (val || "")
    .split(/[\n,]/)
    .map(s => s.trim())
    .filter(Boolean);
}

function ensureArray(x) {
  return Array.isArray(x) ? x : (x ? [x] : []);
}

// Normalize any of:
//  - UI URL:  https://app.boomnow.com/dashboard/guest-experience/.../<uuid>
//  - API URL: https://app.boomnow.com/api/conversations/<uuid>
//  - UUID:    8-4-4-4-12
function normalizeConversation(input) {
  const s = (input || "").trim();

  // UUID?
  const mUuid = s.match(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i
  );
  const id = mUuid ? mUuid[0] : null;

  // UI link (we’ll always build one for email)
  const uiUrl = id
    ? `${BOOM_ORIGIN}/dashboard/guest-experience/sales/${id}`
    : null;

  // API endpoints we might need
  const apiConversation = id
    ? `${BOOM_ORIGIN}/api/conversations/${id}`
    : null;
  const apiMessages1 = id
    ? `${BOOM_ORIGIN}/api/conversations/${id}/messages?limit=200`
    : null;
  const apiMessages2 = id
    ? `${BOOM_ORIGIN}/api/messages?conversation_id=${id}&limit=200`
    : null;
  const apiConversationWithThread = id
    ? `${BOOM_ORIGIN}/api/conversations/${id}?include=thread`
    : null;

  return { id, uiUrl, apiConversation, apiMessages1, apiMessages2, apiConversationWithThread };
}

// Poor man’s cookie jar for Node fetch
class CookieJar {
  constructor() { this.map = new Map(); }
  addFrom(setCookieHeaders = []) {
    ensureArray(setCookieHeaders).forEach((h) => {
      const m = /^(?<name>[^=]+)=(?<val>[^;]+)/.exec(h || "");
      if (m?.groups?.name) this.map.set(m.groups.name, m.groups.val);
    });
  }
  header() {
    if (!this.map.size) return "";
    return [...this.map.entries()].map(([k,v]) => `${k}=${v}`).join("; ");
  }
}

async function fetchWithCookies(url, opts = {}, jar) {
  const headers = new Headers(opts.headers || {});
  if (jar?.header()) headers.set("Cookie", jar.header());
  // Default JSON accept
  if (!headers.has("accept")) headers.set("accept", "application/json, */*");
  const res = await fetch(url, { ...opts, headers });
  const setCk = res.headers.getSetCookie?.() || res.headers.raw?.()["set-cookie"] || [];
  if (jar && setCk?.length) jar.addFrom(setCk);
  return res;
}

async function fetchJson(url, opts = {}, jar) {
  const res = await fetchWithCookies(url, opts, jar);
  const text = await res.text();
  try {
    return { res, data: text ? JSON.parse(text) : {} };
  } catch {
    throw new Error(`Non-JSON response from ${url}`);
  }
}

function pickFirst(arr, ...keys) {
  for (const k of keys) {
    const v = arr[k];
    if (Array.isArray(v) && v.length) return v;
  }
  return null;
}

function isGuestMessage(msg) {
  const role = (msg.sender_role || msg.role || msg.sender_type || msg.author_type || "").toString().toLowerCase();
  const incoming = (msg.incoming ?? msg.is_incoming ?? msg.direction === "in");
  const isGuest = /guest|customer|visitor|client/.test(role);
  return incoming || isGuest || role === "guest";
}

function isHumanAgentMessage(msg) {
  const role = (msg.sender_role || msg.role || msg.sender_type || msg.author_type || "").toString().toLowerCase();
  const from = (msg.sender_name || msg.from || msg.author || "").toString().toLowerCase();

  const looksAgent =
    /agent|staff|user|operator|teammate|assignee/.test(role) ||
    /agent|staff|team|support/.test(from);

  // try to exclude AI / suggestions
  const flags = (msg.flags || msg.tags || []).map(x => (x||"").toString().toLowerCase());
  const text = ((msg.text || msg.body || msg.message || "") + " " + JSON.stringify(msg)).toLowerCase();
  const looksAi =
    flags.some(f => /ai|copilot|suggestion|auto[_-]?pilot/.test(f)) ||
    /ai|co[_-]?pilot|suggestion|auto[_-]?pilot/.test(text);

  return looksAgent && !looksAi;
}

function getStamp(msg) {
  const t =
    msg.created_at ||
    msg.inserted_at ||
    msg.sent_at ||
    msg.timestamp ||
    msg.time ||
    msg.date;
  return t ? new Date(t) : null;
}

function minutesDiff(a, b = new Date()) {
  return Math.floor((b - a) / 60000);
}

// ---------- Login flow ----------
async function loginAndGetJar() {
  const jar = new CookieJar();

  // CSRF preflight (if present we’ll capture cookies; if not, proceed)
  try {
    const csrf = await fetchWithCookies(`${BOOM_ORIGIN}/sanctum/csrf-cookie`, {}, jar);
    const setCk = csrf.headers.getSetCookie?.() || csrf.headers.raw?.()["set-cookie"] || [];
    if (!setCk?.length) log("CSRF preflight returned no Set-Cookie. Will attempt login anyway.");
  } catch {
    log("CSRF preflight failed; continuing to login.");
  }

  // Actual login
  const payload = { email: BOOM_USER, password: BOOM_PASS, tenant_id: null };
  const res = await fetchWithCookies(`${BOOM_ORIGIN}/api/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json, */*",
    },
    body: JSON.stringify(payload),
  }, jar);

  if (!res.ok) throw new Error(`Login failed: HTTP ${res.status}`);

  // small wait just in case the session needs to settle
  await delay(150);
  return jar;
}

// ---------- Robust messages fetch ----------
async function loadMessagesFor(id, jar) {
  // Try the 3 strategies in order
  const endpoints = [
    `${BOOM_ORIGIN}/api/conversations/${id}/messages?limit=200`,
    `${BOOM_ORIGIN}/api/messages?conversation_id=${id}&limit=200`,
    `${BOOM_ORIGIN}/api/conversations/${id}?include=thread`
  ];

  // 1) /api/conversations/:id/messages
  try {
    const { data } = await fetchJson(endpoints[0], {}, jar);
    if (Array.isArray(data) && data.length) return data;
  } catch (_) {}

  // 2) /api/messages?conversation_id=...
  try {
    const { data } = await fetchJson(endpoints[1], {}, jar);
    if (Array.isArray(data) && data.length) return data;
    // Some APIs return { data: [...] }
    if (Array.isArray(data?.data) && data.data.length) return data.data;
  } catch (_) {}

  // 3) /api/conversations/:id?include=thread  -> look for thread.messages
  try {
    const { data } = await fetchJson(endpoints[2], {}, jar);
    if (data && typeof data === "object") {
      // Try common shapes
      const msgs =
        data.thread?.messages ||
        data.messages ||
        (Array.isArray(data.thread) ? data.thread : null);

      if (Array.isArray(msgs) && msgs.length) return msgs;

      // last-resort debug
      const keys = Object.keys(data || {});
      log(`debug: messages array empty; top-level keys = ${json(keys)}`);
    }
  } catch (_) {}

  return [];
}

// ---------- Core SLA logic ----------
async function checkOne(inputStr, jar) {
  const conv = normalizeConversation(inputStr);
  if (!conv.id) throw new Error(`Could not find conversation UUID in "${inputStr}"`);

  const msgs = await loadMessagesFor(conv.id, jar);

  if (!msgs.length) {
    return {
      ok: true,
      reason: "no_timestamps",
      convoId: conv.id,
      conversationLink: conv.uiUrl,
    };
  }

  // Identify last guest message and last human-agent message
  let lastGuest = null;
  let lastAgent = null;

  for (const m of msgs) {
    const ts = getStamp(m);
    if (!ts) continue;

    if (isGuestMessage(m)) {
      if (!lastGuest || ts > lastGuest.ts) lastGuest = { ts, raw: m };
    } else if (isHumanAgentMessage(m)) {
      if (!lastAgent || ts > lastAgent.ts) lastAgent = { ts, raw: m };
    }
  }

  if (!lastGuest) {
    return { ok: true, reason: "no_guest_msgs", convoId: conv.id, conversationLink: conv.uiUrl };
  }

  // If guest was last and agent hasn’t replied within SLA -> alert
  const guestAfterAgent =
    !lastAgent || (lastGuest.ts && lastAgent.ts && lastGuest.ts > lastAgent.ts);

  const minsSinceGuest = minutesDiff(lastGuest.ts);
  const minsSinceAgent = lastAgent?.ts ? minutesDiff(lastAgent.ts) : null;

  const needsAlert = guestAfterAgent && minsSinceGuest >= SLA_MIN;

  return {
    ok: !needsAlert,
    reason: needsAlert ? "guest_unanswered" : "agent_last",
    minsSinceGuest,
    minsSinceAgent,
    convoId: conv.id,
    conversationLink: conv.uiUrl,
  };
}

// ---------- Email ----------
async function sendAlertEmail(result) {
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT || "587", 10),
    secure: String(SMTP_PORT) === "465",
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  const subject = "⚠️ Boom SLA: guest unanswered ≥ 5m";
  const parts = [
    "Guest appears unanswered ≥ 5 minutes.",
    result?.conversationLink ? `\nOpen conversation: ${result.conversationLink}` : "",
  ].filter(Boolean);

  await transporter.sendMail({
    from: `"${ALERT_FROM_NAME}" <${SMTP_USER}>`,
    to: ALERT_TO,
    cc: ALERT_CC || undefined,
    subject,
    text: parts.join("\n"),
    html: parts.map(p => p ? `<p>${escapeHtml(p)}</p>` : "").join(""),
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------- Main ----------
(async () => {
  try {
    const fromWorkflow = parseList(INPUT_URLS);
    const fromEnv = parseList(CONVERSATION_URLS);
    const all = [...fromWorkflow, ...fromEnv];

    if (!all.length) {
      throw new Error("No conversation_urls provided (workflow input).");
    }

    const jar = await loginAndGetJar();

    log(`Checking ${all.length} conversation(s) @ SLA ${SLA_MIN}m ...`);
    const results = [];
    for (const item of all) {
      const r = await checkOne(item, jar);
      results.push(r);
    }

    // Send alerts for any that failed the SLA
    for (const r of results) {
      const needsAlert = r && r.ok === false && r.reason === "guest_unanswered";
      log("Second check result:", json(r));
      if (needsAlert) {
        await sendAlertEmail(r);
        log("✅ Alert email sent.");
      } else {
        log("No alert sent (not guest/unanswered).");
      }
    }
  } catch (err) {
    console.error("Error:", err.message || err);
    process.exit(1);
  }
})();
