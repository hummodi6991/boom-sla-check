#!/usr/bin/env node

import fs from "node:fs";

// ---------- helpers ----------
const out = process.env.GITHUB_OUTPUT;
function setOutput(key, value) {
  if (!out) return;
  // Handle multiline safely
  if (/\r|\n/.test(value)) {
    const delim = `EOF_${key}_${Math.random().toString(36).slice(2)}`;
    fs.appendFileSync(out, `${key}<<${delim}\n${value}\n${delim}\n`);
  } else {
    fs.appendFileSync(out, `${key}=${value}\n`);
  }
}

const debug = (msg, obj) => {
  if (String(process.env.DEBUG || "").trim() === "1") {
    console.log("[DEBUG]", msg, obj ?? "");
  }
};

const minutes = Number(process.env.SLA_MINUTES || 5);

// Robust getter across differing payload shapes
const get = (obj, keys, fallback = undefined) => {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return fallback;
};

const ts = (m) => {
  const raw = get(m, ["created_at", "createdAt", "timestamp", "created", "date"], null);
  const d = raw ? new Date(raw) : null;
  return d && !isNaN(+d) ? d : null;
};

const lower = (v) => (typeof v === "string" ? v.toLowerCase() : "");

// ---------- read repository_dispatch payload ----------
let clientPayload = {};
try {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath && fs.existsSync(eventPath)) {
    const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
    clientPayload = event.client_payload || {};
    debug("Loaded client_payload keys", Object.keys(clientPayload));
  }
} catch (e) {
  console.error("Failed to read GITHUB_EVENT_PATH:", e.message);
}

// Allow simple local testing without repository_dispatch
const conversationUrl =
  clientPayload.conversationUrl ||
  clientPayload.conversationURL ||
  clientPayload.conversation_url ||
  process.env.CONVERSATION_URL ||
  "";

const rawMessages =
  clientPayload.messages ||
  clientPayload.thread ||
  clientPayload.items ||
  clientPayload.data ||
  [];

// ---------- normalize messages ----------
function normalizeMessage(m) {
  const roleRaw =
    get(m, ["sender_role", "authorRole", "author_role", "author", "role", "source", "origin", "sender_type"], "")
      .toString()
      .toLowerCase();

  // Try to classify simply
  let role = "";
  if (roleRaw.includes("guest") || roleRaw.includes("customer") || roleRaw.includes("user")) role = "guest";
  else if (roleRaw.includes("agent") || roleRaw.includes("staff") || roleRaw === "admin") role = "agent";
  else if (roleRaw.includes("ai") || roleRaw.includes("bot")) role = "ai";

  const direction = lower(get(m, ["direction", "dir"], ""));
  const status =
    lower(get(m, ["approval_status", "ai_status", "status", "decision"], "")) ||
    (m?.approved === true ? "approved" : "");

  const text = String(get(m, ["text", "body", "content", "message"], "")) || "";
  const time = ts(m);

  // attachment/image detection
  const attachments = get(m, ["attachments", "files", "images", "media"], []);
  const hasImage =
    Array.isArray(attachments) &&
    attachments.some((a) => {
      const ct = lower(get(a, ["content_type", "mime", "mimetype", "type"], ""));
      const name = lower(get(a, ["name", "filename"], ""));
      return ct.startsWith("image/") || name.match(/\.(png|jpg|jpeg|webp|gif)$/i);
    });

  return { raw: m, role, direction, status, text, time, hasImage };
}

const messages = Array.isArray(rawMessages) ? rawMessages.map(normalizeMessage).filter((m) => m.time) : [];

if (String(process.env.DEBUG || "") === "1") {
  console.table(
    messages.slice(-15).map((m) => ({
      at: m.time?.toISOString(),
      role: m.role,
      dir: m.direction || "",
      status: m.status || "",
      img: m.hasImage,
      len: (m.text || "").length,
    }))
  );
}

// ---------- predicates ----------
const aiMode = lower(process.env.COUNT_AI_SUGGESTION_AS_AGENT || "false");
const allowAnyAI = aiMode === "true";
const allowApprovedAI = aiMode === "approved" || allowAnyAI;

function isHumanAgentReply(m) {
  // outbound agent messages (some payloads don't include direction, so be tolerant)
  const outbound = m.direction ? ["outbound", "sent", "external"].includes(m.direction) : true;
  return m.role === "agent" && outbound;
}

function isApprovedAISuggestion(m) {
  // If not counting AI at all
  if (!allowApprovedAI && !allowAnyAI) return false;

  const outbound = m.direction ? ["outbound", "sent", "external"].includes(m.direction) : true;
  const isAI = m.role === "ai";

  if (!isAI || !outbound) return false;
  if (allowAnyAI) return true;

  // approved only
  return ["approved", "agent_approved", "auto_approved"].some((s) => (m.status || "").includes(s));
}

function qualifiesAsAgentReply(m) {
  return isHumanAgentReply(m) || isApprovedAISuggestion(m);
}

function isGuestInbound(m) {
  // inbound guest messages (again, tolerate missing direction)
  const inbound = m.direction ? ["inbound", "received", "internal"].includes(m.direction) : true;
  return m.role === "guest" && inbound;
}

// ---------- compute SLA ----------
let lastGuest = null;
for (const m of messages) {
  if (isGuestInbound(m)) {
    if (!lastGuest || m.time > lastGuest.time) lastGuest = m;
  }
}

if (!lastGuest) {
  const info = "No guest message found in payload; nothing to check.";
  console.log(info);
  setOutput("breach", "false");
  setOutput("email_subject", "");
  setOutput("email_body", info);
  process.exit(0);
}

const replied = messages.some((m) => m.time > lastGuest.time && qualifiesAsAgentReply(m));
const now = new Date();
const diffMin = Math.floor((now - lastGuest.time) / 60000);
const breach = !replied && diffMin >= minutes;

// ---------- build email ----------
const subject = `SLA breach: no approved reply within ${minutes}m`;
const lines = [
  `A guest message has not received a qualifying reply within ${minutes} minute(s).`,
  ``,
  `Last guest message time: ${lastGuest.time.toISOString()}`,
  `Minutes since: ${diffMin}`,
  `Qualifying reply present: ${replied ? "YES" : "NO"}`,
  allowApprovedAI
    ? `AI policy: counting ${allowAnyAI ? "any AI suggestion" : "only agent-approved AI suggestions"} as replies.`
    : `AI policy: AI suggestions do NOT count as replies.`,
  conversationUrl ? `\nConversation: ${conversationUrl}` : "",
  ``,
  `— Boom SLA Bot`,
].join("\n");

if (breach) {
  console.log("BREACH detected.");
  setOutput("breach", "true");
  setOutput("email_subject", subject);
  setOutput("email_body", lines);
} else {
  console.log("No breach.");
  setOutput("breach", "false");
  setOutput("email_subject", "");
  setOutput("email_body", "");
}
