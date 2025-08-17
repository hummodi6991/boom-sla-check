// check.mjs — Boom SLA alerts via REST API (final)
// Uses: POST /api/login  +  GET /api/conversations/{conversationId}
// Decides: alert when last message is guest and no human agent reply in >= SLA_MINUTES.
// Ignores AI suggestions unless approved/sent; ignores internal notes.

import nodemailer from "nodemailer";

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
const LOGIN_TENANT_FIELD   = env("LOGIN_TENANT_FIELD","");  // optional; Boom uses tenant_id
const CSRF_HEADER_NAME     = env("CSRF_HEADER_NAME","");
const CSRF_COOKIE_NAME     = env("CSRF_COOKIE_NAME","");

const API_KIND             = env("API_KIND","rest");       // must be "rest" here
const MESSAGES_URL_TMPL    = env("MESSAGES_URL");          // includes {{conversationId}}
const MESSAGES_METHOD      = env("MESSAGES_METHOD","GET");

const SLA_MINUTES          = parseInt(env("SLA_MINUTES","5"),10);
const COUNT_AI_AS_AGENT    = env("COUNT_AI_SUGGESTION_AS_AGENT","false").toLowerCase()==="true";
const CONVERSATION_URL     = env("CONVERSATION_URL","");   // optional manual input

// --- tiny cookie jar ---
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

  // Mirror CSRF cookie into header if configured (not needed here)
  if (CSRF_HEADER_NAME && CSRF_COOKIE_NAME && !headers.has(CSRF_HEADER_NAME)) {
    const val = jar.get(CSRF_COOKIE_NAME);
    if (val) headers.set(CSRF_HEADER_NAME, decodeURIComponent(val));
  }

  const res = await fetch(url, { ...init, headers, redirect: "manual" });
  const setc = res.headers.get("set-cookie");
  if (setc) jar.ingest(setc);

  // Follow simple redirects (rare on API)
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
  // Build login body exactly like the app: { email, password, tenant_id: null }
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

  // If a bearer token is returned, keep it (many apps only use cookies; that's OK)
  let token = null;
  try {
    const j = await res.clone().json();
    token = j?.token || j?.accessToken || j?.data?.accessToken || null;
  } catch {}
  return token;
}

function parseConvoIdFromUrl(u) {
  if (!u) return null;
  try {
    const p = new URL(u).pathname.split("/");
    return p.find(x => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x)) || null;
  } catch { return null; }
}

function buildMessagesUrl(conversationUrl) {
  // expects template: .../api/conversations/{{conversationId}}
  if (!MESSAGES_URL_TMPL) throw new Error("MESSAGES_URL not set");
  const cid = parseConvoIdFromUrl(conversationUrl);
  if (!cid && MESSAGES_URL_TMPL.includes("{{conversationId}}")) {
    throw new Error("No conversationId available. Provide a conversation page URL when running manually.");
  }
  return MESSAGES_URL_TMPL.replace(/{{conversationId}}/g, cid ?? "");
}

function normalizeMessages(data) {
  if (Array.isArray(data)) return data;
  // Common Boom shapes from your logs/artifacts:
  if (Array.isArray(data?.messages)) return data.messages;
  if (Array.isArray(data?.thread))   return data.thread;
  if (Array.isArray(data?.items))    return data.items;
  if (Array.isArray(data?.conversation?.messages)) return data.conversation.messages;
  if (Array.isArray(data?.data?.conversation?.messages)) return data.data.conversation.messages;

  // Fallback: find any array of objects with typical keys
  const candidates = [];
  (function crawl(v){
    if (!v || typeof v!=="object") return;
    if (Array.isArray(v) && v.some(x => x && typeof x==="object" && ("by" in x || "sent_at" in x || "text" in x || "body" in x))) {
      candidates.push(v);
      return;
    }
    for (const k of Object.keys(v)) crawl(v[k]);
  })(data);
  if (candidates.length) return candidates[0];

  return [];
}

function whoSent(m) {
  // Ignore internal notes
  const moduleVal = (m.module || "").toString().toLowerCase();
  const msgType   = (m.msg_type || "").toString().toLowerCase();
  if (moduleVal === "note" || msgType === "note") return "internal";

  const by = (m.by || m.senderType || m.author?.role || "").toString().toLowerCase(); // "guest" or "host"
  const isAI = !!m.generated_by_ai;

  if (by === "guest") return "guest";

  if (by === "host") {
    if (!isAI) return "agent"; // human
    // AI message counts as agent only if it was actually sent/approved
    const status = (m.ai_status || "").toString().toLowerCase();
    if (["approved","sent","delivered"].includes(status)) return "agent";
    return "ai"; // suggestion/draft
  }

  // Fallbacks (some APIs use direction fields)
  const dir = (m.direction || "").toString().toLowerCase();
  if (dir === "inbound") return "guest";
  if (dir === "outbound") return "agent";

  return "guest"; // safest default for SLA
}

function tsOf(m) {
  const t = m.sent_at || m.createdAt || m.timestamp || m.ts || m.time || null;
  const d = t ? new Date(t) : null;
  return d && !isNaN(+d) ? d : null;
}

function evaluate(messages, now = new Date(), slaMin = 5) {
  const list = (messages || []).filter(Boolean).filter(m => {
    const moduleVal = (m.module || "").toString().toLowerCase();
    const msgType   = (m.msg_type || "").toString().toLowerCase();
    return moduleVal !== "note" && msgType !== "note";
  }).map(x => ({...x, _ts: tsOf(x)}));

  if (!list.length) return { ok: true, reason: "empty" };
  list.sort((a,b) => (a._ts?.getTime()||0) - (b._ts?.getTime()||0));
  const last = list[list.length-1];
  const lastSender = whoSent(last);

  // last qualifying agent message (exclude AI suggestions unless configured)
  let lastAgent = null;
  for (let i=list.length-1; i>=0; i--) {
    if (whoSent(list[i]) === "agent") { lastAgent = list[i]; break; }
  }

  const minsSinceAgent = lastAgent? Math.round((now - lastAgent._ts)/60000) : null;

  if (lastSender === "guest" && (lastAgent === null || minsSinceAgent === null || minsSinceAgent >= SLA_MINUTES)) {
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

  // 2) Build messages URL
  const messagesUrl = buildMessagesUrl(CONVERSATION_URL);
  const res = await jf(messagesUrl, { method: MESSAGES_METHOD, headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (res.status >= 400) throw new Error(`Messages fetch failed: ${res.status}`);

  // 3) Parse and evaluate
  const data = await res.json();
  const msgs = normalizeMessages(data);
  const result = evaluate(msgs);
  console.log("Second check result:", JSON.stringify(result, null, 2));

  // 4) Alert if needed
  if (!result.ok && result.reason === "guest_unanswered") {
    const subj = `⚠️ Boom SLA: guest unanswered ≥ ${SLA_MINUTES}m`;
    const link = CONVERSATION_URL ? `<p><a href="${CONVERSATION_URL}">Open conversation</a></p>` : "";
    await sendEmail(subj, `<p>Guest appears unanswered ≥ ${SLA_MINUTES} minutes.</p>${link}`);
    console.log("✅ Alert email sent.");
  } else {
    console.log("No alert sent.");
  }
})().catch(e => {
  console.error(e);
  process.exit(1);
});
