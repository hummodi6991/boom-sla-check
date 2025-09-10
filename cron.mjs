// --- auth + logging + email helpers ---
import { spawn } from "node:child_process";
import nodemailer from "nodemailer";

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
  // Accept many shapes: array, {messages}, {thread}, {data:{messages|thread}}, {payload:{...}}, etc.
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  // common containers we see
  const candidates = [
    raw.messages,
    raw.thread,
    raw.data?.messages,
    raw.data?.thread,
    raw.payload?.messages,
    raw.payload?.thread,
    raw.payload?.data?.messages,
    raw.payload?.data?.thread,
    raw.result?.messages,
    raw.result?.thread,
  ].filter(Boolean);
  if (candidates.length) {
    const arr = candidates.find(Array.isArray);
    if (Array.isArray(arr)) return arr;
  }
  // some APIs wrap as {data:[...]}
  if (Array.isArray(raw.data)) return raw.data;
  // last resort: single object?
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
// Guest detection (robust-ish)
// ---------------------------
function isGuestLike(msg) {
  const roleish = firstDefined(
    msg.role, msg.author_role, msg.sender_role, msg.from_role,
    msg?.sender?.role, msg?.sender?.type, msg?.author?.role,
    msg?.from?.role, msg?.by?.role
  );
  const dir = (msg.direction || msg?.meta?.direction || "").toLowerCase();
  const isAI = Boolean(firstDefined(msg.is_ai, msg?.meta?.is_ai, msg?.sender?.is_ai));

  if (isAI) return false;
  if (dir === "inbound") return true;

  const val = String(roleish || "").toLowerCase();
  if (!val) return false;
  // common guest synonyms seen across providers
  const guestTokens = ["guest", "customer", "user", "end_user", "visitor", "client", "contact"];
  return guestTokens.includes(val);
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
async function sendAlertEmail({ to, subject, text }) {
  if (!to) { console.warn("No ALERT_TO configured; skipping email"); return; }
  const host = process.env.SMTP_HOST, user = process.env.SMTP_USER, pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) { console.warn("SMTP envs not fully set; skipping email"); return; }
  const transporter = nodemailer.createTransport({ host, port: 587, secure: false, auth: { user, pass } });
  await transporter.sendMail({ from: user, to, subject, text });
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

// map id -> conversation for quick lookup and build ids list
const idOf = (c) => String(c?.id ?? c?.conversation_id ?? c?.uuid ?? c?._id ?? "");
const byId = new Map(conversations.filter(Boolean).map(c => [idOf(c), c]));

let ids = [...collectIds(conversations)];
if (ids.length === 0) ids = conversations.map(idOf).filter(Boolean);
console.log(`unique=${ids.length}`);
log("sample IDs:", ids.slice(0, 5));
if (ids.length === 0) {
  console.log("No conversation IDs found. Check CONVERSATIONS_URL and auth (BOOM_BEARER/BOOM_COOKIE).");
  process.exit(0);
}

// throttle while debugging
const LIMIT = parseInt(process.env.CHECK_LIMIT || "0", 10);
if (LIMIT > 0 && ids.length > LIMIT) {
  ids = ids.slice(0, LIMIT);
  console.log(`debug limit: processing first ${LIMIT} conversations`);
}

console.log(`starting per-conversation checks: ${ids.length} ids (using inline thread when available)`);

const THRESH = parseInt(process.env.SLA_MINUTES || "15", 10);
const to = process.env.ALERT_TO || "";
const mask = (s) => s ? s.replace(/(.{2}).+(@.+)/, "$1***$2") : "";

const getTs = (m) => {
  const t = m?.timestamp ?? m?.created_at ?? m?.createdAt ?? m?.sent_at ?? m?.time ?? null;
  const v = t ? Date.parse(t) : NaN;
  return Number.isFinite(v) ? v : 0;
};

let checked = 0, alerted = 0, skipped = 0;
for (const id of ids) {
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
      skipped++;
      continue;
    }
  }

  // SLA calc
  const lastGuest = msgs.filter(isGuestLike).map(getTs).filter(Boolean).sort((a,b)=>b-a)[0] || 0;
  if (!lastGuest) { log(`conv ${id}: no guest messages found`); checked++; continue; }
  const ageMin = Math.floor((Date.now() - lastGuest) / 60000);

  if (ageMin > THRESH) {
    console.log(`ALERT: conv=${id} guest_wait=${ageMin}m > ${THRESH}m -> email ${mask(to) || "(no recipient set)"}`);
    try {
      await sendAlertEmail({
        to,
        subject: `[Boom SLA] Guest waiting ${ageMin}m (> ${THRESH}m) – conversation ${id}`,
        text: `Conversation ${id} has a guest waiting ${ageMin} minutes which exceeds the SLA of ${THRESH} minutes.\n\nPlease follow up.`,
      });
      alerted++;
    } catch (e) {
      console.warn(`conv ${id}: failed to send alert:`, e?.message || e);
    }
  } else {
    log(`conv ${id}: OK (guest_wait=${ageMin}m <= ${THRESH}m)`);
  }
  checked++;
}

console.log(`done: checked=${checked}, alerted=${alerted}, skipped=${skipped}`);

