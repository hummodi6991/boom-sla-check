// check.mjs — Boom SLA (API, REST)
// Node 20+ (global fetch), ES module
import nodemailer from 'nodemailer';

/* ========= Inputs / Env ========= */
const BASE = process.env.BOOM_BASE || 'https://app.boomnow.com';

const BOOM_USER = process.env.BOOM_USER || process.env.BOOM_EMAIL;
const BOOM_PASS = process.env.BOOM_PASS;

const SLA_MIN = parseInt(
  process.env.SLA_MIN || process.env.INPUT_SLA_MIN || '5',
  10
);

// Accept conversation inputs from either Actions input or env
const RAW_CONV =
  process.env.INPUT_CONVERSATION_URLS ||
  process.env.CONVERSATION_URLS ||
  '';

const ALERT_TO = (process.env.ALERT_TO || '').trim();
const ALERT_CC = (process.env.ALERT_CC || '').trim();
const ALERT_FROM_NAME = process.env.ALERT_FROM_NAME || 'Oaktree Boom SLA Bot';

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;

/* ========= Utilities ========= */

function splitInputs(s) {
  return (s || '')
    .split(/\r?\n|,/)
    .map(t => t.trim())
    .filter(Boolean);
}

function isUuid(x) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    x
  );
}

// Accept ALL types: UI URLs, API URLs, or raw UUIDs
function toApiUrl(any) {
  const t = String(any).trim();

  // already an API endpoint?
  const mApi = t.match(/\/api\/conversations\/([0-9a-f-]{36})/i);
  if (mApi) return `${BASE}/api/conversations/${mApi[1]}`;

  // UI URL containing a UUID
  const mUi = t.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (mUi) return `${BASE}/api/conversations/${mUi[0]}`;

  // raw UUID
  if (isUuid(t)) return `${BASE}/api/conversations/${t}`;

  // As a last resort, return as-is (lets you pass an advanced API URL)
  return t;
}

// Build a nice UI URL for email (prefer the original if it looked like UI)
function toUiUrl(any) {
  const t = String(any).trim();

  // already a UI link? keep it
  if (/\/dashboard\/guest-experience\//i.test(t)) return t;

  // extract uuid from anything we can
  const uuid =
    (t.match(/\/api\/conversations\/([0-9a-f-]{36})/i)?.[1]) ||
    (t.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0]) ||
    (isUuid(t) ? t : null);

  // Fall back to sales view if not sure which segment; this was your prior usage
  return uuid ? `${BASE}/dashboard/guest-experience/sales/${uuid}` : t;
}

// Fetch that returns JSON or throws a rich error
async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    redirect: 'manual',
    ...opts
  });
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    const text = await res.text().catch(() => '');
    throw new Error(`Non-JSON response from ${url}\nStatus: ${res.status}\nBody: ${text.slice(0, 400)}`);
  }
  const json = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json).slice(0, 400)}`);
  return json;
}

// Extract cookie(s) from a response
async function fetchWithCookies(url, opts = {}, cookieJar = '') {
  const res = await fetch(url, {
    redirect: 'manual',
    headers: {
      ...(opts.headers || {}),
      ...(cookieJar ? { cookie: cookieJar } : {})
    },
    ...opts
  });

  const setCookie = res.headers.get('set-cookie') || '';
  const newJar = mergeCookies(cookieJar, setCookie);

  return { res, cookieJar: newJar };
}

function mergeCookies(existing, setCookieHeader) {
  const jar = new Map();

  function addFromHeader(h) {
    h.split(/,(?=[^ ;]+=)/).forEach(part => {
      const [kv] = part.split(';', 1);
      const [k, v] = kv.split('=');
      if (k && v) jar.set(k.trim(), v.trim());
    });
  }

  if (existing) {
    existing.split(/; */).forEach(p => {
      const [k, v] = p.split('=');
      if (k && v) jar.set(k.trim(), v.trim());
    });
  }

  if (setCookieHeader) addFromHeader(setCookieHeader);

  return Array.from(jar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/* ========= NEW: message normalization ========= */
/** Normalize Boom messages payload to a plain array */
function normalizeMessages(json) {
  // common wrappers
  const root =
    json?.messages ??
    json?.data?.messages ??
    json?.data ??
    json;

  if (Array.isArray(root)) return root;

  if (root && typeof root === 'object') {
    const candidates = ['items', 'results', 'list', 'rows', 'records', 'data'];
    for (const k of candidates) {
      if (Array.isArray(root[k])) return root[k];
    }
  }
  return [];
}

/* ========= Domain helpers ========= */

function getMessageTimestamp(m) {
  return (
    m?.created_at ||
    m?.inserted_at ||
    m?.sent_at ||
    m?.sentAt ||
    m?.timestamp ||
    m?.ts ||
    null
  );
}

function getSenderKind(m) {
  // try several shapes
  const t =
    m?.sender_type ||
    m?.senderType ||
    m?.author_type ||
    m?.authorType ||
    m?.role ||
    m?.sender?.type ||
    '';

  const lower = String(t).toLowerCase();
  if (lower.includes('guest') || lower.includes('customer') || lower.includes('tenant')) return 'Guest';
  if (lower.includes('agent') || lower.includes('staff') || lower.includes('admin')) return 'Agent';

  // fallbacks from heuristics
  if (m?.is_bot) return 'Agent';
  return 'Unknown';
}

function minsBetween(a, b) {
  return Math.floor((a - b) / 60000);
}

/* ========= Login & fetch ========= */

async function loginAndGetCookie() {
  // Some tenants require CSRF preflight; we try but continue even if missing
  try {
    const { res, cookieJar } = await fetchWithCookies(`${BASE}/sanctum/csrf-cookie`, {
      method: 'GET'
    });
    if (!res.headers.get('set-cookie')) {
      console.log('CSRF preflight returned no Set-Cookie. Will attempt login anyway.');
    }
    // proceed with whatever jar we have
    let jar = cookieJar;

    const body = JSON.stringify({
      email: BOOM_USER,
      password: BOOM_PASS,
      tenant_id: null
    });

    const { res: loginRes, cookieJar: jar2 } = await fetchWithCookies(`${BASE}/api/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: jar
      },
      body
    }, jar);

    // a successful login will usually set auth cookies; merge them
    const text = await loginRes.text();
    if (!loginRes.ok) {
      throw new Error(`Login failed: HTTP ${loginRes.status} ${text.slice(0, 300)}`);
    }
    // Return combined jar (csrf + auth)
    return jar2;
  } catch (err) {
    // best-effort fallback: try direct login once more
    console.log('CSRF preflight error, attempting direct login ...');
    const body = JSON.stringify({
      email: BOOM_USER,
      password: BOOM_PASS,
      tenant_id: null
    });
    const { res: loginRes, cookieJar } = await fetchWithCookies(`${BASE}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body
    });
    const text = await loginRes.text();
    if (!loginRes.ok) {
      throw new Error(`Login failed: HTTP ${loginRes.status} ${text.slice(0, 300)}`);
    }
    return cookieJar;
  }
}

async function fetchConversation(anyRef, cookieJar) {
  const apiUrl = toApiUrl(anyRef);
  const uiUrl = toUiUrl(anyRef);

  const { res } = await fetchWithCookies(
    apiUrl,
    {
      method: 'GET',
      headers: {
        accept: 'application/json',
        cookie: cookieJar
      }
    },
    cookieJar
  );

  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    const text = await res.text().catch(() => '');
    throw new Error(`Non-JSON response from ${apiUrl}\nStatus: ${res.status}\nBody: ${text.slice(0, 400)}`);
  }
  const json = await res.json();
  return { json, apiUrl, uiUrl };
}

/* ========= Email ========= */

async function sendAlertEmail({ minsSinceAgent, slaMin, uiUrl, apiUrl }) {
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465, // true for 465, false otherwise
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });

  const subject = `⚠️ Boom SLA: guest unanswered ≥ ${slaMin}m`;
  const linkForEmail = uiUrl || apiUrl;

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
      <p><strong>Guest appears unanswered ≥ ${slaMin} minutes.</strong></p>
      <p>Minutes since last agent reply: <strong>${minsSinceAgent}</strong></p>
      <p>Conversation: <a href="${linkForEmail}" target="_blank" rel="noopener noreferrer">${linkForEmail}</a></p>
      <hr>
      <p style="color:#666">Sent by ${ALERT_FROM_NAME}</p>
    </div>
  `;

  await transporter.sendMail({
    from: `"${ALERT_FROM_NAME}" <${SMTP_USER}>`,
    to: ALERT_TO,
    cc: ALERT_CC || undefined,
    subject,
    html
  });
}

/* ========= Main checker ========= */

async function analyze(messages, slaMin) {
  // sort by timestamp ascending (just in case)
  const rows = messages
    .map(m => ({ m, ts: new Date(getMessageTimestamp(m) || 0).getTime(), who: getSenderKind(m) }))
    .filter(r => r.ts && r.who !== 'Unknown')
    .sort((a, b) => a.ts - b.ts);

  if (rows.length === 0) {
    return { ok: true, reason: 'no_timestamps' };
  }

  const last = rows[rows.length - 1];
  // Only alert if the LAST message is Guest and no Agent replied within SLA minutes after it
  if (last.who === 'Guest') {
    // find last Agent message BEFORE now
    const lastAgent = [...rows].reverse().find(r => r.who === 'Agent');
    const minsSinceAgent = lastAgent ? minsBetween(Date.now(), lastAgent.ts) : Number.POSITIVE_INFINITY;
    if (minsSinceAgent >= slaMin) {
      return { ok: false, reason: 'guest_unanswered', minsSinceAgent };
    }
  }

  return { ok: true, reason: 'agent_last' };
}

async function run() {
  const inputs = splitInputs(RAW_CONV);
  if (inputs.length === 0) {
    throw new Error('No conversation_urls provided (workflow input).');
  }

  if (!BOOM_USER || !BOOM_PASS) {
    throw new Error('Missing BOOM_USER / BOOM_PASS.');
  }
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS || !ALERT_TO) {
    throw new Error('Missing SMTP_* or ALERT_TO env.');
  }

  console.log(`Checking ${inputs.length} conversation(s) @ SLA ${SLA_MIN}m ...`);

  const cookieJar = await loginAndGetCookie();

  for (const ref of inputs) {
    const { json, apiUrl, uiUrl } = await fetchConversation(ref, cookieJar);

    // ======== NEW: normalize to array here ========
    const messages = normalizeMessages(json);

    // Optional: debug when empty
    if (messages.length === 0) {
      console.log(
        'debug: messages array empty; top-level keys =',
        Object.keys(json || {})
      );
    }
    // ==============================================

    const verdict = await analyze(messages, SLA_MIN);
    console.log('Second check result:', JSON.stringify(verdict, null, 2));

    if (!verdict.ok && verdict.reason === 'guest_unanswered') {
      await sendAlertEmail({
        minsSinceAgent: verdict.minsSinceAgent,
        slaMin: SLA_MIN,
        uiUrl,
        apiUrl
      });
      console.log('✅ Alert email sent.');
    } else {
      console.log('No alert sent (not guest/unanswered).');
    }
  }
}

/* ========= Execute ========= */
run().catch(err => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
