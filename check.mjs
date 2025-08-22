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

// --- API config / repo vars ---
const LOGIN_URL  = env("LOGIN_URL","https://app.boomnow.com/api/login");
const LOGIN_METHOD = env("LOGIN_METHOD","POST");
const LOGIN_CT     = env("LOGIN_CT","application/json");
const LOGIN_EMAIL_FIELD    = env("LOGIN_EMAIL_FIELD","email");
const LOGIN_PASSWORD_FIELD = env("LOGIN_PASSWORD_FIELD","password");
const LOGIN_TENANT_FIELD   = env("LOGIN_TENANT_FIELD","tenant_id");
const CSRF_HEADER_NAME     = env("CSRF_HEADER_NAME","");
const CSRF_COOKIE_NAME     = env("CSRF_COOKIE_NAME","");

const API_KIND = env("API_KIND","rest"); // 'rest' only right now
const MESSAGES_URL_TMPL = env("MESSAGES_URL","https://app.boomnow.com/api/conversations/{{conversationId}}");
const MESSAGES_METHOD   = env("MESSAGES_METHOD","GET");
const SLA_MINUTES = parseInt(env("SLA_MINUTES","5"),10);
const COUNT_AI_SUGGESTION_AS_AGENT = env("COUNT_AI_SUGGESTION_AS_AGENT","false").toLowerCase() === "true";

// --- Conversation input selection ---
const CONVERSATION_INPUT = env("CONVERSATION_INPUT","");
const DEFAULT_CONVERSATION_ID = env("DEFAULT_CONVERSATION_ID","");

// Small fetch wrapper
async function jf(url, opts={}) {
  const { default: fetch } = await import("node-fetch");
  const res = await fetch(url, opts);
  return res;
}

// Read JSON helper
function readJSON(path) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (_) {
    return null;
  }
}

// Parse first http(s) URL
function firstUrlLike(s) {
  const m = String(s||"").match(/https?:\/\/\S+/);
  if (!m) return "";
  // strip trailing punctuation that often rides along in emails
  return m[0].replace(/[>),.;!]+$/, "");
}

// Extract UUID out of various inputs
function extractConversationId(input) {
  const s = (input || "").trim();
  if (!s) return "";

  // 1) exact UUID
  const uuid = s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  if (uuid) return uuid[0];

  // 2) if it looks like a URL, keep the URL
  const url = firstUrlLike(s);
  if (url) return url;

  return "";
}

// Normalize raw messages to a common shape we can reason about
function normalizeMessages(data) {
  if (!data) return [];
  const arr = Array.isArray(data) ? data : (Array.isArray(data.messages) ? data.messages : []);
  return arr.map(m => {
    // Try to infer who sent it
    const sender      = (m.sender || m.from || "").toString();
    const role        = (m.role || "").toString().toLowerCase();
    const content     = (m.text || m.content || m.body || "").toString();
    const createdAt   = new Date(m.createdAt || m.created_at || m.time || m.timestamp || 0).getTime() || 0;
    const type        = (m.type || "").toString().toLowerCase();
    const isAi        = (type === "ai" || role === "assistant" || role === "ai");
    const isAgent     = (role === "agent" || (sender && !isAi && sender !== "guest" && sender !== "customer"));
    const isGuest     = (role === "guest" || role === "user" || sender === "guest" || sender === "customer");
    const isAiSuggestion = (m.is_suggestion === true || m.suggestion === true);

    return {
      sender, role, content, createdAt,
      isAi, isAgent, isGuest, isAiSuggestion
    };
  }).sort((a,b) => a.createdAt - b.createdAt);
}

// Evaluate whether we’re beyond SLA without an agent reply
function evaluate(msgs) {
  const now = Date.now();
  const ms5 = SLA_MINUTES * 60 * 1000;

  // Find last guest message
  const lastGuest = [...msgs].reverse().find(m => m.isGuest);
  if (!lastGuest) return { ok: true, reason: "no_guest_message" };

  // Find last agent message *after* last guest message
  const lastAgentAfterGuest = [...msgs].reverse().find(m => m.isAgent && m.createdAt >= lastGuest.createdAt);

  // Count AI suggestions as agent or not based on setting
  const lastAgentOrSuggestion = [...msgs].reverse().find(m => {
    if (m.createdAt < lastGuest.createdAt) return false;
    if (m.isAgent) return true;
    if (COUNT_AI_SUGGESTION_AS_AGENT && m.isAiSuggestion) return true;
    return false;
  });

  const age = now - lastGuest.createdAt;
  const minsSinceGuest = Math.floor(age / 60000);

  if (!lastAgentOrSuggestion && age >= ms5) {
    return { ok: false, reason: "guest_unanswered", minsSinceGuest };
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
  // 1) Login and get token (REST only)
  let token = "";
  if (API_KIND === "rest") {
    const payload = {
      [LOGIN_EMAIL_FIELD]: BOOM_USER,
      [LOGIN_PASSWORD_FIELD]: BOOM_PASS
    };
    if (LOGIN_TENANT_FIELD) payload[LOGIN_TENANT_FIELD] = "";

    const headers = { "content-type": LOGIN_CT };
    if (CSRF_HEADER_NAME && CSRF_COOKIE_NAME) {
      // if your API requires CSRF, you can add that logic here
    }
    const res = await jf(LOGIN_URL, {
      method: LOGIN_METHOD,
      headers,
      body: JSON.stringify(payload)
    });
    if (res.status >= 400) throw new Error(`Login failed: ${res.status}`);
    const json = await res.json();
    token = json?.token || json?.access_token || "";
  }

  // 2) Work out conversation target
  let id = extractConversationId(CONVERSATION_INPUT);
  if (!id) id = DEFAULT_CONVERSATION_ID;
  if (!id) throw new Error("No conversation id or URL available. Provide an input (UI URL / API URL / UUID) or set DEFAULT_CONVERSATION_ID repo variable.");
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
    // Compose a clean subject/body without garbled UTF-8 sequences.
    const subj = `⚠️ Boom SLA: guest unanswered ≥ ${SLA_MINUTES}m`;
    const convoLink = buildConversationLink();
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const linkHtml = convoLink ? `<p>Conversation: <a href="${esc(convoLink)}">${esc(convoLink)}</a></p>` : "";
    // Likewise, use a properly encoded ≥ sign in the body.  HTML content is otherwise unchanged.
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

// Build a UI link from inputs, if possible
function buildConversationLink() {
  const s = (CONVERSATION_INPUT || "").trim();
  const url = firstUrlLike(s);
  if (url) return url;

  // If a bare UUID was used, you can put your product’s standard UI URL here:
  // return `https://app.boomnow.com/conversations/${s}`;
  return "";
}
