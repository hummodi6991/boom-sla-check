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
// Prefer an explicit env variable. If missing and this is a repository_dispatch run,
// parse the GitHub event JSON. Power Automate may use different property names for
// the conversation URL/UUID, so we search the entire client_payload for the first
// string that yields a valid UUID when passed through extractConversationId().
// As a last resort, if no UUID-bearing string is found, we fall back to the first
// string containing any URL or UUID.
let CONVERSATION_INPUT = env("CONVERSATION_INPUT", "");
if (!CONVERSATION_INPUT) {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventName === "repository_dispatch" && eventPath && fs.existsSync(eventPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(eventPath, "utf8"));
      const p = data.client_payload || {};
      // Helper to recursively gather all string values from an object
      function gatherStrings(val, out) {
        if (typeof val === "string") {
          out.push(val);
        } else if (Array.isArray(val)) {
          for (const item of val) gatherStrings(item, out);
        } else if (val && typeof val === "object") {
          for (const key of Object.keys(val)) gatherStrings(val[key], out);
        }
      }
      const allStrings = [];
      gatherStrings(p, allStrings);
      // Try preferred keys first for backwards compatibility
      const preferredKeys = [
        "conversation",
        "conversationUrl",
        "conversationURL",
        "conversation_url",
        "url",
        "text",
        "body"
      ];
      for (const key of preferredKeys) {
        const v = p[key];
        if (typeof v === "string" && v.trim()) {
          CONVERSATION_INPUT = v.trim();
          break;
        }
      }
      // Otherwise, find the first string with a valid conversationId
      if (!CONVERSATION_INPUT) {
        for (const s of allStrings) {
          const cleaned = s.trim();
          if (!cleaned) continue;
          try {
            const id = extractConversationId(cleaned);
            if (id) {
              CONVERSATION_INPUT = cleaned;
              break;
            }
          } catch {
            /* ignore */
          }
        }
      }
      // Last fallback: any string containing a URL or UUID
      if (!CONVERSATION_INPUT) {
        const candidate = allStrings.find(s => {
          const cleaned = s.trim();
          return /https?:\/\//i.test(cleaned) || UUID_RE.test(cleaned);
        });
        if (candidate) CONVERSATION_INPUT = candidate.trim();
      }
      if (CONVERSATION_INPUT) {
        process.env.CONVERSATION_INPUT = CONVERSATION_INPUT;
      }
    } catch {
      // ignore parse errors
    }
  }
}
const DEFAULT_CONVO_ID = env("DEFAULT_CONVERSATION_ID","");

// === Utils ===
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

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
      const u = new URL(urlStr);
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
      const u = new URL(firstUrlLike(input));
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

function whoSent(m) {
  const moduleVal = (m.module || "").toString().toLowerCase();
  const msgType   = (m.msg_type || "").toString().toLowerCase();
  if (moduleVal === "note" || msgType === "note") return "internal";

  const by = (m.by || m.senderType || m.author?.role || "").toString().toLowerCase();
  const isAI = !!m.generated_by_ai;

  if (by === "guest") return "guest";
  if (by === "host") {
    if (!isAI) return "agent";
    const status = (m.ai_status || "").toString().toLowerCase();
    if (["approved","sent","delivered"].includes(status)) return "agent";
    return "ai";
  }

  const dir = (m.direction || "").toString().toLowerCase();
  if (dir === "inbound") return "guest";
  if (dir === "outbound") return "agent";

  return "guest"; // conservative default
}

function tsOf(m) {
  const t = m.sent_at || m.createdAt || m.timestamp || m.ts || m.time || null;
  const d = t ? new Date(t) : null;
  return d && !isNaN(+d) ? d : null;
}

function evaluate(messages, now = new Date(), slaMin = SLA_MINUTES) {
  const list = (messages || []).filter(Boolean).filter(m => {
    const moduleVal = (m.module || "").toString().toLowerCase();
    const msgType   = (m.msg_type || "").toString().toLowerCase();
    return moduleVal !== "note" && msgType !== "note";
  }).map(x => ({...x, _ts: tsOf(x)}));

  if (!list.length) return { ok: true, reason: "empty" };
  list.sort((a,b) => (a._ts?.getTime()||0) - (b._ts?.getTime()||0));
  const last = list[list.length-1];
  const lastSender = whoSent(last);

  let lastAgent = null;
  for (let i=list.length-1; i>=0; i--) {
    const role = whoSent(list[i]);
    if (role === "agent") { lastAgent = list[i]; break; }
    if (role === "ai" && COUNT_AI_AS_AGENT) { lastAgent = list[i]; break; }
  }

  const minsSinceAgent = lastAgent? Math.round((now - lastAgent._ts)/60000) : null;

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

  const baseUrl = MESSAGES_URL_TMPL.replace(/{{conversationId}}/g, id);
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  // Try a series of candidate URLs to fetch messages. Some installations
  // expect `/conversations/<id>`, others `/conversations/<id>/messages` or
  // `/conversations/<id>/thread`. Attempt each variant until one returns
  // a successful (<400) status. Capture the last failure status for
  // reporting.
  const candidates = [];
  candidates.push(baseUrl);
  // Only add a trailing variant if it's not already present
  if (!/\/(messages|thread)(\/)?$/i.test(baseUrl)) {
    candidates.push(baseUrl.replace(/\/$/, "") + "/messages");
    candidates.push(baseUrl.replace(/\/$/, "") + "/thread");
  }
  let response = null;
  let lastStatus = 0;
  for (const url of candidates) {
    const res = await jf(url, { method: MESSAGES_METHOD, headers });
    lastStatus = res.status;
    if (res.status < 400) {
      response = res;
      break;
    }
  }
  if (!response) {
    throw new Error(`Messages fetch failed: ${lastStatus}`);
  }

  // 3) Parse and evaluate
  const data = await response.json();
  const msgs = normalizeMessages(data);
  const result = evaluate(msgs);
  console.log("Second check result:", JSON.stringify(result, null, 2));

  // 4) Alert if needed
  if (!result.ok && result.reason === "guest_unanswered") {
    const subj = `â ï¸ Boom SLA: guest unanswered â¥ ${SLA_MINUTES}m`;
    const convoLink = buildConversationLink();
    const esc = (s) => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const linkHtml = convoLink ? `<p>Conversation: <a href="${esc(convoLink)}">${esc(convoLink)}</a></p>` : "";
    const bodyHtml = `<p>Guest appears unanswered â¥ ${SLA_MINUTES} minutes.</p>${linkHtml}`;
    await sendEmail(subj, bodyHtml);
    console.log("â Alert email sent.");
  } else {
    console.log("No alert sent.");
  }
})().catch(e => {
  console.error(e);
  process.exit(1);
});
