// check.mjs — Boom SLA alerts via REST API (accepts UI URL / API URL / UUID)
// Alert when the last message is from a GUEST and no AGENT reply in >= SLA_MINUTES.
// Ignores notes and AI suggestions unless configured to count approved/sent AI as agent.

import nodemailer from "nodemailer";

// ---------- ENV ----------
const env = (k, d = "") => (process.env[k] ?? d).toString().trim();

const BOOM_USER  = env("BOOM_USER");
const BOOM_PASS  = env("BOOM_PASS");

const LOGIN_URL             = env("LOGIN_URL");
const LOGIN_METHOD          = env("LOGIN_METHOD", "POST");
const LOGIN_CT              = env("LOGIN_CT", "application/json"); // or application/x-www-form-urlencoded
const LOGIN_EMAIL_FIELD     = env("LOGIN_EMAIL_FIELD", "email");
const LOGIN_PASSWORD_FIELD  = env("LOGIN_PASSWORD_FIELD", "password");
const LOGIN_TENANT_FIELD    = env("LOGIN_TENANT_FIELD", "");       // optional

const CSRF_HEADER_NAME      = env("CSRF_HEADER_NAME", "");
const CSRF_COOKIE_NAME      = env("CSRF_COOKIE_NAME", "");

const MESSAGES_URL          = env("MESSAGES_URL");                 // must include {{conversationId}}
const MESSAGES_METHOD       = env("MESSAGES_METHOD", "GET");

const SLA_MINUTES           = parseFloat(env("SLA_MINUTES", "5"));
const COUNT_AI_AS_AGENT     = /^true$/i.test(env("COUNT_AI_SUGGESTION_AS_AGENT", "false"));

const SMTP_HOST  = env("SMTP_HOST");
const SMTP_PORT  = parseInt(env("SMTP_PORT", "587"), 10);
const SMTP_USER  = env("SMTP_USER");
const SMTP_PASS  = env("SMTP_PASS");
const ALERT_TO   = env("ALERT_TO");
const ALERT_FROM_NAME = env("ALERT_FROM_NAME", "Boom SLA Bot");

const UI_URL_TEMPLATE       = env("UI_URL_TEMPLATE", "");          // e.g., https://app.boomnow.com/dashboard/guest/{{conversationId}}

const DEFAULT_CONVERSATION_ID = env("DEFAULT_CONVERSATION_ID", "");
const CONVERSATION_INPUT      = env("CONVERSATION_INPUT", "");
const DEBUG = env("DEBUG", "");

// ---------- UTILS ----------
const log = (...a) => { if (DEBUG) console.log("[DEBUG]", ...a); };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
    // Try UUID anywhere in path/query:
    const pathUuid = findUuid(u.pathname);
    if (pathUuid) return pathUuid;
    const qUuid = findUuid(u.search);
    if (qUuid) return qUuid;
    // Fallback to last path segment if it looks like an id:
    const seg = u.pathname.split("/").filter(Boolean).pop() || "";
    if (isUuid(seg)) return seg;
    if (seg) return seg; // last resort (some APIs use non-UUID ids)
  } catch {
    // not a URL
    if (isUuid(input)) return input;
    // fallback: raw string
    if (input) return input;
  }
  return "";
}

function buildConversationLink({ input, id, uiTemplate, messagesTemplate }) {
  // If input is a URL, prefer it
  try {
    const u = new URL(input || "");
    if (u.protocol === "http:" || u.protocol === "https:") return u.href;
  } catch { /* ignore */ }

  if (uiTemplate && uiTemplate.includes("{{conversationId}}")) {
    return uiTemplate.replace("{{conversationId}}", id);
  }
  if (messagesTemplate && messagesTemplate.includes("{{conversationId}}")) {
    return messagesTemplate.replace("{{conversationId}}", id);
  }
  return id; // last resort
}

// Parse multiple Set-Cookie headers merged by undici using commas
function splitSetCookie(headerValue) {
  if (!headerValue) return [];
  // Split on commas that are followed by a cookie-name token
  return headerValue.match(/(?:[^,]|,(?=\s*[^;\s=]+=[^,;]+))/g) || [];
}

class CookieJar {
  constructor() { this.map = new Map(); }
  eatFrom(response) {
    const raw = response.headers.get("set-cookie");
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
    return Array.from(this.map.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
  }
  get(name) { return this.map.get(name) || ""; }
}
const jar = new CookieJar();

async function fetchWithCookies(url, opts = {}) {
  const headers = new Headers(opts.headers || {});
  const cookie = jar.header();
  if (cookie) headers.set("cookie", cookie);
  const res = await fetch(url, { ...opts, headers });
  jar.eatFrom(res);
  return res;
}

// ---------- AUTH ----------
async function loginIfNeeded() {
  if (!LOGIN_URL) {
    log("No LOGIN_URL provided; skipping login.");
    return { token: null };
  }

  const payload = {};
  if (LOGIN_EMAIL_FIELD)   payload[LOGIN_EMAIL_FIELD] = BOOM_USER;
  if (LOGIN_PASSWORD_FIELD) payload[LOGIN_PASSWORD_FIELD] = BOOM_PASS;
  if (LOGIN_TENANT_FIELD)  payload[LOGIN_TENANT_FIELD] = env("BOOM_TENANT", "");

  let body, headers = {};
  if (/json/i.test(LOGIN_CT)) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(payload);
  } else {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(payload).toString();
  }

  log("Logging in to", LOGIN_URL, "method:", LOGIN_METHOD, "ct:", LOGIN_CT);
  const res = await fetchWithCookies(LOGIN_URL, { method: LOGIN_METHOD, body, headers });
  const text = await res.text();
  let token = null;

  try {
    const j = JSON.parse(text);
    token = j?.token || j?.accessToken || j?.data?.accessToken || null;
  } catch {
    // Not JSON or token not present; cookies may be enough
  }

  if (!res.ok) {
    throw new Error(`Login failed: ${res.status} ${res.statusText} :: ${text.slice(0, 500)}`);
  }

  log("Login ok. Token?", !!token, "Cookies:", jar.map.size);
  return { token };
}

// ---------- MESSAGES ----------
function normalizeToArray(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;

  // Common containers
  const candidates = [
    data.messages,
    data.thread,
    data.items,
    data.results,
    data.data?.messages,
    data.data?.items,
    data.conversation?.messages,
    data.conversations?.[0]?.messages
  ].filter(Boolean);

  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  // Could be an object keyed by id
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
    if (typeof v === "number") {
      // seconds vs ms heuristic
      if (v < 2_000_000_000) return v * 1000;
      return v;
    }
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
  // AI?
  if (msg?.generated_by_ai === true || ["ai","llm","assistant"].includes(String(msg?.source || "").toLowerCase())) {
    return "ai";
  }

  // direction inbound/outbound
  const dir = (msg?.direction || "").toString().toLowerCase();
  if (dir === "inbound") return "guest";
  if (dir === "outbound") return "agent";

  // explicit roles
  const by = (msg?.by || msg?.senderType || msg?.sender_type || "").toString().toLowerCase();
  if (["guest","customer","user","client"].includes(by)) return "guest";
  if (["agent","staff","admin","operator","owner"].includes(by)) return "agent";

  const role = (msg?.author?.role || msg?.sender?.role || "").toString().toLowerCase();
  if (["agent","staff","admin","operator","owner"].includes(role)) return "agent";
  if (["guest","customer","user","client"].includes(role)) return "guest";

  // name hint
  const name = (msg?.author?.name || msg?.sender?.name || msg?.name || "").toString().toLowerCase();
  if (name.includes("bot")) return "ai";

  // fallback
  return "unknown";
}

function aiCountsAsAgent(msg) {
  if (!COUNT_AI_AS_AGENT) return false;
  if (senderKind(msg) !== "ai") return false;
  const status = (msg?.ai_status || msg?.status || "").toString().toLowerCase();
  // Treat only approved/sent/delivered AI as an agent response
  return ["approved","sent","delivered"].includes(status);
}

async function fetchMessages({ conversationId, token }) {
  if (!MESSAGES_URL || !MESSAGES_URL.includes("{{conversationId}}")) {
    throw new Error("MESSAGES_URL repo var must contain {{conversationId}}");
  }
  const url = MESSAGES_URL.replace("{{conversationId}}", conversationId);
  const headers = { "accept": "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  if (CSRF_HEADER_NAME && CSRF_COOKIE_NAME) {
    const csrfVal = jar.get(CSRF_COOKIE_NAME);
    if (csrfVal) headers[CSRF_HEADER_NAME] = csrfVal;
  }

  const res = await fetchWithCookies(url, { method: MESSAGES_METHOD, headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`Messages fetch failed: ${res.status} ${res.statusText} :: ${text.slice(0,500)}`);
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`Messages not JSON: ${text.slice(0,200)}`); }
  const arr = normalizeToArray(data);
  log(`Fetched messages: ${arr.length}`);
  return arr;
}

// ---------- SLA DECISION ----------
function evaluateSLA(messages) {
  // Remove notes, map usable messages with timestamp + sender
  const usable = messages
    .filter(m => !isNote(m))
    .map(m => ({ raw: m, ts: tsOf(m), kind: senderKind(m) }))
    .filter(m => Number.isFinite(m.ts))
    .sort((a,b) => a.ts - b.ts);

  if (!usable.length) {
    return { ok: true, reason: "no_messages" };
  }

  const last = usable[usable.length - 1];
  const now = Date.now();

  // Collect all agent-equivalent messages
  const isAgentLike = (m) => m.kind === "agent" || aiCountsAsAgent(m.raw);

  const agents = usable.filter(isAgentLike);
  const lastAgent = agents[agents.length - 1] || null;

  // If last is not guest -> no alert
  if (last.kind !== "guest") {
    return { ok: true, reason: "last_not_guest", lastTs: last.ts, lastKind: last.kind };
  }

  // If no agent ever, consider it an immediate breach (∞ minutes since agent)
  const minutesSinceAgent = lastAgent ? (now - lastAgent.ts) / 60000 : Infinity;

  if (minutesSinceAgent >= SLA_MINUTES) {
    return {
      ok: false,
      reason: "guest_unanswered",
      lastGuestTs: last.ts,
      lastAgentTs: lastAgent ? lastAgent.ts : null,
      minutesSinceAgent
    };
  }

  return {
    ok: true,
    reason: "within_sla",
    lastGuestTs: last.ts,
    lastAgentTs: lastAgent ? lastAgent.ts : null,
    minutesSinceAgent
  };
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
  // Resolve conversation input/id
  const input = CONVERSATION_INPUT || DEFAULT_CONVERSATION_ID;
  if (!input) {
    throw new Error("No CONVERSATION_INPUT (workflow input) and no DEFAULT_CONVERSATION_ID repo var provided.");
  }
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

  // 1) Login (if configured)
  const { token } = await loginIfNeeded();

  // 2) Fetch messages
  const messages = await fetchMessages({ conversationId, token });

  // 3) Evaluate SLA
  const result = evaluateSLA(messages);
  log("Result:", result);

  // 4) Maybe alert
  if (!result.ok && result.reason === "guest_unanswered") {
    const lastGuestTs = result.lastGuestTs ? new Date(result.lastGuestTs).toISOString() : "n/a";
    const lastAgentTs = result.lastAgentTs ? new Date(result.lastAgentTs).toISOString() : "none";
    const minutesStr = Number.isFinite(result.minutesSinceAgent)
      ? result.minutesSinceAgent.toFixed(1)
      : "∞";

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
