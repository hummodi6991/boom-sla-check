// FULL FILE: check.mjs
// SLA checker with strict timing and human-reply gating.
// Drop-in replacement for the previous version. Keeps env names the same.
//
// Node 18+ (built-in fetch). If using older Node, polyfill fetch or use axios.
//
// ───────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import { sendAlert } from "./email.mjs";

// ----------------------
// Env helpers & settings
// ----------------------
const env = (k, d = "") => (process.env[k] ?? d).toString().trim();

// Credentials / SMTP (same names as before)
const BOOM_USER  = env("BOOM_USER");
const BOOM_PASS  = env("BOOM_PASS");
const ALERT_TO   = env("ALERT_TO");
const FROM_NAME  = env("ALERT_FROM_NAME", "Boom SLA Bot");

// API config (same names as before)
const API_KIND             = env("API_KIND", "rest");           // 'rest' or 'scrape'
const LOGIN_URL            = env("LOGIN_URL");
const LOGIN_METHOD         = env("LOGIN_METHOD", "POST");
const LOGIN_CT             = env("LOGIN_CT", "application/json");
const LOGIN_EMAIL_FIELD    = env("LOGIN_EMAIL_FIELD", "email");
const LOGIN_PASSWORD_FIELD = env("LOGIN_PASSWORD_FIELD", "password");
const LOGIN_TENANT_FIELD   = env("LOGIN_TENANT_FIELD", "");      // optional
const CSRF_HEADER_NAME     = env("CSRF_HEADER_NAME", "");
const CSRF_COOKIE_NAME     = env("CSRF_COOKIE_NAME", "");

const MESSAGES_URL_TMPL    = env("MESSAGES_URL");               // may contain :conversationId
const MESSAGES_METHOD      = env("MESSAGES_METHOD", "GET");

const SLA_MINUTES          = parseInt(env("SLA_MINUTES", "5"), 10);
const COUNT_AI_AS_AGENT    = env("COUNT_AI_SUGGESTION_AS_AGENT", "false").toLowerCase() === "true";
const BREACH_GRACE_SECONDS = parseInt(env("BREACH_GRACE_SECONDS", "60"), 10); // optional grace

// Inputs
const CONVERSATION_INPUT   = env("CONVERSATION_INPUT");         // ID or URL
const CONVERSATION_URL     = env("CONVERSATION_URL", "");       // explicit URL (optional)
const DEBUG                = env("DEBUG", "1") === "1";
const DEBUG_MESSAGES       = env("DEBUG_MESSAGES", "0") === "1";

// ---------------
// Small utilities
// ---------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const debug = (...args) => { if (DEBUG) console.log("[DEBUG]", ...args); };

// Used to pick a timestamp consistently from each message.
// We favor UI-like fields first so the SLA aligns with what humans see.
const pickTs = (m) => {
  const cands = [
    m.createdAt, m.created_at,
    m.timestamp, m.ts, m.time,
    m.sent_at, m.sentAt,
    m.date, m.datetime,
  ].filter(Boolean);
  const vals = cands.map((v) => new Date(v).getTime()).filter(Number.isFinite);
  return vals.length ? Math.max(...vals) : 0;
};

// True only for real human agent messages (AI suggestions ignored unless explicitly allowed).
const isHumanAgent = (m) => {
  // Allow an override via env if someone wants to count AI suggestions.
  if (COUNT_AI_AS_AGENT) {
    const role = (m.role || m.sender_type || m.author?.type || "").toLowerCase();
    return ["agent", "human", "staff", "support"].includes(role) || m.is_agent === true || m.direction === "out";
  }
  const role = (m.role || m.sender_type || m.author?.type || "").toLowerCase();
  const looksAgent = ["agent", "human", "staff", "support"].includes(role) || m.is_agent === true || m.direction === "out";
  const looksAi =
    m.is_ai === true || m.ai === true || m.is_suggestion === true ||
    m.cardType === "agent" || m.meta?.is_ai_suggestion === true;
  return looksAgent && !looksAi;
};

const isGuest = (m) => {
  const role = (m.role || m.sender_type || m.author?.type || "").toLowerCase();
  return m.is_guest === true || m.direction === "in" ||
         ["guest","user","customer","visitor","contact"].includes(role);
};

// ------------------
// Login / API client
// ------------------
async function loginIfNeeded() {
  if (!LOGIN_URL) return { headers: {} }; // assume public/read-only API
  const body = {};
  body[LOGIN_EMAIL_FIELD] = BOOM_USER;
  body[LOGIN_PASSWORD_FIELD] = BOOM_PASS;
  if (LOGIN_TENANT_FIELD) body[LOGIN_TENANT_FIELD] = env("TENANT", "");

  const res = await fetch(LOGIN_URL, {
    method: LOGIN_METHOD,
    headers: { "content-type": LOGIN_CT },
    body: LOGIN_METHOD.toUpperCase() === "GET" ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Login failed: ${res.status} ${res.statusText}`);
  }
  const setCookie = res.headers.get("set-cookie") || "";
  const cookies = setCookie.split(/, (?=[^;]+?=)/g).map(s => s.split(";")[0]).join("; ");
  const headers = cookies ? { cookie: cookies } : {};

  // Optional CSRF
  if (CSRF_COOKIE_NAME && CSRF_HEADER_NAME) {
    const match = (setCookie || "").match(new RegExp(`${CSRF_COOKIE_NAME}=([^;]+)`));
    if (match) headers[CSRF_HEADER_NAME] = match[1];
  }
  return { headers };
}

function buildMessagesUrl(conversationId) {
  if (!MESSAGES_URL_TMPL) throw new Error("MESSAGES_URL is not set.");
  return MESSAGES_URL_TMPL
    .replace(":conversationId", conversationId)
    .replace("{conversationId}", conversationId);
}

async function fetchMessages(conversationId) {
  const { headers } = await loginIfNeeded();
  const url = buildMessagesUrl(conversationId);
  const res = await fetch(url, { method: MESSAGES_METHOD, headers });
  if (!res.ok) throw new Error(`Failed to fetch messages: ${res.status} ${res.statusText}`);
  const data = await res.json();
  // Accept either array or { messages: [...] }
  const messages = Array.isArray(data) ? data : (data.messages || data.data || []);
  if (DEBUG_MESSAGES) {
    fs.writeFileSync("messages.debug.json", JSON.stringify(messages, null, 2));
  }
  return messages;
}

// -------------
// Input parsing
// -------------
function parseConversationInput() {
  // Accept explicit CONVERSATION_URL or raw ID via CONVERSATION_INPUT
  if (CONVERSATION_URL) return { conversationId: env("CONVERSATION_ID", ""), conversationUrl: CONVERSATION_URL };
  const raw = CONVERSATION_INPUT;
  if (!raw) return { conversationId: "", conversationUrl: "" };
  // If it looks like a URL, pass it back; otherwise treat as ID.
  if (/^https?:\/\//i.test(raw)) return { conversationId: "", conversationUrl: raw };
  return { conversationId: raw, conversationUrl: "" };
}

// --------------------
// SLA breach evaluator
// --------------------
async function evaluate() {
  const { conversationId, conversationUrl } = parseConversationInput();
  const targetId = conversationId || env("DEFAULT_CONVERSATION_ID", "");

  // If only a URL is provided, try to extract an id at the end like /conversations/:id
  let id = targetId;
  if (!id && conversationUrl) {
    const m = conversationUrl.match(/\b(conversation|conversations)\/(\w[\w-]*)/i);
    if (m) id = m[2];
  }
  if (!id) throw new Error("No conversation id/URL provided. Set CONVERSATION_INPUT or DEFAULT_CONVERSATION_ID.");

  debug("Checking conversation:", { id, conversationUrl });

  const messages = await fetchMessages(id);

  // Compute lastGuestTs and lastAgentTs
  const guestTs = messages.filter(isGuest).map(pickTs).filter(Boolean);
  const agentTs = messages.filter(isHumanAgent).map(pickTs).filter(Boolean);

  const lastGuestTs = guestTs.length ? Math.max(...guestTs) : 0;
  const lastAgentTs = agentTs.length ? Math.max(...agentTs) : 0;

  debug("Timestamps:", { lastGuestTs, lastAgentTs, now: Date.now() });

  if (!lastGuestTs) {
    return { ok: true, reason: "no_guest_message" };
  }

  // ✅ Short-circuit if a human answered after the last guest message.
  if (lastAgentTs && lastAgentTs > lastGuestTs) {
    return { ok: true, reason: "answered_within_sla", lastGuestTs, lastAgentTs };
  }

  // Strict minute math: FLOOR (no early flip).
  const minsSinceGuest = Math.floor((Date.now() - lastGuestTs) / 60_000);
  if (minsSinceGuest < SLA_MINUTES) {
    return { ok: true, reason: "still_within_sla", minsSinceGuest, lastGuestTs };
  }

  // Optional one-shot grace recheck to avoid boundary races/API lag.
  if (BREACH_GRACE_SECONDS > 0) {
    await sleep(BREACH_GRACE_SECONDS * 1000);
    const refreshed = await fetchMessages(id);
    const refreshedAgentTs = refreshed.filter(isHumanAgent).map(pickTs).reduce((a, b) => Math.max(a, b), 0);
    if (refreshedAgentTs && refreshedAgentTs > lastGuestTs) {
      return { ok: true, reason: "answered_during_grace", lastGuestTs, lastAgentTs: refreshedAgentTs };
    }
  }

  // 🚨 Breach.
  return { ok: false, reason: "guest_unanswered", minsSinceGuest, lastGuestTs, lastAgentTs, conversationUrl };
}

// -------------
// Email message
// -------------
function formatTime(ts) {
  if (!ts) return "N/A";
  const d = new Date(ts);
  return `${d.toLocaleString()}`;
}

async function main() {
  const result = await evaluate();
  const convoLink = CONVERSATION_URL || env("CONVERSATION_URL", "");

  if (!result.ok) {
    const subject = `⚠️ SLA breach ≥ ${SLA_MINUTES} min`;
    const html = `\
<p>Guest appears unanswered ≥ ${SLA_MINUTES} minutes.</p>
${convoLink ? `<p>Conversation: <a href="${convoLink}">${convoLink}</a></p>` : ""}
<ul>
  <li><b>Last guest:</b> ${formatTime(result.lastGuestTs)}</li>
  <li><b>Last agent:</b> ${formatTime(result.lastAgentTs)}</li>
  <li><b>Now:</b> ${formatTime(Date.now())}</li>
</ul>`;
    const text = `Guest appears unanswered >= ${SLA_MINUTES} minutes.
${convoLink ? `Conversation: ${convoLink}` : ""}
Last guest: ${formatTime(result.lastGuestTs)}
Last agent: ${formatTime(result.lastAgentTs)}
Now:        ${formatTime(Date.now())}`;

    if (ALERT_TO) {
      const { sent, reason } = await sendAlert({ subject, html, text });
      if (!sent) {
        console.log("Alert needed but not sent:", reason);
      } else {
        console.log("✅ Alert email sent.");
      }
    } else {
      console.log("⚠️ Breach detected, but ALERT_TO is not set. Skipping email.");
    }
  } else {
    console.log("No alert:", result.reason);
  }

  if (DEBUG) {
    fs.writeFileSync("result.debug.json", JSON.stringify(result, null, 2));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
