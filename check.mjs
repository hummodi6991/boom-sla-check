// check.mjs
import nodemailer from "nodemailer";
import fs from "fs";

const env = (k, d="") => (process.env[k] ?? d).toString().trim();

// --- Secrets (from GitHub) ---
const BOOM_USER  = env("BOOM_USER");
const BOOM_PASS  = env("BOOM_PASS");
const SMTP_HOST  = env("SMTP_HOST");
const SMTP_PORT  = parseInt(env("SMTP_PORT","587"),10);
const SMTP_USER  = env("SMTP_USER");
const SMTP_PASS  = env("SMTP_PASS");
const ALERT_TO   = env("ALERT_TO");
const FROM_NAME  = env("ALERT_FROM_NAME","Boom SLA Bot");

// --- App mechanics ---
const LOGIN_URL            = env("LOGIN_URL");
const LOGIN_METHOD         = env("LOGIN_METHOD","POST");
const LOGIN_CT             = env("LOGIN_CT","application/json");
const LOGIN_EMAIL_FIELD    = env("LOGIN_EMAIL_FIELD","email");
const LOGIN_PASSWORD_FIELD = env("LOGIN_PASSWORD_FIELD","password");
const LOGIN_TENANT_FIELD   = env("LOGIN_TENANT_FIELD","");  // optional
const CSRF_HEADER_NAME     = env("CSRF_HEADER_NAME","");
const CSRF_COOKIE_NAME     = env("CSRF_COOKIE_NAME","");

const API_KIND             = env("API_KIND","rest");
const MESSAGES_URL_TMPL    = env("MESSAGES_URL"); // e.g. https://app.boomnow.com/api/guest-experience/conversations/{{conversationId}}/messages
const MESSAGES_METHOD      = env("MESSAGES_METHOD","GET");

const SLA_MINUTES          = parseInt(env("SLA_MINUTES","5"),10);
const COUNT_AI_AS_AGENT    = env("COUNT_AI_SUGGESTION_AS_AGENT","false").toLowerCase()==="true";

// --- Inputs / defaults ---
let CONVERSATION_INPUT = env("CONVERSATION_INPUT","");
if (!CONVERSATION_INPUT) {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventName === "repository_dispatch" && eventPath && fs.existsSync(eventPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(eventPath, "utf8"));
      const p = data.client_payload || {};
      const candidates = [
        p.conversation, p.conversationUrl, p.conversation_url,
        p.url, p.text, p.body
      ].filter(v => typeof v === "string" && v.trim());
      if (candidates.length) {
        CONVERSATION_INPUT = candidates[0].trim();
        process.env.CONVERSATION_INPUT = CONVERSATION_INPUT;
      }
    } catch {}
  }
}
const DEFAULT_CONVO_ID = env("DEFAULT_CONVERSATION_ID","");

// === Utils ===
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

function firstUrlLike(s) {
  const m = String(s||"").match(/https?:\/\/\S+/);
  if (!m) return "";
  return m[0].replace(/[>),.;!]+$/, "");
}

// --- unwrap tracking links (e.g. Mailjet) that hide a real URL in base64 ---
function tryB64Decode(raw) {
  try {
    let t = raw;
    t = t.replace(/-/g, "+").replace(/_/g, "/"); // URL-safe -> standard
    const pad = t.length % 4;
    if (pad) t = t + "=".repeat(4 - pad);
    const out = Buffer.from(t, "base64").toString("utf8").trim();
    return out;
  } catch { return ""; }
}

function expandTrackedUrl(urlStr) {
  if (!urlStr) return "";
  let out = urlStr;

  try {
    const u = new URL(urlStr);

    // 1) Try base64-ish path segments
    const segs = u.pathname.split("/").filter(Boolean);
    for (let i = segs.length - 1; i >= 0; i--) {
      const seg = decodeURIComponent(segs[i]);
      if (/^[A-Za-z0-9+/_=-]{16,}$/.test(seg)) {
        const dec = tryB64Decode(seg);
        if (/^https?:\/\//i.test(dec)) return dec;
      }
    }

    // 2) Query params containing URL or base64 URL
    for (const [, v] of u.searchParams.entries()) {
      const val = decodeURIComponent(v);
      if (/^https?:\/\//i.test(val)) return val;
      if (/^[A-Za-z0-9+/_=-]{16,}$/.test(val)) {
        const dec = tryB64Decode(val);
        if (/^https?:\/\//i.test(dec)) return dec;
      }
    }
  } catch {}
  return out;
}

// Pull a UUID from any acceptable input
function extractConversationId(input) {
  const s = (input || "").trim();
  if (!s) return "";

  // exact UUID in the whole string
  const direct = s.match(UUID_RE);
  if (direct && direct[0] && s.length === direct[0].length) return direct[0];

  // examine a URL (unwrap trackers first)
  const rawUrl = firstUrlLike(s);
  const urlStr = expandTrackedUrl(rawUrl);
  if (urlStr) {
    try {
      const u = new URL(urlStr);
      const parts = u.pathname.split("/").filter(Boolean);
      const fromPath = parts.find(x => UUID_RE.test(x));
      if (fromPath) return fromPath.match(UUID_RE)[0];
      for (const [, v] of u.searchParams.entries()) {
        const m = String(v).match(UUID_RE);
        if (m) return m[0];
      }
    } catch {}
  }

  // /api/conversations/<uuid>
  const fromApi = s.match(/\/api\/conversations\/([0-9a-f-]{36})/i);
  if (fromApi) return fromApi[1];

  // last resort
  return direct ? direct[0] : "";
}

// Build a human UI link for the email body (clean, untracked)
function buildConversationLink() {
  const input = (CONVERSATION_INPUT || "").trim();
  const id = extractConversationId(input) || DEFAULT_CONVO_ID || "";

  if (/^https?:\/\//i.test(input)) {
    try {
      const expanded = expandTrackedUrl(firstUrlLike(input));
      const u = new URL(expanded);
      const parts = u.pathname.split("/").filter(Boolean);
      const uuidIndex = parts.findIndex(p => UUID_RE.test(p));
      if (uuidIndex >= 0) {
        const slice = parts.slice(0, uuidIndex + 1).filter((p,i)=>!(i===0 && p.toLowerCase()==="api"));
        u.pathname = "/" + slice.join("/");
        u.search = "";
        u.hash = "";
        return u.toString();
      }
      return u.toString();
    } catch {}
  }

  if (id && MESSAGES_URL_TMPL) {
    try {
      const urlStr = MESSAGES_URL_TMPL.replace(/{{conversationId}}/g, id);
      const u = new URL(urlStr);
      const parts = u.pathname.split("/").filter(Boolean);
      const uuidIndex = parts.findIndex(p => UUID_RE.test(p));
      if (uuidIndex >= 0) {
        const slice = parts.slice(0, uuidIndex + 1).filter((p,i)=>!(i===0 && p.toLowerCase()==="api"));
        u.pathname = "/" + slice.join("/");
        u.search = "";
        u.hash = "";
        return u.toString();
      }
      return u.origin;
    } catch {}
  }
  return id ? id.toString() : "";
}

// --- tiny cookie jar & fetch helper ---
class Jar {
  constructor(){ this.map = new Map(); }
  ingest(setCookie) {
    if(!setCookie) return;
    const lines = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const ln of lines) {
      const m = String(ln).match(/^([^=]+)=([^;]+)/);
      if (m) this.map.set(m[1].trim(), m[2]);
    }
  }
  get(name){ return this.map.get(name) || ""; }
  header(){ return [...this.map.entries()].map(([k,v])=>`${k}=${v}`).join("; "); }
}
const jar = new Jar();

async function jf(url, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("accept", "application/json, text/plain, */*");
  const ck = jar.header();
  if (ck) headers.set("cookie", ck);

  if (CSRF_HEADER_NAME && CSRF_COOKIE_NAME && !headers.has(CSRF_HEADER_NAME)) {
    const val = jar.get(CSRF_COOKIE_NAME);
    if (val) headers.set(CSRF_HEADER_NAME, decodeURIComponent(val));
  }

  const res = await fetch(url, { ...init, headers, redirect: "manual" });
  const setc = res.headers.get("set-cookie");
  if (setc) jar.ingest(setc);

  // follow redirects (limited)
  let r = res, hops=0;
  while ([301,302,303,307,308].includes(r.status) && hops<3) {
    const loc = r.headers.get("location");
    if (!loc) break;
    r = await fetch(new URL(loc, url), { headers, redirect: "manual" });
    const setc2 = r.headers.get("set-cookie");
    if (setc2) jar.ingest(setc2);
    hops++;
  }
  return r;
}

function formEncode(obj) {
  return Object.entries(obj).map(([k,v]) =>
    `${encodeURIComponent(k)}=${encodeURIComponent(v ?? "")}`).join("&");
}

async function login() {
  if (!LOGIN_URL || !BOOM_USER || !BOOM_PASS) {
    throw new Error("LOGIN_URL or BOOM_USER/BOOM_PASS missing");
  }
  const bodyObj = {
    [LOGIN_EMAIL_FIELD]: BOOM_USER,
    [LOGIN_PASSWORD_FIELD]: BOOM_PASS,
  };
  if (LOGIN_TENANT_FIELD) bodyObj[LOGIN_TENANT_FIELD] = null;

  const headers = {};
  let body;
  if (LOGIN_CT.includes("json")) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(bodyObj);
  } else {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = formEncode(bodyObj);
  }

  const res = await jf(LOGIN_URL, { method: LOGIN_METHOD, headers, body });
  if (res.status >= 400) throw new Error(`Login failed: ${res.status}`);

  let token = null;
  try {
    const j = await res.clone().json();
    token = j?.token || j?.accessToken || j?.data?.accessToken || null;
  } catch {}
  return token;
}

// --- normalize messages from various shapes ---
function normalizeMessages(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.messages)) return data.messages;
  if (Array.isArray(data?.thread))   return data.thread;
  if (Array.isArray(data?.items))    return data.items;
  if (Array.isArray(data?.conversation?.messages)) return data.conversation.messages;
  if (Array.isArray(data?.data?.conversation?.messages)) return data.data.conversation.messages;

  // Fallback search
  const candidates = [];
  (function crawl(v){
    if (v == null) return;
    if (Array.isArray(v)) {
      // prefer arrays of objects, but accept primitives if nothing else is found
      if (v.some(x => x && typeof x === "object")) candidates.push(v);
      return;
    }
    if (typeof v === "object") {
      for (const k of Object.keys(v)) crawl(v[k]);
    }
  })(data);

  if (candidates.length) return candidates[0];
  return [];
}

// --- robust role detection (handles numeric-only messages) ---
function whoSent(m) {
  if (!m || typeof m !== "object") return "guest";

  const str = (x) => String(x ?? "").toLowerCase();

  // treat explicit notes as internal
  const moduleVal = str(m.module);
  const msgType   = str(m.msg_type || m.message_type);
  if (moduleVal === "note" || msgType === "note") return "internal";

  // compile role-ish hints
  const roles = [
    m.role, m.by, m.senderType, m.sender_type,
    m.author?.role, m.author_role,
    m.from_role, m.fromType, m.from_type,
    m.user_role, m.owner_type, m.type
  ].map(str);

  if (roles.some(r => /(agent|host|staff|operator|admin|support|team)/.test(r))) return "agent";
  if (roles.some(r => /(guest|customer|visitor|client|user)/.test(r))) return "guest";

  // direction hints
  const dir = str(m.direction || m.message_direction || m.dir);
  if (/(outbound|out|sent)/.test(dir)) return "agent";
  if (/(inbound|in)/.test(dir)) return "guest";

  // boolean/id hints
  const agentish = [
    m.is_agent, m.is_staff, m.from_agent, m.sent_by_agent, m.approved_by_agent,
    m.agent_id, m.staff_id, m.operator_id, m.assignee, m.assigned_to
  ].some(Boolean);
  if (agentish) return "agent";

  const guestish = [m.is_guest, m.from_guest, m.guest_id, m.customer_id && !m.agent_id].some(Boolean);
  if (guestish) return "guest";

  // AI messages: approved/sent counts as agent; otherwise depends on COUNT_AI_SUGGESTION_AS_AGENT
  const aiStatus = str(m.ai_status || m.aiStatus || m.status);
  const isAI = !!(m.generated_by_ai || m.ai || m.is_ai);
  if (isAI) {
    if (["approved","sent","delivered","published"].includes(aiStatus)) return "agent";
    return COUNT_AI_AS_AGENT ? "agent" : "ai";
  }

  // default conservative
  return "guest";
}

// --- parse timestamps from many shapes (string or ms) ---
function tsOf(m) {
  const cand = [
    m.sent_at, m.createdAt, m.created_at, m.updatedAt, m.updated_at,
    m.date, m.datetime, m.timestamp, m.timestamp_ms, m.ts, m.time
  ].find(v => v !== undefined && v !== null);

  if (cand === undefined || cand === null) return null;

  // number-like? treat as ms if large, else seconds
  if (typeof cand === "number") {
    const ms = cand > 1e12 ? cand : cand * 1000;
    const d = new Date(ms);
    return isNaN(+d) ? null : d;
  }

  // string: try Date parsing
  const d = new Date(String(cand));
  return isNaN(+d) ? null : d;
}

function evaluate(messages, now = new Date(), slaMin = SLA_MINUTES) {
  const list = (messages || [])
    .filter(Boolean)
    .filter(m => {
      const moduleVal = String(m?.module ?? "").toLowerCase();
      const msgType   = String(m?.msg_type ?? m?.message_type ?? "").toLowerCase();
      return moduleVal !== "note" && msgType !== "note";
    })
    .map(x => ({...x, _ts: tsOf(x)}));

  if (!list.length) return { ok: true, reason: "empty" };
  list.sort((a,b) => (a._ts?.getTime?.()||0) - (b._ts?.getTime?.()||0));
  const last = list[list.length-1];
  const lastSender = whoSent(last);

  let lastAgent = null;
  for (let i=list.length-1; i>=0; i--) {
    const role = whoSent(list[i]);
    if (role === "agent") { lastAgent = list[i]; break; }
    if (role === "ai" && COUNT_AI_AS_AGENT) { lastAgent = list[i]; break; }
  }

  const minsSinceAgent = lastAgent? Math.round((now - (lastAgent._ts || now))/60000) : null;

  if (lastSender === "guest" && (lastAgent === null || minsSinceAgent === null || minsSinceAgent >= slaMin)) {
    return { ok: false, reason: "guest_unanswered", minsSinceAgent };
  }
  return { ok: true, reason: "no_breach" };
}

async function sendEmail(subject, html) {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !ALERT_TO) {
    console.log("Alert needed, but SMTP/env not fully set.");
    return;
  }
  const tr = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  await tr.sendMail({ from: `"${FROM_NAME}" <${SMTP_USER}>`, to: ALERT_TO, subject, html });
}

(async () => {
  // 1) Login
  const token = await login();

  // 2) Build messages URL from UI URL / API URL / UUID / default
  const id = extractConversationId(CONVERSATION_INPUT) || DEFAULT_CONVO_ID;
  if (!id) throw new Error("No conversationId available. Provide an input (UI URL / API URL / UUID) or set DEFAULT_CONVERSATION_ID repo variable.");
  if (!MESSAGES_URL_TMPL) throw new Error("MESSAGES_URL not set");

  const headers = token ? { authorization: `Bearer ${token}` } : {};

  // ---- 404 FALLBACK BLOCK (tries multiple Boom API shapes) ----
  async function fetchMessagesWithFallback(convId) {
    const tried = [];
    const primary = MESSAGES_URL_TMPL.replace(/{{conversationId}}/g, convId);

    const attempt = async (url) => {
      tried.push(url);
      console.log(`[SLA] Trying messages URL: ${url}`);
      const res = await jf(url, { method: MESSAGES_METHOD, headers });
      if (res.status === 404) return null; // try next candidate
      if (res.status >= 400) {
        const body = await res.text().catch(() => "");
        throw new Error(`Messages fetch failed: ${res.status} ${body.slice(0,200)}`);
      }
      return res;
    };

    // 1) primary from env
    let res = await attempt(primary);
    if (res) return res;

    // 2) derive origin and try common shapes
    const base = new URL(primary);
    const origin = base.origin;

    const candidates = [
      `${origin}/api/conversations/${convId}/messages`,
      `${origin}/api/guest-experience/conversations/${convId}/messages`,
      `${origin}/api/guest-experience/messages?conversationId=${convId}`,
      `${origin}/api/messages?conversationId=${convId}`,
    ];

    for (const u of candidates) {
      res = await attempt(u);
      if (res) return res;
    }

    throw new Error(`Messages fetch failed: 404. Tried:\n- ${tried.join("\n- ")}`);
  }

  const res = await fetchMessagesWithFallback(id);

  // 3) Parse and evaluate
  const data = await res.json();
  const msgs = normalizeMessages(data);
  const result = evaluate(msgs);
  console.log("Second check result:", JSON.stringify(result, null, 2));

  // 4) Alert if needed
  if (!result.ok && result.reason === "guest_unanswered") {
    const subj = `⚠️ Boom SLA: guest unanswered ≥ ${SLA_MINUTES}m`;
    const convoLink = buildConversationLink();
    const esc = (s) => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const linkHtml = convoLink ? `<p>Conversation: <a href="${esc(convoLink)}">${esc(convoLink)}</a></p>` : "";
    const bodyHtml = `<p>Guest appears unanswered ≥ ${SLA_MINUTES} minutes.</p>${linkHtml}`;
    await sendEmail(subj, bodyHtml);
    console.log("✅ Alert email sent.");
  } else {
    console.log("No alert sent.");
  }
})().catch(e => {
  console.error(e);
  process.exit(1);
});
