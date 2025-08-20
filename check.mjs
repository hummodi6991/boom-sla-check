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
const MESSAGES_URL_TMPL    = env("MESSAGES_URL");
const MESSAGES_METHOD      = env("MESSAGES_METHOD","GET");

const SLA_MINUTES          = parseInt(env("SLA_MINUTES","5"),10);
const COUNT_AI_AS_AGENT    = env("COUNT_AI_SUGGESTION_AS_AGENT","false").toLowerCase()==="true";

// --- Inputs / defaults ---
// Prefer env; if missing and this is a repository_dispatch run, parse the GitHub event JSON.
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

/**
 * Attempt to decode a string that may be Base64 encoded. Many email
 * tracking links include the destination URL as the final path segment
 * using URLÃÂ¢ÃÂÃÂsafe Base64 encoding. This helper normalises the input and
 * pads it to a multiple of 4 before decoding. If the decoded string
 * contains nonÃÂ¢ÃÂÃÂprintable characters or cannot be decoded it returns
 * null.
 *
 * @param {string} str The candidate string to decode
 * @returns {string|null} Decoded UTFÃÂ¢ÃÂÃÂ8 string or null if decoding fails
 */
function tryDecode(str) {
  if (!str || typeof str !== "string") return null;
  // Replace URLÃÂ¢ÃÂÃÂsafe characters
  let s = str.replace(/-/g, "+").replace(/_/g, "/");
  // Pad to length divisible by 4
  const pad = s.length % 4;
  if (pad === 2) s += "==";
  else if (pad === 3) s += "=";
  else if (pad === 1) s += "===";
  try {
    const buf = Buffer.from(s, "base64");
    // Only treat as valid if all characters are printable or the string starts with http
    const txt = buf.toString("utf8");
    // simple heuristic: decoded string should contain http or https or at least be ASCII
    if (/^https?:/i.test(txt) || /^[\x20-\x7E]+$/.test(txt)) {
      return txt;
    }
  } catch {}
  return null;
}

/**
 * Unwrap a tracking URL to reveal the final destination. Some
 * marketing/tracking services embed the real URL either in query
 * parameters (e.g. `u`, `url`, `redirect`) or as a Base64 encoded
 * path segment. If no known patterns are matched, the original URL
 * string is returned unchanged.
 *
 * @param {string} urlStr The URL string to unwrap
 * @returns {string} The unwrapped URL if found, otherwise the original
 */
function unwrapUrl(urlStr) {
  if (!urlStr) return urlStr;
  try {
    const u = new URL(urlStr);
    // Check common query parameter names for the real URL
    const paramNames = ["u", "url", "q", "target", "redirect", "link"];
    for (const key of paramNames) {
      const val = u.searchParams.get(key);
      if (val) {
        // If the value itself is a full URL, return it directly
        if (/^https?:/i.test(val)) return val;
        // If it's Base64 encoded, attempt to decode
        const dec = tryDecode(val);
        if (dec && /^https?:/i.test(dec)) return dec;
      }
    }
    // If no query parameters reveal a URL, inspect the path segments. Many
    // tracking services append the Base64 encoded destination as the last
    // segment of the path. Iterate through the segments and attempt to
    // decode each one.
    const segments = u.pathname.split("/").filter(Boolean);
    for (const seg of segments) {
      const decoded = tryDecode(seg);
      if (decoded && /^https?:/i.test(decoded)) {
        return decoded;
      }
    }
  } catch {}
  // Fall back to returning the original URL string
  return urlStr;
}

function firstUrlLike(s) {
  const m = String(s||"").match(/https?:\/\/\S+/);
  if (!m) return "";
  // strip trailing punctuation that often rides along in emails
  return m[0].replace(/[>),.;!]+$/, "");
}

function extractConversationId(input) {
  const s = (input || "").trim();
  if (!s) return "";

  // 1) exact UUID
  const direct = s.match(UUID_RE);
  if (direct && direct[0] && s.length === direct[0].length) return direct[0];

  // 2) if string contains /api/conversations/<uuid> anywhere
  const fromApi = s.match(/\/api\/conversations\/([0-9a-f-]{36})/i);
  if (fromApi) return fromApi[1];

  // 3) attempt to pull the first URL from the text, then search path segments for UUID
  const urlStr = firstUrlLike(s);
  if (urlStr) {
    try {
      // Unwrap potential tracking links that embed the destination URL
      const actualUrl = unwrapUrl(urlStr);
      const u = new URL(actualUrl);
      const parts = u.pathname.split("/").filter(Boolean);
      const fromPath = parts.find(x => UUID_RE.test(x));
      if (fromPath) return fromPath.match(UUID_RE)[0];
    } catch {}
  }

  // 4) last resort: any UUID anywhere in the text
  return direct ? direct[0] : "";
}

// Build a human UI link for the email body
function buildConversationLink() {
  const input = (CONVERSATION_INPUT || "").trim();
  const id = extractConversationId(input) || DEFAULT_CONVO_ID || "";
  // If an http(s) URL is present in the input, return the cleaned URL
  if (/^https?:\/\//i.test(input)) {
    try {
      const rawUrl = firstUrlLike(input);
      // Unwrap any tracking/redirect link to obtain the real destination URL
      const actualUrl = unwrapUrl(rawUrl);
      const u = new URL(actualUrl);
      // strip leading /api and anything after the uuid
      const parts = u.pathname.split("/").filter(Boolean);
      const uuidIndex = parts.findIndex(p => UUID_RE.test(p));
      if (uuidIndex >= 0) {
        const slice = parts.slice(0, uuidIndex + 1).filter((p,i)=>!(i===0 && p.toLowerCase()==="api"));
        u.pathname = "/" + slice.join("/");
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

  // follow redirects
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
    if (!v || typeof v!=="object") return;
    if (Array.isArray(v) && v.some(x => x && typeof x==="object" && ("by" in x || "sent_at" in x || "text" in x || "body" in x))) {
      candidates.push(v); return;
    }
    for (const k of Object.keys(v)) crawl(v[k]);
  })(data);
  if (candidates.length) return candidates[0];

  return [];
}

/**
 * Classify the sender of a message. The logic attempts to determine
 * whether a given message originated from a guest, an agent (host),
 * the AI system or is internal/system-only. Messages generated by the AI
 * that have been approved/sent/delivered are treated as agent messages
 * so that a confirmed AI reply counts as an answered guest message.
 *
 * @param {object} m The message object from the API
 * @returns {"guest"|"agent"|"ai"|"internal"} The inferred sender role
 */
function whoSent(m) {
  // Normalise some common fields
  const moduleVal = (m.module || m.module_type || "").toString().toLowerCase();
  const msgType   = (m.msg_type || m.type || "").toString().toLowerCase();
  // Pull the apparent author role from a variety of common fields. The
  // API uses different property names such as by, senderType, author.role,
  // author_role or just role. Include role as a last resort to avoid
  // misclassifying agent messages as guest messages when the only
  // indicator is a `role` field.
  const by        = (m.by || m.senderType || m.author?.role || m.author_role || m.role || "").toString().toLowerCase();
  const dir       = (m.direction || m.message_direction || "").toString().toLowerCase();
  const isAI      = Boolean(
    m.generated_by_ai || m.ai_generated || m.is_ai_generated ||
    m.generatedByAI || m.generatedByAi || m.aiGenerated || m.ai_generated_by
  );

  // Identify obvious system/internal notes. If module/type indicates a note
  // *and* there is no clear direction or author, treat as internal.
  // These system items include policy changes, fun level changes, etc.
  if ((moduleVal === "note" || msgType === "note") && !by && !dir) {
    return "internal";
  }
  // Additional safeguard: explicit system/automation roles
  if (["system","automation","policy","workflow"].includes(by)) {
    return "internal";
  }

  // Guest messages explicitly marked
  if (by === "guest" || by === "customer" || by === "user") {
    return "guest";
  }

  // Messages from the host/agent. In some datasets the role may be
  // recorded as 'host', 'agent', 'owner' or similar. Treat any non-guest
  // sender as agent by default.
  if (by) {
    // Many AI messages are authored by the host but flagged as AI-generated.
    if (isAI) {
      // Normalise the AI status across different possible property names
      const aiStatus = (m.ai_status || m.aiStatus || m.ai_message_status || m.status || m.state || "").toString().toLowerCase();
      // Consider a confirmed AI suggestion as an agent message. The list of
      // keywords is intentionally broad to catch variations (approved,
      // confirmed, sent, delivered, published, released). If COUNT_AI_AS_AGENT
      // is enabled, any AI-generated message should be treated as an agent
      // message regardless of its status.
      const approvedKeywords = [
        "approved",
        "confirmed",
        "sent",
        "delivered",
        "published",
        "released"
      ];
      const isApproved = approvedKeywords.some(k => aiStatus.includes(k));
      if (isApproved || COUNT_AI_AS_AGENT) return "agent";
      return "ai";
    }
    // Non-AI messages from the host are considered agent replies
    return "agent";
  }

  // Fallback to direction heuristics. Messages inbound to the system are
  // considered guest messages; outbound messages are agent replies.
  if (dir === "inbound") return "guest";
  if (dir === "outbound") return "agent";

  // As a conservative default, treat unknown messages as guest messages to
  // avoid inadvertently suppressing SLA alerts.
  return "guest";
}

function tsOf(m) {
  const t = m.sent_at || m.createdAt || m.timestamp || m.ts || m.time || null;
  const d = t ? new Date(t) : null;
  return d && !isNaN(+d) ? d : null;
}

function evaluate(messages, now = new Date(), slaMin = SLA_MINUTES) {
  // Determine whether the latest guest message has gone unanswered for
  // at least `slaMin` minutes. We build a chronologically sorted list
  // with a role classification for each message, ignoring items that
  // lack a valid timestamp. Messages marked as "internal" are always
  // skipped. AI suggestions that are not approved (and when
  // COUNT_AI_AS_AGENT is false) are treated like internal notes â
  // they neither start nor end an SLA window.
  const list = (messages || [])
    .filter(Boolean)
    .map(m => {
      const ts = tsOf(m);
      return ts instanceof Date ? { m, ts, role: whoSent(m) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => (a.ts?.getTime() || 0) - (b.ts?.getTime() || 0));

  if (!list.length) return { ok: true, reason: "empty" };

  // Track the timestamp of the most recent guest message that has not
  // yet been answered by an agent. As we iterate in order, a guest
  // message starts or resets the SLA countdown. A subsequent agent
  // message (or an AI message counted as agent) clears the pending
  // guest message. Unapproved AI suggestions and internal notes are
  // ignored.
  let lastGuestTs = null;
  for (const item of list) {
    const role = item.role;
    if (role === "internal") continue;
    if (role === "ai" && !COUNT_AI_AS_AGENT) {
      // treat unapproved AI suggestions as noise
      continue;
    }
    if (role === "guest") {
      // start or reset the SLA window
      lastGuestTs = item.ts;
    } else if (role === "agent" || (role === "ai" && COUNT_AI_AS_AGENT)) {
      // An agent response clears the SLA if it comes after the guest message
      if (lastGuestTs && item.ts >= lastGuestTs) {
        lastGuestTs = null;
      }
    }
  }

  if (!lastGuestTs) {
    // No outstanding guest message waiting for reply
    return { ok: true, reason: "no_breach" };
  }

  // Compute the minutes since the last unanswered guest message
  const minsSinceGuest = Math.round((now - lastGuestTs) / 60000);
  if (minsSinceGuest >= slaMin) {
    return { ok: false, reason: "guest_unanswered", minsSinceAgent: minsSinceGuest };
  }
  return { ok: true, reason: "within_sla", minsSinceAgent: minsSinceGuest };
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

  const messagesUrl = MESSAGES_URL_TMPL.replace(/{{conversationId}}/g, id);
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const res = await jf(messagesUrl, { method: MESSAGES_METHOD, headers });
  if (res.status >= 400) throw new Error(`Messages fetch failed: ${res.status}`);

  // 3) Parse and evaluate
  const data = await res.json();
  const msgs = normalizeMessages(data);
  const result = evaluate(msgs);
  console.log("Second check result:", JSON.stringify(result, null, 2));

  // 4) Alert if needed
  if (!result.ok && result.reason === "guest_unanswered") {
    const subj = `ÃÂ¢ÃÂÃÂ ÃÂ¯ÃÂ¸ÃÂ Boom SLA: guest unanswered ÃÂ¢ÃÂÃÂ¥ ${SLA_MINUTES}m`;
    const convoLink = buildConversationLink();
    const esc = (s) => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const linkHtml = convoLink ? `<p>Conversation: <a href="${esc(convoLink)}">${esc(convoLink)}</a></p>` : "";
    const bodyHtml = `<p>Guest appears unanswered ÃÂ¢ÃÂÃÂ¥ ${SLA_MINUTES} minutes.</p>${linkHtml}`;
    await sendEmail(subj, bodyHtml);
    console.log("ÃÂ¢ÃÂÃÂ Alert email sent.");
  } else {
    console.log("No alert sent.");
  }
})().catch(e => {
  console.error(e);
  process.exit(1);
});
