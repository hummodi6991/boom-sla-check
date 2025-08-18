// Boom SLA alerts via REST API
// If the last message is from a GUEST and there's no AGENT reply within SLA_MINUTES, send an email.
// Includes conversation link in alert.

import nodemailer from "nodemailer";

// ---------- ENV (robust defaults; blank values fall back) ----------
const envOr = (k, d = "") => {
  const v = process.env[k];
  if (v === undefined || v === null) return d;
  const t = String(v).trim();
  return t === "" ? d : t;
};
const httpMethod = (name, dflt) => envOr(name, dflt).toUpperCase();

const BOOM_USER  = envOr("BOOM_USER");
const BOOM_PASS  = envOr("BOOM_PASS");

const LOGIN_URL             = envOr("LOGIN_URL");
const LOGIN_METHOD          = httpMethod("LOGIN_METHOD", "POST");
const LOGIN_CT              = envOr("LOGIN_CT", "application/json");
const LOGIN_EMAIL_FIELD     = envOr("LOGIN_EMAIL_FIELD", "email");
const LOGIN_PASSWORD_FIELD  = envOr("LOGIN_PASSWORD_FIELD", "password");
const LOGIN_TENANT_FIELD    = envOr("LOGIN_TENANT_FIELD", "");

const API_BEARER            = envOr("API_BEARER", ""); // optional direct Authorization

const CSRF_HEADER_NAME      = envOr("CSRF_HEADER_NAME", "");
const CSRF_COOKIE_NAME      = envOr("CSRF_COOKIE_NAME", "");

const MESSAGES_URL          = envOr("MESSAGES_URL");
const MESSAGES_METHOD       = httpMethod("MESSAGES_METHOD", "GET");
const MESSAGES_HEADERS_JSON = envOr("MESSAGES_HEADERS_JSON", "");

const SLA_MINUTES           = parseFloat(envOr("SLA_MINUTES", "5"));
const COUNT_AI_AS_AGENT     = /^true$/i.test(envOr("COUNT_AI_SUGGESTION_AS_AGENT", "false"));

const SMTP_HOST  = envOr("SMTP_HOST");
const SMTP_PORT  = parseInt(envOr("SMTP_PORT", "587"), 10);
const SMTP_USER  = envOr("SMTP_USER");
const SMTP_PASS  = envOr("SMTP_PASS");
const ALERT_TO   = envOr("ALERT_TO");
const ALERT_FROM_NAME = envOr("ALERT_FROM_NAME", "Boom SLA Bot");

const UI_URL_TEMPLATE       = envOr("UI_URL_TEMPLATE", "");

const DEFAULT_CONVERSATION_ID = envOr("DEFAULT_CONVERSATION_ID", "");
const CONVERSATION_INPUT      = envOr("CONVERSATION_INPUT", "");
const DEBUG = envOr("DEBUG", "");

// ---------- UTILS ----------
const log = (...a) => { if (DEBUG) console.log("[DEBUG]", ...a); };
const isUuid = (s) =>
  typeof s === "string" &&
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i.test(s);

const findUuid = (s) => {
  if (!s) return "";
  const m = s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  return m ? m[0] : "";
};

function extractConversationId(input) {
  if (!input) return "";
  try {
    const u = new URL(input);
    const pathUuid = findUuid(u.pathname);
    if (pathUuid) return pathUuid;
    const qUuid = findUuid(u.search);
    if (qUuid) return qUuid;
    const seg = u.pathname.split("/").filter(Boolean).pop() || "";
    if (isUuid(seg)) return seg;
    if (seg) return seg; // allow non-uuid ids too
  } catch {
    if (isUuid(input)) return input;
    if (input) return input;
  }
  return "";
}

function buildConversationLink({ input, id, uiTemplate, messagesTemplate }) {
  try {
    const u = new URL(input || "");
    if (u.protocol === "http:" || u.protocol === "https:") return u.href;
  } catch { /* not a URL */ }

  if (uiTemplate && uiTemplate.includes("{{conversationId}}")) {
    return uiTemplate.replace("{{conversationId}}", id);
  }
  if (messagesTemplate && messagesTemplate.includes("{{conversationId}}")) {
    return messagesTemplate.replace("{{conversationId}}", id);
  }
  return id;
}

// Split multi-Set-Cookie header
function splitSetCookie(headerValue) {
  if (!headerValue) return [];
  return headerValue.match(/(?:[^,]|,(?=\s*[^;\s=]+=[^,;]+))/g) || [];
}
class CookieJar {
  constructor() { this.map = new Map(); }
  eatFrom(res) {
    const raw = res.headers.get("set-cookie");
    const parts = splitSetCookie(raw);
    for (const p of parts) {
      const [pair] = p.split(";");
      const idx = pair.indexOf("=");
      if (idx > 0) {
        const name = pair.slice(0, idx).trim();
        const value = pair.slice(idx + 1).trim();
        if (name) this.map.set(name, value);
      }
    }
  }
  header() {
    if (!this.map.size) return "";
    return [...this.map.entries()].map(([k,v]) => `${k}=${v}`).join("; ");
  }
  get(n){ return this.map.get(n) || ""; }
}
const jar = new CookieJar();

async function fetchWithCookies(url, opts = {}) {
  const headers = new Headers(opts.headers || {});
  const cookie = jar.header();
  if (cookie) headers.set("cookie", cookie);
  const res = await fetch(url, { ...opts, headers, redirect: "follow" });
  jar.eatFrom(res);
  return res;
}

// ---------- AUTH ----------
async function loginIfNeeded() {
  if (API_BEARER) {
    log("Using API_BEARER; skipping login.");
    return { token: API_BEARER };
  }
  if (!LOGIN_URL) {
    log("No LOGIN_URL provided; skipping login.");
    return { token: null };
  }

  const payload = {};
  if (LOGIN_EMAIL_FIELD)    payload[LOGIN_EMAIL_FIELD] = BOOM_USER;
  if (LOGIN_PASSWORD_FIELD) payload[LOGIN_PASSWORD_FIELD] = BOOM_PASS;
  if (LOGIN_TENANT_FIELD)   payload[LOGIN_TENANT_FIELD] = envOr("BOOM_TENANT", "");

  let body, headers = {};
  if (/json/i.test(LOGIN_CT)) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(payload);
  } else {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(payload).toString();
  }

  log("Logging in:", LOGIN_URL, LOGIN_METHOD);
  const res = await fetchWithCookies(LOGIN_URL, { method: LOGIN_METHOD, body, headers });
  const text = await res.text();
  log("Login status:", res.status, res.headers.get("content-type") || "n/a");

  let token = null;
  try { const j = JSON.parse(text); token = j?.token || j?.accessToken || j?.data?.accessToken || null; } catch {}

  if (!res.ok) {
    throw new Error(`Login failed: ${res.status} ${res.statusText} :: ${text.slice(0,300)}`);
  }

  return { token };
}

// ---------- MESSAGES ----------
function normalizeToArray(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  const candidates = [
    data.messages, data.thread, data.items, data.results,
    data.data?.messages, data.data?.items,
    data.conversation?.messages,
    data.conversations?.[0]?.messages
  ].filter(Boolean);
  for (const c of candidates) if (Array.isArray(c)) return c;
  if (typeof data === "object") {
    const vals = Object.values(data);
    if (vals.length && vals.every(v => typeof v === "object")) return vals;
  }
  return [];
}

function tsOf(msg) {
  const fields = ["sent_at","sentAt","created_at","createdAt","timestamp","ts","time","date","updatedAt"];
  for (const f of fields) {
    const v = msg?.[f];
    if (v == null) continue;
    if (typeof v === "number") return v < 2_000_000_000 ? v * 1000 : v;
    const d = new Date(v);
    if (!isNaN(d)) return d.getTime();
  }
  return NaN;
}

function isNote(msg) {
  const t = (msg?.type || msg?.msg_type || msg?.module || "").toString().toLowerCase();
  if (t.includes("note")) return true;
  if (msg?.internal === true) return true;
  return false;
}

function senderKind(msg) {
  if (msg?.generated_by_ai === true || ["ai","llm","assistant"].includes(String(msg?.source||"").toLowerCase())) return "ai";

  const dir = (msg?.direction || "").toString().toLowerCase();
  if (dir === "inbound") return "guest";
  if (dir === "outbound") return "agent";

  const by = (msg?.by || msg?.senderType || msg?.sender_type || "").toString().toLowerCase();
  if (["guest","customer","user","client"].includes(by)) return "guest";
  if (["agent","staff","admin","operator","owner"].includes(by)) return "agent";

  const role = (msg?.author?.role || msg?.sender?.role || "").toString().toLowerCase();
  if (["agent","staff","admin","operator","owner"].includes(role)) return "agent";
  if (["guest","customer","user","client"].includes(role)) return "guest";

  const name = (msg?.author?.name || msg?.sender?.name || msg?.name || "").toString().toLowerCase();
  if (name.includes("bot")) return "ai";

  return "unknown";
}

function aiCountsAsAgent(msg) {
  if (!COUNT_AI_AS_AGENT) return false;
  if (senderKind(msg) !== "ai") return false;
  const status = (msg?.ai_status || msg?.status || "").toString().toLowerCase();
  return ["approved","sent","delivered"].includes(status);
}

function buildMessagesUrl(conversationId) {
  if (!MESSAGES_URL) throw new Error("MESSAGES_URL is not set");
  if (MESSAGES_URL.includes("{{conversationId}}")) {
    return MESSAGES_URL.replace("{{conversationId}}", conversationId);
  }
  const sep = MESSAGES_URL.includes("?") ? "&" : "?";
  return `${MESSAGES_URL}${sep}conversationId=${encodeURIComponent(conversationId)}`;
}

async function fetchMessages({ conversationId, token }) {
  const url = buildMessagesUrl(conversationId);

  // Base headers
  const headers = { accept: "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  if (CSRF_HEADER_NAME && CSRF_COOKIE_NAME) {
    const csrfVal = jar.get(CSRF_COOKIE_NAME);
    if (csrfVal) headers[CSRF_HEADER_NAME] = csrfVal;
  }
  // Optional extra headers from JSON
  if (MESSAGES_HEADERS_JSON) {
    try {
      const extra = JSON.parse(MESSAGES_HEADERS_JSON);
      Object.assign(headers, extra);
    } catch {
      log("Invalid MESSAGES_HEADERS_JSON, ignoring.");
    }
  }

  log("Fetching messages:", url, MESSAGES_METHOD);
  const res = await fetchWithCookies(url, { method: MESSAGES_METHOD, headers });
  const ctype = res.headers.get("content-type") || "";
  const status = res.status;
  const text = await res.text();

  log("Messages status:", status, "ctype:", ctype);

  if (status === 204 || text.trim() === "") {
    log("Empty body/204 — treating as no messages.");
    return [];
  }
  if (!res.ok) {
    const snippet = text.slice(0, 500);
    throw new Error(`Messages fetch failed: ${status} ${res.statusText} :: ${snippet}`);
  }

  // Try to parse JSON robustly
  let data;
  if (/json/i.test(ctype)) {
    try { data = JSON.parse(text); }
    catch (e) { throw new Error(`Messages not JSON (parse error): ${e.message} :: ${text.slice(0,200)}`); }
  } else {
    // Some backends return text/html with JSON — attempt recovery
    const trimmed = text.trim();
    // NDJSON support
    if (trimmed.includes("\n") && trimmed.split("\n").every(line => line.trim() === "" || line.trim().startsWith("{") || line.trim().startsWith("["))) {
      try {
        const lines = trimmed.split("\n").filter(Boolean).map(JSON.parse);
        data = lines.length === 1 ? lines[0] : lines;
      } catch {
        // fallthrough to bracket slicing
      }
    }
    if (!data) {
      const start = trimmed.indexOf("{");
      const end = trimmed.lastIndexOf("}");
      if (start !== -1 && end !== -1 && end > start) {
        try { data = JSON.parse(trimmed.slice(start, end + 1)); } catch {}
      }
    }
    if (!data) {
      throw new Error(`Messages not JSON: content-type=${ctype} :: ${trimmed.slice(0, 200)}`);
    }
  }

  const arr = normalizeToArray(data);
  log(`Fetched messages: ${arr.length}`);
  return arr;
}

// ---------- SLA ----------
function evaluateSLA(messages) {
  const usable = messages
    .filter(m => !isNote(m))
    .map(m => ({ raw: m, ts: tsOf(m), kind: senderKind(m) }))
    .filter(m => Number.isFinite(m.ts))
    .sort((a,b) => a.ts - b.ts);

  if (!usable.length) return { ok: true, reason: "no_messages" };

  const last = usable[usable.length - 1];
  const now = Date.now();

  const isAgentLike = (m) => m.kind === "agent" || aiCountsAsAgent(m.raw);
  const agents = usable.filter(isAgentLike);
  const lastAgent = agents[agents.length - 1] || null;

  if (last.kind !== "guest") {
    return { ok: true, reason: "last_not_guest", lastTs: last.ts, lastKind: last.kind };
  }

  const minutesSinceAgent = lastAgent ? (now - lastAgent.ts) / 60000 : Infinity;

  if (minutesSinceAgent >= SLA_MINUTES) {
    return { ok: false, reason: "guest_unanswered", lastGuestTs: last.ts, lastAgentTs: lastAgent?.ts || null, minutesSinceAgent };
  }
  return { ok: true, reason: "within_sla", lastGuestTs: last.ts, lastAgentTs: lastAgent?.ts || null, minutesSinceAgent };
}

// ---------- EMAIL ----------
async function sendEmail({ subject, text, html }) {
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  await transporter.sendMail({
    from: { name: ALERT_FROM_NAME, address: SMTP_USER },
    to: ALERT_TO,
    subject,
    text,
    html
  });
}

// ---------- MAIN ----------
(async () => {
  const input = CONVERSATION_INPUT || DEFAULT_CONVERSATION_ID;
  if (!input) throw new Error("Provide conversation input or set DEFAULT_CONVERSATION_ID.");
  const conversationId = extractConversationId(input);
  if (!conversationId) throw new Error(`Could not extract conversation id from: ${input}`);

  const conversationLink = buildConversationLink({
    input,
    id: conversationId,
    uiTemplate: UI_URL_TEMPLATE,
    messagesTemplate: MESSAGES_URL
  });

  log("Conversation ID:", conversationId);
  log("Conversation link:", conversationLink);

  const { token } = await loginIfNeeded();
  const messages = await fetchMessages({ conversationId, token });
  const result = evaluateSLA(messages);
  log("Result:", result);

  if (!result.ok && result.reason === "guest_unanswered") {
    const lastGuestTs = result.lastGuestTs ? new Date(result.lastGuestTs).toISOString() : "n/a";
    const lastAgentTs = result.lastAgentTs ? new Date(result.lastAgentTs).toISOString() : "none";
    const minutesStr = Number.isFinite(result.minutesSinceAgent) ? result.minutesSinceAgent.toFixed(1) : "∞";

    const subject = `SLA breach: guest waiting ≥ ${SLA_MINUTES}m (${conversationId})`;
    const textBody = [
      `SLA breach detected.`,
      `Conversation: ${conversationLink}`,
      `Last guest message at: ${lastGuestTs}`,
      `Last agent message at: ${lastAgentTs}`,
      `Minutes since agent: ${minutesStr}`
    ].join("\n");
    const htmlBody = `
      <p><strong>SLA breach detected.</strong></p>
      <p><strong>Conversation:</strong> <a href="${conversationLink}">${conversationLink}</a></p>
      <p>Last guest message at: ${lastGuestTs}</p>
      <p>Last agent message at: ${lastAgentTs}</p>
      <p>Minutes since agent: ${minutesStr}</p>
    `;
    await sendEmail({ subject, text: textBody, html: htmlBody });
    console.log("✅ Alert email sent.");
  } else {
    console.log(`No alert sent. Reason: ${result.reason}`);
  }
})().catch(err => {
  console.error("❌ Error:", err?.stack || err?.message || err);
  process.exit(1);
});
