import { spawn } from 'child_process';

const env = (k, d = '') => (process.env[k] ?? d).toString().trim();

// --- auth + logging helpers ---
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

const CONVERSATIONS_URL = env('CONVERSATIONS_URL');
const LIST_SORT_FIELD = env('LIST_SORT_FIELD', 'updatedAt');
const LIST_SORT_ORDER_RECENT = env('LIST_SORT_ORDER_RECENT', 'desc');
const LIST_SORT_ORDER_BACKFILL = env('LIST_SORT_ORDER_BACKFILL', 'asc');
const LIST_LIMIT_PARAM = env('LIST_LIMIT_PARAM', 'limit');
const LIST_OFFSET_PARAM = env('LIST_OFFSET_PARAM', 'offset');

const CHECK_RECENT_COUNT = Number(env('CHECK_RECENT_COUNT', '250'));
const BACKFILL_PER_RUN = Number(env('BACKFILL_PER_RUN', '200'));
const BACKFILL_CONCURRENCY = Number(env('BACKFILL_CONCURRENCY', '2'));
const TOTAL_CONVERSATIONS_ESTIMATE = Number(env('TOTAL_CONVERSATIONS_ESTIMATE', '7000'));
const MAX_CONCURRENCY = Number(env('MAX_CONCURRENCY', '8'));
const NO_SKIP = env('NO_SKIP', '');

function buildListUrl(base, {limit, offset, sortField, order}) {
  const u = new URL(base);
  if (limit != null) u.searchParams.set(LIST_LIMIT_PARAM, String(limit));
  if (offset != null) u.searchParams.set(LIST_OFFSET_PARAM, String(offset));
  if (sortField) u.searchParams.set('sort', sortField);
  if (order) u.searchParams.set('order', order);
  return u.toString();
}

async function fetchIds(url) {
  const res = await fetch(url, {
    headers: authHeaders(),
    redirect: 'manual',
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

  const ids = [...collectIds(payload)];
  console.log(`unique=${ids.length}`);
  log("sample IDs:", ids.slice(0, 5));
  if (ids.length === 0) {
    console.log("No conversation IDs found. Check CONVERSATIONS_URL and auth (BOOM_BEARER/BOOM_COOKIE).\n");
    process.exit(0);
  }
  return ids;
}

function runCheck(id) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [new URL('./check.mjs', import.meta.url).pathname], {
      stdio: 'inherit',
      env: { ...process.env, CONVERSATION_INPUT: id }
    });
    child.on('exit', code => resolve({ id, ok: code === 0 }));
  });
}

async function runWithConcurrency(items, limit) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => (async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      const id = items[idx];
      const res = await runCheck(id);
      results.push(res);
    }
  })());
  await Promise.all(workers);
  return results;
}

(async () => {
  if (!CONVERSATIONS_URL) {
    console.error('CONVERSATIONS_URL is required');
    process.exit(1);
  }

  const recentUrl = buildListUrl(CONVERSATIONS_URL, {
    limit: CHECK_RECENT_COUNT,
    offset: 0,
    sortField: LIST_SORT_FIELD,
    order: LIST_SORT_ORDER_RECENT
  });

  const intervalMin = Number(env('CRON_INTERVAL_MIN', '5'));
  const seq = Math.floor(Date.now() / (intervalMin * 60 * 1000));
  const startOffset = (seq * BACKFILL_PER_RUN) % Math.max(BACKFILL_PER_RUN, TOTAL_CONVERSATIONS_ESTIMATE);

  const backfillUrl = buildListUrl(CONVERSATIONS_URL, {
    limit: BACKFILL_PER_RUN,
    offset: startOffset,
    sortField: LIST_SORT_FIELD,
    order: LIST_SORT_ORDER_BACKFILL
  });

  const recentIds = await fetchIds(recentUrl);
  const backfillIdsRaw = await fetchIds(backfillUrl);

  const recentSet = new Set(recentIds);
  const backfillIds = backfillIdsRaw.filter(id => !recentSet.has(id));

  console.log(`recent=${recentIds.length}, backfill=${backfillIds.length}, unique=${recentIds.length + backfillIds.length}`);

  const recentRes = await runWithConcurrency(recentIds, MAX_CONCURRENCY);
  const backfillRes = await runWithConcurrency(backfillIds, BACKFILL_CONCURRENCY);

  if (NO_SKIP === 'fail') {
    const failed = recentRes.concat(backfillRes).filter(r => !r.ok).map(r => r.id);
    if (failed.length) {
      console.error('Unverified conversations:', failed.join(','));
      process.exit(1);
    }
  }
})();

