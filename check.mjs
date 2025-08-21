import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { sendAlert } from "./email.mjs";

/**
 * SLA checker:
 * - Detects sender role per message (guest / agent / ai / internal).
 * - Counts ONLY approved/sent/published AI replies as agent (unless COUNT_AI_SUGGESTION_AS_AGENT=true).
 * - Ignores AI suggestions/drafts and internal notes.
 * - Sends an email alert when the latest guest message has waited >= SLA_MINUTES with no agent reply after it.
 */

// ---------------- Env helpers ----------------
const env = (k, d="") => (process.env[k] ?? d).toString().trim();

// SMTP/alert envs are read by email.mjs

// Behavior switches / config
const SLA_MINUTES          = parseInt(env("SLA_MINUTES","5"),10);
const COUNT_AI_AS_AGENT    = env("COUNT_AI_SUGGESTION_AS_AGENT","false").toLowerCase()==="true";
const APPROVED_STATUS_WORDS = (env("APPROVED_STATUS_WORDS",
  "approved,approved_and_sent,approved-sent,confirmed,sent,delivered,published,posted,released,dispatched,submitted,success,ok,complete,completed"
)).split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const AI_SENDER_HINTS = (env("AI_SENDER_HINTS",
  "ai,assistant,automated,autoresponder,copilot,genai,llm,model"
)).split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

// ---------------- Generic utils ----------------
const normalize = (v) => (v ?? "").toString().trim().toLowerCase();
const isTruthy = (v) => {
  const s = normalize(v);
  return v === true || v === 1 || ["true","1","yes","y","on"].includes(s);
};

function asArray(x) {
  if (x == null) return [];
  if (Array.isArray(x)) return x;
  return [x];
}

function coalesce(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && v !== "") return v;
  return undefined;
}

// ---------------- AI detection ----------------
function looksLikeAI(m) {
  const by = normalize(
    coalesce(
      m.by, m.senderType, m.sender_type, m.author?.role, m.author_role,
      m.role, m.source, m.origin, m.agent_type,
      m.via, m.message_origin
    )
  );

  if (AI_SENDER_HINTS.some(h => by.includes(h))) return true;

  const flags = [
    m.generated_by_ai, m.ai_generated, m.is_ai_generated,
    m.generatedByAI, m.generatedByAi, m.aiGenerated,
    m.ai_generated_by, m.isAssistant, m.is_assistant,
    m.isAutomated, m.automated, m.ai
  ];
  if (flags.some(isTruthy)) return true;

  const labels = Array.isArray(m.labels) ? m.labels : (Array.isArray(m.tags) ? m.tags : []);
  if (labels.map(normalize).some(l => AI_SENDER_HINTS.includes(l))) return true;

  const type = normalize(coalesce(m.msg_type, m.type));
  if (/(^|[._-])(ai|assistant)([._-]|$)/.test(type)) return true;
  if (/suggestion|draft|proposal/.test(type)) return true;

  return false;
}

function approvedAi(m) {
  // Booleans first
  if ([m.approved, m.is_approved, m.ai_approved, m.approval?.approved].some(isTruthy)) return true;

  // Status text across common fields
  const statuses = [
    m.ai_status, m.aiStatus, m.ai_message_status,
    m.status, m.state, m.delivery_status, m.approval_status
  ].map(normalize).filter(Boolean);
  if (statuses.some(s => APPROVED_STATUS_WORDS.some(w => s.includes(w)))) return true;

  // Direction + "left the building" timestamps
  const dir = normalize(coalesce(m.direction, m.message_direction));
  const sentish = [m.sent_at,m.sentAt,m.published_at,m.publishedAt,
                   m.posted_at,m.postedAt,m.delivered_at,m.deliveredAt].filter(Boolean);
  if (dir === "outbound" && sentish.length) return true;

  // Deliveries array with successful status
  if (Array.isArray(m.deliveries) &&
      m.deliveries.some(d => APPROVED_STATUS_WORDS.some(w => normalize(d?.status).includes(w)))) {
    return true;
  }

  return false;
}

function tsOf(m) {
  const picks = [
    m.sent_at, m.sentAt, m.delivered_at, m.deliveredAt,
    m.published_at, m.publishedAt, m.posted_at, m.postedAt,
    m.timestamp, m.ts, m.time, m.created_at, m.createdAt, m.updatedAt
  ];
  for (const t of picks) {
    const d = t ? new Date(t) : null;
    if (d && !isNaN(+d)) return d;
  }
  return null;
}

// ---------------- Role classification ----------------
function whoSent(m) {
  const moduleVal = normalize(coalesce(m.module, m.module_type));
  const msgType   = normalize(coalesce(m.msg_type, m.type));
  const by        = normalize(coalesce(m.by, m.senderType, m.sender_type, m.author?.role, m.author_role, m.role));
  const dir       = normalize(coalesce(m.direction, m.message_direction));

  // Internal/system items & notes
  if ((moduleVal === "note" || msgType === "note") && !by && !dir) return "internal";
  if (["system","automation","policy","workflow","webhook"].includes(by)) return "internal";

  // Explicit guest roles
  if (["guest","customer","user","visitor","end_user","end-user"].includes(by)) return "guest";

  // AI handling
  const isAI = looksLikeAI(m);
  if (isAI) {
    if (approvedAi(m) || COUNT_AI_AS_AGENT) return "agent";
    return "ai"; // suggestions/drafts ignored for SLA
  }

  // Non-AI: any non-guest sender is an agent
  if (by && !["guest","customer","user","visitor","end_user","end-user"].includes(by)) return "agent";

  // Fallback to direction
  if (dir === "inbound")  return "guest";
  if (dir === "outbound") return "agent";

  // Conservative default
  return "guest";
}

// ---------------- SLA evaluation ----------------
function evaluate(messages, now = new Date()) {
  const rows = messages
    .map(m => ({ m, role: whoSent(m), ts: tsOf(m) }))
    .filter(r => r.ts) // drop items without timestamps
    .sort((a,b) => a.ts - b.ts);

  // Ignore internal
  const visible = rows.filter(r => r.role !== "internal");

  // Find last guest message
  let lastGuestIdx = -1;
  for (let i=visible.length-1; i>=0; i--) {
    if (visible[i].role === "guest") { lastGuestIdx = i; break; }
  }
  if (lastGuestIdx === -1) {
    return { shouldAlert: false, reason: "no_guest_message" };
  }

  const lastGuest = visible[lastGuestIdx];

  // If any agent message exists after last guest, no alert
  for (let i=lastGuestIdx+1; i<visible.length; i++) {
    if (visible[i].role === "agent") {
      return { shouldAlert: false, reason: "agent_replied", lastGuestAt: lastGuest.ts.toISOString() };
    }
  }

  const elapsedMs = now - lastGuest.ts;
  const neededMs = SLA_MINUTES * 60 * 1000;

  if (elapsedMs >= neededMs) {
    return { shouldAlert: true, reason: "sla_breached", lastGuestAt: lastGuest.ts.toISOString(), minutesWaiting: Math.floor(elapsedMs/60000) };
  }

  return { shouldAlert: false, reason: "within_sla", lastGuestAt: lastGuest.ts.toISOString(), minutesWaiting: Math.floor(elapsedMs/60000) };
}

// ---------------- Input plumbing ----------------
function parseConversationFromEnv() {
  // 1) Direct JSON via CONVERSATION_INPUT
  const raw = env("CONVERSATION_INPUT","");
  if (raw) {
    // maybe it is a file path pointing to JSON
    try {
      if (fs.existsSync(raw)) {
        const txt = fs.readFileSync(raw, "utf8");
        return JSON.parse(txt);
      }
    } catch {}
    // otherwise parse as JSON string
    try {
      return JSON.parse(raw);
    } catch (e) {
      console.warn("CONVERSATION_INPUT provided but not valid JSON; ignoring.");
    }
  }

  // 2) GitHub repository_dispatch payload
  const eventName = process.env.GITHUB_EVENT_NAME;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventName === "repository_dispatch" && eventPath && fs.existsSync(eventPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(eventPath, "utf8"));
      const p = data.client_payload || {};
      const candidates = [
        p.conversation, p.conversationUrl, p.conversation_url,
        p.url, p.text, p.body, p.messages
      ].filter(v => typeof v === "object" && v);
      if (candidates.length) return candidates[0];
    } catch (e) {
      console.warn("Failed to parse GitHub event JSON:", e?.message);
    }
  }

  return null;
}

function extractMessages(conv) {
  if (!conv) return [];
  // Common shapes
  if (Array.isArray(conv)) return conv;                        // already an array of messages
  if (Array.isArray(conv.messages)) return conv.messages;      // { messages: [...] }
  if (conv.data && Array.isArray(conv.data.messages)) return conv.data.messages;

  // Some systems wrap conversation in { conversation: { messages: [...] } }
  if (conv.conversation && Array.isArray(conv.conversation.messages)) return conv.conversation.messages;

  // Fallback: if it "looks like" a single message object, wrap it
  if (typeof conv === "object" && (conv.text || conv.body || conv.role || conv.by)) {
    return [conv];
  }
  return [];
}

function extractConversationUrl(conv) {
  const url = coalesce(
    env("CONVERSATION_URL",""),
    conv?.conversationUrl, conv?.conversation_url,
    conv?.url, conv?.link, conv?.href
  );
  return url || "";
}

// ---------------- Email helpers ----------------
function escHtml(s="") {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// ---------------- Main ----------------
(async () => {
  const conversation = parseConversationFromEnv();
  const messages = extractMessages(conversation);
  const convoLink = extractConversationUrl(conversation);

  if (!messages.length) {
    console.log("No messages found in input. Nothing to evaluate.");
    process.exit(0);
  }

  const verdict = evaluate(messages);

  console.log("Verdict:", verdict);

  if (verdict.shouldAlert) {
    const subj = `⚠️ SLA alert: guest waiting ≥ ${SLA_MINUTES} min`;
    const linkHtml = convoLink ? `<p>Conversation: <a href="${escHtml(convoLink)}">${escHtml(convoLink)}</a></p>` : "";
    const bodyHtml = `<p>Guest appears unanswered for ≥ ${SLA_MINUTES} minutes.</p>` +
                     (verdict.lastGuestAt ? `<p>Last guest message at: ${escHtml(verdict.lastGuestAt)}</p>` : "") +
                     linkHtml;

    const bodyText = [
      `Guest appears unanswered for >= ${SLA_MINUTES} minutes.`,
      verdict.lastGuestAt ? `Last guest message at: ${verdict.lastGuestAt}` : "",
      convoLink ? `Conversation: ${convoLink}` : ""
    ].filter(Boolean).join("\n");

    const res = await sendAlert({ subject: subj, html: bodyHtml, text: bodyText });
    if (res?.sent) {
      console.log("✅ Alert email sent.");
    } else {
      console.log("Alert needed, but email not sent.", res);
    }
  } else {
    console.log("No alert sent. Reason:", verdict.reason);
  }
})().catch(e => {
  console.error(e);
  process.exit(1);
});
