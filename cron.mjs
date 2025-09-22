// --- auth + logging + email helpers ---
import { spawn } from "node:child_process";
import nodemailer from "nodemailer";
import { isDuplicateAlert, markAlerted, dedupeKey } from "./lib/dedupe.mjs";
import { selectTop50, assertTop50 } from "./src/lib/selectTop50.js";
import { appUrl } from "./lib/links.js";
import { mintUuidFromRaw } from "./apps/shared/lib/canonicalConversationUuid.js";
import { buildUniversalConversationLink } from "./lib/alertLink.js";
import { prisma } from "./lib/db.js";
import { isClosingStatement } from "./src/lib/isClosingStatement.js";
import { resolveConversationUuidHedged } from "./apps/shared/lib/conversationUuid.js";
import { extractSaleUuid, extractSaleUuidFromMessages } from "./lib/saleUuid.js";
import { buildGuestExperienceLink } from "./lib/guestExperienceLink.js";
import { trace, SpanStatusCode } from '@opentelemetry/api';
export { resolveViaInternalEndpoint } from "./lib/internalResolve.js";
const logger = console;
const metrics = { increment: () => {} };
const tracer = trace.getTracer('boom-sla-check');
// Assumes ESM. Node 18+ provides global fetch. If you're on older Node, ensure node-fetch is installed & imported.

// Accept a canonical UUID (v1–v5)
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

// Build a safe user-facing link: prefer deep link with UUID, else dashboard filters.
export function buildSafeDeepLink(lookupId, uuid) {
  const base = appUrl().replace(/\/+$/, "");
  const canonicalFromUuid = (value) => {
    const token = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!token || !UUID_RE.test(token)) return null;
    return `${base}/dashboard/guest-experience/all?conversation=${encodeURIComponent(token)}`;
  };
  const canonical = canonicalFromUuid(uuid);
  if (canonical) return canonical;
  const raw = String(lookupId ?? "").trim();
  if (!raw) return `${base}/dashboard/guest-experience/all`;
  try {
    const minted = mintUuidFromRaw(raw);
    const mintedCanonical = canonicalFromUuid(minted);
    if (mintedCanonical) return mintedCanonical;
  } catch {}
  return `${base}/go/c/${encodeURIComponent(raw)}`;
}

// ---------------------------
// Helpers: URL & normalization
// ---------------------------
function buildMessagesUrl(conversationId) {
  const base = process.env.MESSAGES_URL;
  if (!base) throw new Error("MESSAGES_URL is not set");
  if (base.includes("{{conversationId}}")) {
    return base.replace("{{conversationId}}", encodeURIComponent(conversationId));
  }
  // Avoid double-appending if caller configured a static conversation param
  if (/\bconversation(?:_id|Id)?=/i.test(base)) {
    return base;
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

const getTs = (m) => {
  const t =
    m?.timestamp ?? m?.ts ?? m?.created_at ?? m?.createdAt ??
    m?.sent_at ?? m?.sentAt ?? m?.time ?? null;
  const v = t ? Date.parse(t) : NaN;
  return Number.isFinite(v) ? v : 0;
};

export async function resolveSaleUuid(conversationId, fetchJson, context = {}) {
  const { messages, rawMessages, conversation } = context || {};

  const fromMessages = extractSaleUuidFromMessages(messages);
  if (fromMessages) return fromMessages;

  const fromRaw = extractSaleUuid(rawMessages, new Set());
  if (fromRaw) return fromRaw;

  const fromConversation = extractSaleUuid(conversation, new Set());
  if (fromConversation) return fromConversation;

  if (typeof fetchJson === "function") {
    try {
      const convId = conversationId != null ? String(conversationId) : "";
      const detail = await fetchJson(`/api/conversations/${encodeURIComponent(convId)}`);
      const fromDetail = extractSaleUuid(detail, new Set());
      if (fromDetail) return fromDetail;
    } catch {}
  }

  return null;
}

const makeFetchJson = (baseUrl, headers = {}) => {
  const base = (baseUrl || appUrl()).replace(/\/+$/, "");
  return async (path) => {
    if (typeof path !== "string" || !path) throw new Error("path must be a non-empty string");
    let target;
    try {
      target = new URL(path, `${base}/`).toString();
    } catch {
      target = `${base}${path.startsWith("/") ? "" : "/"}${path}`;
    }
    const res = await fetch(target, { headers, redirect: "manual" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (res.status === 204) return null;
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
};

// ---------------------------
// Helpers: fetch with retry
// ---------------------------
async function fetchMessagesWithRetry(conversationId, headers, { attempts = 3, baseDelayMs = 300 } = {}) {
  // Primary URL from env, plus safe fallbacks (same strategy as check.mjs)
  const primary = buildMessagesUrl(conversationId);
  const origin = (() => {
    try { return new URL(primary).origin; } catch {}
    try { return new URL(appUrl()).origin; } catch {}
    return "https://app.boomnow.com";
  })();
  const convUrl = `${origin}/api/conversations/${encodeURIComponent(conversationId)}/messages`;
  const ge1     = `${origin}/api/guest-experience/messages?conversation=${encodeURIComponent(conversationId)}`;
  const ge2     = `${origin}/api/guest-experience/messages?conversation_id=${encodeURIComponent(conversationId)}`;
  const isUuid  = UUID_RE.test(String(conversationId));
  const candidates = [primary, ...(isUuid ? [convUrl, ge1, ge2] : [ge1, ge2, convUrl])];

  let lastErr, lastStatus = 0, usedUrl = "";
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  for (const url of candidates) {
    usedUrl = url;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(url, { headers, redirect: "manual" });
        lastStatus = res.status;
        if (res.ok) {
          const json = await res.json().catch(() => ({}));
          const msgs = normalizeMessages(json);
          return { ok: true, url, status: res.status, messages: msgs, raw: json };
        }
        if (res.status >= 500 && res.status < 600) {
          lastErr = new Error(`HTTP ${res.status}`);
          const delay = baseDelayMs * Math.pow(2, i);
          await sleep(delay);
          continue;
        }
        // 4xx or other -> try next candidate
        break;
      } catch (e) {
        lastErr = e;
        if (i < attempts - 1) {
          const delay = baseDelayMs * Math.pow(2, i);
          await sleep(delay);
          continue;
        }
      }
    }
  }
  return { ok: false, url: usedUrl, status: lastStatus, error: lastErr };
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
export async function evaluateUnanswered(messages, now = new Date(), slaMin = 15) {
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

function pickNameLike(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const first = obj.first_name ?? obj.firstName ?? obj.given_name ?? obj.givenName ?? null;
  const last  = obj.last_name  ?? obj.lastName  ?? obj.family_name ?? obj.familyName ?? null;
  const full  = obj.full_name ?? obj.display_name ?? obj.displayName ?? obj.name ?? obj.username ?? null;
  const composed = `${first || ''} ${last || ''}`.trim();
  return composed || (full ? String(full).trim() : null);
}

function extractGuestName(source) {
  const messages = Array.isArray(source) ? source : normalizeMessages(source);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    const role = classifyMessage(m).role;
    if (role !== 'guest') continue;
    const name =
      pickNameLike(m.sender) ||
      pickNameLike(m.author) ||
      pickNameLike(m.from) ||
      m.sender_name || m.author_name || m.from_name || m.name;
    if (name && String(name).trim()) return String(name).trim();
  }
  return null;
}

function buildGuestLabel(source) {
  const guestName = extractGuestName(source);
  return guestName ? `Guest ${guestName}` : 'Guest';
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]
  ));
}

export const __cronTest__ = {
  pickNameLike,
  extractGuestName,
  buildGuestLabel,
  escapeHtml,
};
if (typeof globalThis.__CRON_TEST__ === 'undefined') {

const DEBUG  = !!process.env.DEBUG;
const log = (...a) => DEBUG && console.log(...a);

// email
async function sendAlertEmail({ to, subject, text, html }) {
  return tracer.startActiveSpan('alert.send', async (span) => {
    span.setAttribute('alert.recipient', String(to || ''));
    if (subject) span.setAttribute('alert.subject', String(subject));
    const host = process.env.SMTP_HOST;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    try {
      if (!to) {
        span.addEvent('alert.skip', { reason: 'missing_recipient' });
        console.warn("No ALERT_TO configured; skipping email");
        return;
      }
      if (!host || !user || !pass) {
        span.addEvent('alert.skip', { reason: 'missing_smtp_env' });
        console.warn("SMTP envs not fully set; skipping email");
        return;
      }
      const transporter = nodemailer.createTransport({ host, port: 587, secure: false, auth: { user, pass } });
      const result = await transporter.sendMail({ from: user, to, subject, text, html });
      span.addEvent('alert.sent');
      return result;
    } catch (error) {
      span.recordException?.(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error?.message || String(error) });
      throw error;
    } finally {
      span.end();
    }
  });
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

// fetch first two pages of the conversations list (≈30 per page)
const LIMIT_PARAM  = process.env.LIST_LIMIT_PARAM || "";   // e.g. "limit" or "per_page"
const OFFSET_PARAM = process.env.LIST_OFFSET_PARAM || "";  // e.g. "offset" or "page"
const PAGE_SIZE    = Number(process.env.PAGE_SIZE || 30);
const PAGES        = 2;

function authHeaders() {
  const h = { accept: "application/json" };
  if (process.env.BOOM_BEARER) h.authorization = `Bearer ${process.env.BOOM_BEARER}`;
  if (process.env.BOOM_COOKIE) h.cookie = process.env.BOOM_COOKIE;
  return h;
}

async function fetchListPage(pageIndex /* 0-based */) {
  const u = new URL(process.env.CONVERSATIONS_URL);
  if (LIMIT_PARAM)  u.searchParams.set(LIMIT_PARAM, String(PAGE_SIZE));
  if (OFFSET_PARAM) {
    const looksLikePage = /page/i.test(OFFSET_PARAM);
    u.searchParams.set(OFFSET_PARAM, String(looksLikePage ? (pageIndex + 1) : (pageIndex * PAGE_SIZE)));
  }
  const r = await fetch(u, { headers: authHeaders(), redirect: "manual" });
  const text = await r.text();
  let payload;
  try { payload = JSON.parse(text); } catch { return []; }
  return (
    payload?.payload?.data?.conversations ??
    payload?.data?.conversations ??
    payload?.conversations ?? []
  ).filter(Boolean);
}

const [page1, page2] = await Promise.all([fetchListPage(0), fetchListPage(1)]);
const conversationsRaw = [...page1, ...page2];
const idOf = (c) => String(c?.id ?? c?.conversation_id ?? c?.uuid ?? c?._id ?? "");
const conversations = Array.from(new Map(conversationsRaw.map(c => [idOf(c), c])).values());

/* update the default check window */
const CHECK_LIMIT = Number(process.env.CHECK_LIMIT || 60);

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
// Choose the most-recent window (default 60; overridable via env)
const selected = selectTop50(pool).slice(0, CHECK_LIMIT);
assertTop50(pool, selected, CHECK_LIMIT);
const newest = selected[0];
const oldest = selected[selected.length - 1];
console.log(`selected window: newest=${newest.id}@${newest.lastActivityAt}  oldest=${oldest.id}@${oldest.lastActivityAt}`);
console.log(`processing objectively newest ${CHECK_LIMIT} conversations`);
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

let checked = 0, alerted = 0, skippedCount = 0;
const skipped = [];
for (const { id } of toCheck) {
  if (alerted >= MAX_ALERTS_PER_RUN) break;
  const conv = byId.get(String(id));
  let msgs = [];
  let messagesRaw = null;
  let messageOrigin = null;
  let messageHeaders = null;
  if (conv && Array.isArray(conv.thread) && conv.thread.length) {
    msgs = conv.thread;
    log(`conv ${id}: using inline thread (${msgs.length} msgs)`);
  } else {
    // Prefer fetching by UUID when possible (numeric ids often 500 if the API requires a uuid)
    let idForFetch = id;
    if (!UUID_RE.test(String(idForFetch))) {
      try {
        const maybeUuid = await resolveConversationUuidHedged(String(idForFetch), { skipRedirectProbe: false });
        if (maybeUuid && UUID_RE.test(maybeUuid)) idForFetch = maybeUuid.toLowerCase();
      } catch {}
    }
    // NEW: try messages endpoint(s) instead of skipping
    const headers = authHeaders();
    messageHeaders = headers;
    const idsToTry = idForFetch === id ? [idForFetch] : [idForFetch, id];
    let r;
    for (const candidate of idsToTry) {
      r = await fetchMessagesWithRetry(candidate, headers);
      if (r.ok) break;
    }
    if (r?.ok) {
      msgs = r.messages;
      messagesRaw = r.raw || null;
      if (r.url) {
        try { messageOrigin = new URL(r.url).origin; } catch {}
      }
      console.log(`conv ${id}: fetched ${msgs.length} via ${r.url || "messages endpoint"}`);
    } else {
      const detail = r?.status ? `status ${r.status}` : (r?.error?.message || "unknown error");
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
      const uuid = await resolveConversationUuidHedged(lookupId, {
        inlineThread,
        fetchFirstMessage: async (idOrSlug) => {
          const headers = authHeaders();
          const r = await fetchMessagesWithRetry(idOrSlug, headers, { attempts: 1 });
          return r.ok ? r.messages[0] : null;
        },
        onDebug: (d) => logger?.debug?.({ convId, ...d }, 'uuid resolution attempted'),
      });

      const base = appUrl().replace(/\/+$/, "");
      const builderInput = {
        uuid: uuid || undefined,
        legacyId: conv?.legacyId ?? undefined,
        slug: typeof conv?.slug === "string" ? conv.slug : undefined,
      };
      const universal = await buildUniversalConversationLink(builderInput, {
        baseUrl: base,
        strictUuid: true,
        verify: async (href) => !/\/r\/t\//.test(href),
      });

      const fallbackCandidates = [];
      if (conv?.legacyId != null) fallbackCandidates.push(conv.legacyId);
      if (conv?.legacy_id != null) fallbackCandidates.push(conv.legacy_id);
      if (typeof conv?.slug === "string" && conv.slug.trim()) fallbackCandidates.push(conv.slug.trim());
      const convIdStr = conv?.id != null ? String(conv.id).trim() : "";
      if (convIdStr && !UUID_RE.test(convIdStr)) fallbackCandidates.push(convIdStr);
      const idStr = id != null ? String(id).trim() : "";
      if (idStr && !UUID_RE.test(idStr)) fallbackCandidates.push(idStr);
      const legacyIdOrSlug = fallbackCandidates.find((val) => val != null && String(val).trim().length > 0) ?? null;

      let conversationUuid = universal?.uuid || (UUID_RE.test(String(uuid ?? "")) ? String(uuid).toLowerCase() : null);
      let conversationUrl = conversationUuid
        ? buildSafeDeepLink(conversationUuid, conversationUuid)
        : null;
      let mintedLinkUsed = universal?.minted === true;

      if (!conversationUrl) {
        const fallbackLink = buildSafeDeepLink(legacyIdOrSlug, null);
        conversationUrl = fallbackLink;
        if (fallbackLink) {
          const match = fallbackLink.match(/conversation=([0-9a-f-]+)/i);
          if (match) {
            conversationUuid = match[1].toLowerCase();
            mintedLinkUsed = true;
          }
        }
      }

      if (!conversationUrl) {
        logger?.warn?.({ convId, input: builderInput, legacyIdOrSlug }, 'skip alert: unable to build canonical deep link');
        metrics?.increment?.('alerts.skipped_no_uuid');
        skipped.push(convId);
        skippedCount++;
        continue;
      }

      if (!conversationUuid) {
        const match = conversationUrl.match(/conversation=([0-9a-f-]+)/i);
        if (match) conversationUuid = match[1].toLowerCase();
      }

      if (mintedLinkUsed) {
        console.warn(`conv ${id}: conversation UUID unavailable; using minted deep link`);
      }

      const idDisplay =
        conversationUuid ||
        (conv?.legacyId != null ? String(conv.legacyId) : undefined) ||
        (typeof conv?.slug === "string" && conv.slug.trim()) ||
        (typeof lookupId === "string" ? lookupId : String(lookupId));

      const fetchBase = messageOrigin || base;
      const saleHeaders = messageHeaders || authHeaders();
      let saleUuid = null;
      let saleResolutionError = null;
      try {
        const fetchJson = makeFetchJson(fetchBase, saleHeaders);
        saleUuid = await resolveSaleUuid(convId, fetchJson, {
          messages: msgs,
          rawMessages: messagesRaw,
          conversation: conv,
        });
      } catch (err) {
        saleResolutionError = err;
        console.warn(`conv ${id}: sale UUID resolution failed:`, err?.message || err);
      }
      if (!saleUuid && !saleResolutionError) {
        const fallbackMsg = mintedLinkUsed
          ? 'using minted deep link'
          : 'using canonical deep link';
        console.warn(`conv ${id}: sale UUID unavailable; ${fallbackMsg}`);
      }
      const url = conversationUrl;
      const backupUrl = conversationUrl;
      const saleFallbackNoteHtml = saleUuid
        ? ""
        : "\n    <p style=\"font-size:12px;color:#666\">Sale UUID unavailable; using conversation filter fallback.</p>";
      const saleFallbackNoteText = saleUuid
        ? ""
        : "\nSale UUID unavailable; using conversation filter fallback.";
      const canonicalNoteHtml = `\n    <p style=\"font-size:12px;color:#666\">Canonical deep link:<br><a href=\"${backupUrl}\" target=\"_blank\" rel=\"noopener\">${backupUrl}</a></p>`;
      const canonicalNoteText = `\nCanonical deep link: ${backupUrl}`;

      console.log(
        `ALERT: conv=${id} guest_unanswered=${ageMin}m > ${SLA_MIN}m -> email ${mask(to) || "(no recipient set)"} link=${url} sale=${saleUuid || "fallback"}`
      );

      // simple dedupe by conversation + last guest message timestamp
      const { dup, state } = isDuplicateAlert(id, lastGuestMs);
      if (dup) {
        log(`conv ${id}: duplicate alert suppressed`);
      } else {
        const key = dedupeKey(id, lastGuestMs);
        const metricName = mintedLinkUsed
          ? 'alerts.sent_with_minted_link'
          : universal?.kind === 'token'
          ? 'alerts.sent_with_token_link'
          : universal?.kind === 'legacy'
          ? 'alerts.sent_with_legacy_shortlink'
          : 'alerts.sent_with_deep_link';
        try {
          metrics?.increment?.(metricName);
          const guestLabel = buildGuestLabel(messagesRaw || msgs);
          await sendAlertEmail({
            to,
            subject: `[Boom SLA] ${guestLabel} unanswered ${ageMin}m (> ${SLA_MIN}m) – conversation ${idDisplay}`,
            html: `
    <p><strong>${escapeHtml(guestLabel)}</strong> appears unanswered for ${ageMin} minutes (SLA ${SLA_MIN}m).</p>
    <p>Conversation: <strong>${idDisplay}</strong></p>
    <p><a href="${url}" target="_blank" rel="noopener">Open conversation</a></p>
    ${saleFallbackNoteHtml}
    ${canonicalNoteHtml}
  `,
            text: `${guestLabel} appears unanswered for ${ageMin} minutes (SLA ${SLA_MIN}m).
Conversation: ${idDisplay}
Open: ${url}
${saleFallbackNoteText}
${canonicalNoteText}`,
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
  logger.info({ skipped }, 'alerts skipped due to missing resolvable link');
}

}

