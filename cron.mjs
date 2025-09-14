// --- auth + logging + email helpers ---
import { spawn } from "node:child_process";
import nodemailer from "nodemailer";
import translate from "@vitalets/google-translate-api";
import { isDuplicateAlert, markAlerted, dedupeKey } from "./dedupe.mjs";
import { selectTop50, assertTop50 } from "./src/lib/selectTop50.js";
import { conversationDeepLinkFromUuid, conversationIdDisplay } from "./lib/links.js";
import { tryResolveConversationUuid } from "./apps/server/lib/conversations.js";
import { prisma } from "./lib/db.js";
const logger = console;
const metrics = { increment: () => {} };

// Assumes ESM. Node 18+ provides global fetch. If you're on older Node, ensure node-fetch is installed & imported.

// ---------------------------
// Helpers: URL & normalization
// ---------------------------
function buildMessagesUrl(conversationId) {
  const base = process.env.MESSAGES_URL;
  if (!base) throw new Error("MESSAGES_URL is not set");
  if (base.includes("{{conversationId}}")) {
    return base.replace("{{conversationId}}", encodeURIComponent(conversationId));
  }
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}conversation=${encodeURIComponent(conversationId)}`;
}

function firstDefined(...vals) {
  for (const v of vals) if (v !== undefined) return v;
  return undefined;
}

function normalizeMessages(raw) {
  // Accept many shapes: array, {messages}, {thread}, {data:{messages|thread}}, etc.
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  // common direct containers
  const candidates = [
    raw.messages,
    raw.thread,
    raw.items,
    raw.data?.messages,
    raw.data?.thread,
    raw.payload?.messages,
    raw.payload?.thread,
    raw.payload?.data?.messages,
    raw.payload?.data?.thread,
    raw.result?.messages,
    raw.result?.thread,
    // 👇 shapes we were missing
    raw.conversation?.messages,
    raw.data?.conversation?.messages,
  ].filter(Boolean);
  const arr = candidates.find(Array.isArray);
  if (Array.isArray(arr)) return arr;
  if (Array.isArray(raw.data)) return raw.data;
  // Deep fallback crawl – pick the first array that looks message-like
  const buckets = [];
  (function crawl(v){
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v) && v.some(x => x && typeof x === 'object' &&
      ('by' in x || 'text' in x || 'body' in x || 'sent_at' in x))) {
      buckets.push(v); return;
    }
    for (const k of Object.keys(v)) crawl(v[k]);
  })(raw);
  if (buckets.length) return buckets[0];
  return [];
}

// ---------------------------
// Helpers: fetch with retry
// ---------------------------
async function fetchMessagesWithRetry(conversationId, headers, { attempts = 3, baseDelayMs = 300 } = {}) {
  const url = buildMessagesUrl(conversationId);
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers, redirect: "manual" });
      if (res.ok) {
        const json = await res.json().catch(() => ({}));
        const msgs = normalizeMessages(json);
        return { ok: true, status: res.status, messages: msgs, raw: json };
      }
      // Retry on 5xx; otherwise stop
      if (res.status >= 500 && res.status < 600) {
        lastErr = new Error(`HTTP ${res.status}`);
      } else {
        return { ok: false, status: res.status };
      }
    } catch (e) {
      lastErr = e;
    }
    // backoff
    const delay = baseDelayMs * Math.pow(2, i);
    await new Promise(r => setTimeout(r, delay));
  }
  return { ok: false, error: lastErr };
}

// ---------------------------
// Roles & “unanswered” evaluation (ported from check.mjs)
// ---------------------------
function isGuestLike(msg) {
  const roleish = firstDefined(
    msg.role, msg.author_role, msg.sender_role, msg.from_role,
    msg?.sender?.role, msg?.sender?.type, msg?.author?.role,
    msg?.from?.role,
    // 👇 support flat strings like by: "guest" or senderType: "guest"
    msg.by, msg.senderType, msg.sender_type
  );
  const dir = String(firstDefined(
    msg.direction, msg.message_direction, msg?.meta?.direction
  ) || "").toLowerCase();
  const isAI = Boolean(firstDefined(msg.is_ai, msg?.meta?.is_ai, msg?.sender?.is_ai));

  if (isAI) return false;            // AI suggestions are not guests
  if (dir === "inbound") return true;

  const val = String(roleish || "").toLowerCase();
  if (!val) return false;
  const guestTokens = ["guest","customer","user","end_user","visitor","client","contact"];
  return guestTokens.includes(val);
}

// Classify sender (guest/agent/ai/internal)
function aiMessageStatus(m) {
  const status = String(m.ai_status || m.aiStatus || m.status || m.state || "").toLowerCase();
  if (/(approved|confirmed|sent|delivered|published|released)/.test(status)) return "approved";
  if (/(rejected|declined|discarded|canceled|cancelled|dismissed)/.test(status)) return "rejected";
  if (/(suggest|draft|pending|proposed|generated)/.test(status)) return "untouched";
  return "unknown";
}
function classifyMessage(m) {
  const by = String(firstDefined(
    m.by, m.senderType, m.sender_type, m.sender?.role, m.author?.role, m.author_role, m.role
  ) || "").toLowerCase();
  const dir = String(firstDefined(m.direction, m.message_direction) || "").toLowerCase();
  const isAI = !!firstDefined(m.generated_by_ai, m.is_ai_generated, m.is_ai, m.ai_generated);
  const ch  = String(firstDefined(m.channel, m.channel_type, m.channelName) || "").toLowerCase().replace(/[^a-z0-9]/g,"");
  if (ch === "aics") return { role: "agent", aiStatus: "approved" };
  if (/(system|automation|policy|workflow)/.test(by)) return { role: "internal", aiStatus: "none" };
  if (isAI) return { role: "ai", aiStatus: aiMessageStatus(m) };
  if (by && !/guest|customer|user/.test(by)) return { role: "agent", aiStatus: "none" };
  if (dir === "outbound") return { role: "agent", aiStatus: "none" };
  return { role: "guest", aiStatus: "none" };
}
function tsOf(m) {
  const t = firstDefined(m.sent_at, m.sentAt, m.created_at, m.createdAt, m.timestamp, m.ts, m.time);
  const d = t ? new Date(t) : null;
  return d && !isNaN(+d) ? d : null;
}
async function isClosingStatement(m) {
  const txt = String(firstDefined(m.body, m.text, m.message, m.content) || "").toLowerCase().trim();
  if (!txt) return false;
  if (/(thanks[^a-z0-9]{0,5})?(bye|goodbye|take care|cya|see\s+ya|later|cheers)[!. \s]*$/.test(txt)) return true;
  try {
    const res = await translate(txt, { to: "en" });
    return /(thanks[^a-z0-9]{0,5})?(bye|goodbye|take care|cya|see\s+ya|later|cheers)[!. \s]*$/.test((res?.text||"").toLowerCase());
  } catch { return false; }
}
async function evaluateUnanswered(messages, now = new Date(), slaMin = 15) {
  const list = (messages||[]).map(m => {
    const ts = tsOf(m); const { role, aiStatus } = classifyMessage(m);
    return ts ? { m, ts, role, aiStatus } : null;
  }).filter(Boolean).sort((a,b)=>a.ts-b.ts);
  if (!list.length) return { ok:true, reason:"empty" };
  let lastGuestTs = null;
  for (const item of list) {
    if (item.role === "internal") continue;
    if (item.role === "ai" && item.aiStatus !== "approved") continue;
    if (item.role === "guest") {
      if (!(await isClosingStatement(item.m))) lastGuestTs = item.ts;
    } else if (item.role === "agent" || item.role === "ai") {
      if (lastGuestTs && item.ts >= lastGuestTs) lastGuestTs = null;
    }
  }
  if (!lastGuestTs) return { ok:true, reason:"no_breach" };
  const diffMs = now - lastGuestTs;
  return diffMs >= slaMin*60000
    ? { ok:false, reason:"guest_unanswered", minsSinceAgent: Math.floor(diffMs/60000), lastGuestTs }
    : { ok:true, reason:"within_sla", minsSinceAgent: Math.floor(diffMs/60000), lastGuestTs };
}

const BEARER = process.env.BOOM_BEARER || "";
const COOKIE = process.env.BOOM_COOKIE || "";
const DEBUG  = !!process.env.DEBUG;
const log = (...a) => DEBUG && console.log(...a);

function authHeaders() {
  const h = { accept: "application/json" };
  if (BEARER) h.authorization = `Bearer ${BEARER}`;
  if (COOKIE) h.cookie = COOKIE;
  return h;
}

// email
async function sendAlertEmail({ to, subject, text, html }) {
  if (!to) { console.warn("No ALERT_TO configured; skipping email"); return; }
  const host = process.env.SMTP_HOST, user = process.env.SMTP_USER, pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) { console.warn("SMTP envs not fully set; skipping email"); return; }
  const transporter = nodemailer.createTransport({ host, port: 587, secure: false, auth: { user, pass } });
  await transporter.sendMail({ from: user, to, subject, text, html });
}

// Walk any JSON shape and collect plausible conversation IDs
function collectIds(obj, out = new Set()) {
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj)) {
    const key = k.toLowerCase();
    if (["conversationid", "conversation_id", "conv_id", "id"].includes(key)) {
      if (typeof v === "string" || typeof v === "number") out.add(String(v));
    }
    if (v && typeof v === "object") collectIds(v, out);
  }
  return out;
}

// fetch the conversations list
const res = await fetch(process.env.CONVERSATIONS_URL, {
  headers: authHeaders(),
  redirect: "manual",
});
const text = await res.text();
let payload;
try {
  payload = JSON.parse(text);
} catch (e) {
  console.error("Conversations endpoint did not return JSON. First 200 chars:\n", text.slice(0, 200));
  process.exit(0);
}
log("Top-level keys:", Object.keys(payload));

// prefer array at payload.data.conversations (falls back if layout differs)
const conversations =
  payload?.payload?.data?.conversations ??
  payload?.data?.conversations ??
  payload?.conversations ??
  [];

// conversations array is already defined above
// Ensure we process the most recent threads first (fallback to any timestamp we can find)
conversations.sort((a, b) => {
  const t = (o) =>
    Date.parse(
      o?.updated_at || o?.updatedAt ||
      o?.last_message_at || o?.lastMessageAt ||
      o?.modified_at || o?.modifiedAt ||
      o?.created_at || o?.createdAt || 0
    ) || 0;
  return t(b) - t(a);
});

// map id -> conversation for quick lookup
const idOf = (c) => String(c?.id ?? c?.conversation_id ?? c?.uuid ?? c?._id ?? "");
const byId = new Map(conversations.filter(Boolean).map(c => [idOf(c), c]));

function buildConversationPool() {
  return conversations.map(c => ({
    id: idOf(c),
    lastActivityAt: firstDefined(
      c?.updated_at, c?.updatedAt,
      c?.last_message_at, c?.lastMessageAt,
      c?.modified_at, c?.modifiedAt,
      c?.created_at, c?.createdAt
    )
  })).filter(x => x.id && x.lastActivityAt);
}

const pool = buildConversationPool();
console.log(`unique=${pool.length}`);
const sample = pool.slice(0, 5).map(x => `${x.id}@${x.lastActivityAt}`);
console.log(`sample (unsorted) peek:`, sample);
if (pool.length === 0) {
  console.log("No conversation IDs found. Check CONVERSATIONS_URL and auth (BOOM_BEARER/BOOM_COOKIE).");
  process.exit(0);
}
const selected = selectTop50(pool);
assertTop50(pool, selected);
const newest = selected[0];
const oldest = selected[selected.length - 1];
console.log(`selected window: newest=${newest.id}@${newest.lastActivityAt}  oldest=${oldest.id}@${oldest.lastActivityAt}`);
console.log(`processing objectively newest 50 conversations`);
const toCheck = selected;

console.log(`starting per-conversation checks: ${toCheck.length} ids (using inline thread when available)`);

// SLA threshold in minutes (now defaulting to 5)
const SLA_MIN = Number(process.env.SLA_MINUTES ?? 5);
const CRON_INTERVAL_MIN = Number(process.env.CRON_INTERVAL_MINUTES ?? 5);
const ALERT_TOL_MIN = Number(process.env.ALERT_TOLERANCE_MINUTES ?? 0.5); // small slack for drift
const RECENT_WINDOW_MIN = parseInt(process.env.RECENT_WINDOW_MIN || "720", 10); // ignore threads idle >12h
const MAX_ALERTS_PER_RUN = parseInt(process.env.MAX_ALERTS_PER_RUN || "5", 10);

function shouldAlert(nowMs, lastGuestMsgMs) {
  const ageMin = (nowMs - lastGuestMsgMs) / 60000;
  // Fire exactly once: when the age enters the SLA window for this run.
  return ageMin >= SLA_MIN && ageMin < SLA_MIN + CRON_INTERVAL_MIN + ALERT_TOL_MIN;
}

const to = process.env.ALERT_TO || "";
const mask = (s) => s ? s.replace(/(.{2}).+(@.+)/, "$1***$2") : "";

const getTs = (m) => {
  const t =
    m?.timestamp ?? m?.ts ?? m?.created_at ?? m?.createdAt ??
    m?.sent_at ?? m?.sentAt ?? m?.time ?? null;
  const v = t ? Date.parse(t) : NaN;
  return Number.isFinite(v) ? v : 0;
};

let checked = 0, alerted = 0, skippedCount = 0;
const skipped = [];
for (const { id } of toCheck) {
  if (alerted >= MAX_ALERTS_PER_RUN) break;
  const conv = byId.get(String(id));
  let msgs = [];
  if (conv && Array.isArray(conv.thread) && conv.thread.length) {
    msgs = conv.thread;
    log(`conv ${id}: using inline thread (${msgs.length} msgs)`);
  } else {
    // NEW: try messages endpoint instead of skipping
    const headers = authHeaders();
    const r = await fetchMessagesWithRetry(id, headers);
    if (r.ok) {
      msgs = r.messages;
      console.log(`conv ${id}: fetched ${msgs.length} via messages endpoint`);
    } else {
      const detail = r.status ? `status ${r.status}` : (r.error?.message || "unknown error");
      console.warn(`conv ${id}: no inline thread; messages fetch failed (${detail}); skipping`);
      skippedCount++;
      continue;
    }
  }

  // Make inline thread available to the resolver (prevents ReferenceError).
  // We only add keys that the resolver knows how to read.
  const inlineThread = { messages: Array.isArray(msgs) ? msgs : [] }; // ensure in-scope

  // Skip very stale threads entirely
  const newestTs = Math.max(...msgs.map(getTs).filter(Boolean));
  const newestAgeMin = Number.isFinite(newestTs) ? Math.floor((Date.now()-newestTs)/60000) : Infinity;
  if (newestAgeMin > RECENT_WINDOW_MIN) { checked++; continue; }

  // Proper unanswered evaluation
  const result = await evaluateUnanswered(msgs, new Date(), SLA_MIN);
  if (!result.ok && result.reason === "guest_unanswered") {
    const ageMin = result.minsSinceAgent ?? SLA_MIN;
    const lastGuestMs = result.lastGuestTs || Date.parse(conv?.last_guest_message_at || conv?.lastGuestMessageAt || 0);
    if (!Number.isFinite(lastGuestMs) || shouldAlert(Date.now(), lastGuestMs)) {

      // Build a universal conversation link
      const lookupId = conv?.uuid ?? conv?.id ?? id;
      const convId = id;
      const uuid = await tryResolveConversationUuid(lookupId, {
        inlineThread,
        onDebug: (d) => logger?.debug?.({ convId, ...d }, 'uuid resolution attempted'),
      });

      if (!uuid) {
        logger?.warn?.({ convId }, 'skip alert: cannot resolve conversation UUID');
        metrics?.increment?.('alerts.skipped_missing_uuid');
        skipped.push(convId);
        skippedCount++;
        continue; // do not send without a working link
      }

      const url = conversationDeepLinkFromUuid(uuid);
      const idDisplay = conversationIdDisplay({ uuid, id: lookupId });

      console.log(
        `ALERT: conv=${id} guest_unanswered=${ageMin}m > ${SLA_MIN}m -> email ${mask(to) || "(no recipient set)"} link=${url}`
      );

      // simple dedupe by conversation + last guest message timestamp
      const { dup, state } = isDuplicateAlert(id, lastGuestMs);
      if (dup) {
        log(`conv ${id}: duplicate alert suppressed`);
      } else {
        const key = dedupeKey(id, lastGuestMs);
        try {
          await sendAlertEmail({
            to,
            subject: `[Boom SLA] Unanswered ${ageMin}m (> ${SLA_MIN}m) – conversation ${idDisplay}`,
            html: `
    <p>Latest guest message appears unanswered for ${ageMin} minutes (SLA ${SLA_MIN}m).</p>
    <p>Conversation: <strong>${idDisplay}</strong></p>
    <p><a href="${url}" target="_blank" rel="noopener">Open conversation</a></p>
    <p style="font-size:12px;color:#666">If the link doesn’t work, copy & paste this URL:<br>${url}</p>
  `,
            text: `Latest guest message appears unanswered for ${ageMin} minutes (SLA ${SLA_MIN}m).
Conversation: ${idDisplay}
Open: ${url}`,
          });
          markAlerted(state, id, lastGuestMs);
          log(`dedupe_key=${key}`);
          alerted++;
        } catch (e) {
          console.warn(`conv ${id}: failed to send alert:`, e?.message || e);
        }
      }
    }
  } else {
    log(`conv ${id}: OK (${result.reason}${typeof result.minsSinceAgent === 'number' ? `, wait=${result.minsSinceAgent}m` : ''})`);
  }
  checked++;
}

console.log(`done: checked=${checked}, alerted=${alerted}, skipped=${skippedCount}`);

if (skipped.length) {
  logger.info({ skipped }, 'alerts skipped due to missing UUID');
}

