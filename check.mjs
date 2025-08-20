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
// Small buffer to avoid jitter-based false positives
const SLA_GRACE_SECONDS = parseInt(env("SLA_GRACE_SECONDS","60"),10);

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
 * using URL-safe Base64 encoding. This helper normalises the input and
 * pads it to a multiple of 4 before decoding. If the decoded string
 * contains non-printable characters or cannot be decoded it returns
 * null.
 *
 * @param {string} str The candidate string to decode
 * @returns {string|null} Decoded UTF-8 string or null if decoding fails
 */
function tryDecode(str) {
  if (!str || typeof str !== "string") return null;
  // Replace URL-safe characters
  let s = str.replace(/-/g, "+").replace(/_/g, "/");
  // Pad to length divisible by 4
  const pad = s.length % 4;
  if (pad) s = s + "===".slice(0, 4 - pad);
  try {
    const buf = Buffer.from(s, "base64");
    const text = buf.toString("utf8");
    // basic sanity check: printable ratio
    const printable = text.replace(/[\x20-\x7E\s]/g, "").length;
    if (printable === 0 || printable / text.length < 0.1) return text;
  } catch {}
  return null;
}

function unwrapUrl(urlStr) {
  if (!urlStr) return urlStr;
  try {
    const u = new URL(urlStr);
    // Check common query parameter names for the real URL
    const paramNames = ["u", "url", "q", "target", "redirect", "link"];
    for (const key of paramNames) {
      const val = u.searchParams.get(key);
      if (val) {
        if (/^https?:/i.test(val)) return val;
        const dec = tryDecode(val);
        if (dec && /^https?:/i.test(dec)) return dec;
      }
    }
    // Some trackers put a base64 URL in the path
    const segments = u.pathname.split("/").filter(Boolean);
    for (const seg of segments) {
      const decoded = tryDecode(seg);
      if (decoded && /^https?:/i.test(decoded)) return decoded;
    }
  } catch {}
  return urlStr;
}

function firstUrlLike(s) {
  const m = String(s||"").match(/https?:\/\/\S+/);
  return m ? m[0] : "";
}

function extractConversationId(input) {
  const s = String(input||"").trim();
  // accept UUID anywhere in the string
  const m = s.match(UUID_RE);
  return m ? m[0] : "";
}

async function jf(url, opts={}) {
  const r = await fetch(url, opts);
  if (!r.ok && r.status >= 400) return r;
  // follow boom's redirects to reach final JSON
  let hops = 0;
  let cur = r;
  while (cur.status >= 300 && cur.status < 400 && cur.headers.get("location") && hops < 5) {
    const next = new URL(cur.headers.get("location"), url).toString();
    cur = await fetch(next, { method: "GET" });
    hops++;
  }
  return cur;
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

  // NOTE: If your app requires CSRF headers/cookies, add them here.
  const res = await fetch(LOGIN_URL, { method: LOGIN_METHOD, headers, body, redirect: "manual" });
  if (res.status >= 400) throw new Error(`Login failed: ${res.status}`);
  const data = await res.json().catch(()=> ({}));
  return data.token || data.access_token || data.jwt || "";
}

function normalizeMessages(raw) {
  // Accept either an array or an object with .data / .messages
  const arr = Array.isArray(raw) ? raw
    : Array.isArray(raw?.data) ? raw.data
    : Array.isArray(raw?.messages) ? raw.messages
    : [];

  return arr.map(m => ({
    ...m,
    // normalize common fields
    body: m.body ?? m.message ?? m.text ?? "",
    direction: m.direction ?? m.dir ?? "",
    sent_at: m.sent_at ?? m.createdAt ?? m.timestamp ?? m.ts ?? m.time ?? "",
    module: m.module ?? m.msg_module ?? "",
    msg_type: m.msg_type ?? m.type ?? "",
    from: m.from ?? m.sender ?? "",
    to: m.to ?? m.recipient ?? "",
    ai_status: m.ai_status ?? m.aiStatus ?? "",
    sender_type: m.sender_type ?? m.senderType ?? "",
  }));
}

function whoSent(m) {
  // Prefer explicit sender_type/module when available
  const st = (m.sender_type || "").toString().toLowerCase();
  const mod = (m.module || "").toString().toLowerCase();
  const isAI = mod.includes("ai") || st.includes("ai");

  const by = (m.by || m.from || "").toString().toLowerCase();
  if (by.includes("guest") || by.includes("customer") || by.includes("user")) return "guest";
  if (by.includes("agent") || by.includes("operator") || by.includes("staff")) return "agent";
  if (by.includes("ai") || by.includes("bot")) {
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

// >>> NEW core SLA logic (reply-after-last-guest + grace) <<<
function evaluate(messages, now = new Date(), slaMin = SLA_MINUTES) {
  // 1) Keep real messages only (no internal notes)
  const list = (messages || [])
    .filter(Boolean)
    .filter(m => {
      const moduleVal = (m.module || "").toString().toLowerCase();
      const msgType   = (m.msg_type || "").toString().toLowerCase();
      return moduleVal !== "note" && msgType !== "note";
    })
    .map(x => ({ ...x, _ts: tsOf(x) }))
    .filter(x => x._ts instanceof Date && !isNaN(+x._ts));

  if (!list.length) return { ok: true, reason: "empty" };

  // 2) Sort by time (ascending)
  list.sort((a, b) => a._ts - b._ts);

  // 3) If the very last message in the thread is NOT from the guest, there is no outstanding guest to answer
  const lastMsg = list[list.length - 1];
  if (whoSent(lastMsg) !== "guest") {
    return { ok: true, reason: "last_not_guest" };
  }

  // 4) Find the index/time of the LAST guest message
  let lastGuestIdx = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (whoSent(list[i]) === "guest") { lastGuestIdx = i; break; }
  }
  if (lastGuestIdx === -1) return { ok: true, reason: "no_guest_found" };

  const lastGuest = list[lastGuestIdx];

  // 5) Did an agent (or AI if allowed) reply AFTER that last guest?
  const repliedAfter = list.slice(lastGuestIdx + 1).find(m => {
    const role = whoSent(m);
    if (role === "agent") return true;
    if (role === "ai" && COUNT_AI_AS_AGENT) return true;
    return false;
  });

  if (repliedAfter) {
    // There is a reply after the last guest message → not a breach
    return { ok: true, reason: "answered_after_last_guest" };
  }

  // 6) No reply after the last guest message → check if the wait exceeds SLA (+ optional grace)
  const msSinceLastGuest = now - lastGuest._ts;
  const limitMs = (slaMin * 60 + SLA_GRACE_SECONDS) * 1000;

  if (msSinceLastGuest >= limitMs) {
    const mins = Math.round(msSinceLastGuest / 60000);
    return { ok: false, reason: "guest_unanswered", minsSinceGuest: mins };
  } else {
    const mins = Math.round(msSinceLastGuest / 60000);
    return { ok: true, reason: "within_grace", minsSinceGuest: mins };
  }
}

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
      return urlStr;
    } catch {}
  }
  return "";
}

async function sendEmail(subject, html) {
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS || !ALERT_TO) {
    throw new Error("SMTP credentials or ALERT_TO missing");
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
  if (!id) throw new Error("No conversationId available. Provide (UI URL / API URL / UUID) or set DEFAULT_CONVERSATION_ID repo variable.");
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
