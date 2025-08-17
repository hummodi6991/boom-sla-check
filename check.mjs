// check.mjs  — Boom SLA checker (REST)
// Node 20+ (native fetch). Requires nodemailer in package.json.

import nodemailer from 'nodemailer';

// ---------- config / inputs ----------
const BOOM_BASE = process.env.BOOM_BASE ?? 'https://app.boomnow.com';
const LOGIN_URL  = process.env.BOOM_LOGIN_URL ?? `${BOOM_BASE}/api/login`;
const CONV_API   = process.env.BOOM_CONV_API_PREFIX ?? `${BOOM_BASE}/api/conversations/`;

// Accept conversation urls/ids from GH Actions input or env
const RAW_INPUT =
  process.env.INPUT_CONVERSATION_URLS ??
  process.env.CONVERSATION_URLS ??
  process.env.CONVERSATIONS ??
  process.env.CONVERSATION_URL ?? '';

if (!RAW_INPUT.trim()) {
  console.error('Error: No conversation_urls provided (workflow input). {}');
  process.exit(1);
}

const SLA_MIN = Number(process.env.SLA_MINUTES || 5);

// SMTP / alerting
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const ALERT_TO  = process.env.ALERT_TO;
const ALERT_CC  = process.env.ALERT_CC || '';
const FROM_NAME = process.env.ALERT_FROM_NAME || 'Oaktree Boom SLA Bot';

// Boom credentials
const BOOM_EMAIL = process.env.BOOM_USER || process.env.EMAIL;
const BOOM_PASS  = process.env.BOOM_PASS || process.env.PASSWORD;

// ---------- tiny cookie jar ----------
let cookieJar = {};
function setCookiesFrom(res) {
  const set = res.headers.get('set-cookie');
  if (!set) return 0;
  // multiple cookies may be in a single header in Node, split conservatively
  const parts = set.split(/,(?=[^ ;]+=)/g);
  let added = 0;
  for (const p of parts) {
    const [kv] = p.split(';', 1);
    const [k, v] = kv.split('=');
    if (k && v != null) {
      cookieJar[k.trim()] = v.trim();
      added++;
    }
  }
  return added;
}
function cookieHeader() {
  return Object.entries(cookieJar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

// ---------- helpers ----------
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function parseConversations(input) {
  const items = input
    .split(/\r?\n|,|;|\s+/)
    .map(s => s.trim())
    .filter(Boolean);

  const results = [];
  for (const item of items) {
    let uuid = null;
    let uiUrl = null;
    let apiUrl = null;

    if (UUID_RE.test(item)) {
      uuid = (item.match(UUID_RE) || [null])[0];
      // If item is a URL, preserve it as the uiUrl
      if (/^https?:\/\//i.test(item) && !/\/api\//i.test(item)) uiUrl = item;
      if (/\/api\/conversations\//i.test(item)) apiUrl = item;
    } else if (/^https?:\/\//i.test(item)) {
      // Try to extract UUID from any Boom URL
      const m = item.match(UUID_RE);
      if (m) {
        uuid = m[0];
        if (/\/api\/conversations\//i.test(item)) apiUrl = item;
        else uiUrl = item;
      }
    }

    if (uuid) {
      if (!apiUrl) apiUrl = `${CONV_API}${uuid}`;
      if (!uiUrl)  uiUrl  = `${BOOM_BASE}/dashboard/guest-experience/sales/${uuid}`;
      results.push({ uuid, apiUrl, uiUrl });
    }
  }
  return results;
}

// normalize timestamps on messages
function msgTime(m) {
  const t =
    m?.timestamp ?? m?.ts ?? m?.created_at ?? m?.inserted_at ??
    m?.createdAt ?? m?.time ?? m?.date;
  return t ? new Date(t).getTime() : NaN;
}

// robust message extraction from multiple shapes
function extractMessages(conv) {
  if (!conv) return [];
  if (Array.isArray(conv.messages)) return conv.messages;
  if (conv.thread) {
    if (Array.isArray(conv.thread.messages)) return conv.thread.messages;
    if (Array.isArray(conv.thread.items))     return conv.thread.items;
  }
  if (Array.isArray(conv.thread_plus_dvr_log?.messages)) return conv.thread_plus_dvr_log.messages;
  if (Array.isArray(conv.thread_plus_dvr_log))           return conv.thread_plus_dvr_log;
  if (Array.isArray(conv.history))                       return conv.history;
  return [];
}

// classify guest vs agent; ignore AI suggestions/drafts for agent side
const isGuestMsg = (m) => {
  return (
    m?.sender_role === 'guest' ||
    m?.role === 'guest' ||
    m?.sender_type === 'guest' ||
    m?.author?.type === 'guest' ||
    m?.from_guest === true ||
    m?.direction === 'in' || m?.incoming === true ||
    m?.user_type === 'guest' ||
    (m?.user_id == null && (m?.guest_id != null || m?.guest === true))
  );
};

const isHumanAgentMsg = (m) => {
  const looksAgent =
    m?.sender_role === 'agent' || m?.role === 'agent' ||
    m?.sender_type === 'agent' || m?.author?.type === 'agent' ||
    m?.from_guest === false ||
    m?.direction === 'out' || m?.incoming === false ||
    m?.user_type === 'agent' || m?.user_id != null;

  const looksAISuggestion =
    m?.ai === true || m?.ai_suggestion === true || m?.suggested === true ||
    m?.is_draft === true || m?.draft === true ||
    m?.status === 'suggestion' || m?.kind === 'ai' ||
    m?.type === 'ai_suggestion' || m?.co_pilot_status || m?.ai_generation;

  return looksAgent && !looksAISuggestion;
};

function pickLast(arr, pred) {
  const filtered = arr.filter(pred).sort((a, b) => msgTime(b) - msgTime(a));
  return filtered[0] ?? null;
}

function textOf(m) {
  return (
    m?.text ?? m?.body ?? m?.message ?? m?.content ?? m?.snippet ?? ''
  ).toString();
}

function minutesSince(tsMs) {
  return Math.floor((Date.now() - tsMs) / 60000);
}

// ---------- HTTP ----------
async function csrfPreflight() {
  try {
    const url = `${BOOM_BASE}/sanctum/csrf-cookie`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      redirect: 'manual',
    });
    const added = setCookiesFrom(res);
    if (added === 0) {
      console.log('CSRF preflight returned no Set-Cookie. Will attempt login anyway.');
    }
  } catch (e) {
    console.log('CSRF preflight error ignored:', e?.message || e);
  }
}

function xsrfHeaderFromCookies() {
  // Laravel XSRF-TOKEN cookie is URL-decoded and sent in X-XSRF-TOKEN
  const raw = cookieJar['XSRF-TOKEN'];
  if (!raw) return {};
  try {
    const token = decodeURIComponent(raw);
    return { 'X-XSRF-TOKEN': token };
  } catch {
    return { 'X-XSRF-TOKEN': raw };
  }
}

async function login() {
  if (!BOOM_EMAIL || !BOOM_PASS) {
    throw new Error('Missing BOOM_USER/BOOM_PASS envs.');
  }
  const body = { email: BOOM_EMAIL, password: BOOM_PASS, tenant_id: null };
  const res = await fetch(LOGIN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...xsrfHeaderFromCookies(),
      'Cookie': cookieHeader(),
    },
    body: JSON.stringify(body),
    redirect: 'manual',
  });

  setCookiesFrom(res);

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Login failed: HTTP ${res.status} ${txt ? '- ' + txt.slice(0, 120) : ''}`);
  }
}

async function fetchJson(url) {
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'Cookie': cookieHeader(),
    },
  });
  setCookiesFrom(res);

  // Some endpoints may return HTML if session is invalid
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('json')) {
    throw new Error(`Non-JSON response from ${url}`);
  }
  return await res.json();
}

// ---------- email ----------
function buildTransport() {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !ALERT_TO) {
    throw new Error('SMTP/alert envs missing (SMTP_HOST/PORT/USER/PASS, ALERT_TO).');
  }
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465, // common default
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

async function sendAlert({ slaMin, minsSinceAgent, convoLink, snippet }) {
  const transporter = buildTransport();
  const toList = ALERT_TO.split(',').map(s => s.trim()).filter(Boolean);
  const ccList = ALERT_CC ? ALERT_CC.split(',').map(s => s.trim()).filter(Boolean) : [];

  const subject = `⚠️ Boom SLA: guest unanswered ≥ ${slaMin}m`;
  const html = `
    <div style="font-family:system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; line-height:1.45">
      <p><strong>Guest appears unanswered ≥ ${slaMin} minutes.</strong></p>
      <p><strong>Conversation:</strong> <a href="${convoLink}">${convoLink}</a></p>
      ${Number.isFinite(minsSinceAgent) ? `<p>Minutes since last human agent: <strong>${minsSinceAgent}</strong></p>` : ''}
      ${snippet ? `<blockquote style="border-left:4px solid #ddd; padding-left:10px; color:#555; white-space:pre-wrap;">${escapeHtml(snippet).slice(0,400)}</blockquote>` : ''}
    </div>`.trim();

  await transporter.sendMail({
    from: `"${FROM_NAME}" <${SMTP_USER}>`,
    to: toList,
    cc: ccList.length ? ccList : undefined,
    subject,
    html,
    text: `Guest appears unanswered ≥ ${slaMin} minutes.\nConversation: ${convoLink}\n` +
          (Number.isFinite(minsSinceAgent) ? `Minutes since last human agent: ${minsSinceAgent}\n` : '') +
          (snippet ? `\nLast guest message:\n${snippet.slice(0,400)}\n` : ''),
  });
}

function escapeHtml(s) {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

// ---------- main ----------
(async () => {
  const convs = parseConversations(RAW_INPUT);
  if (!convs.length) {
    console.error('Error: could not parse any conversation ids/urls from input.');
    process.exit(1);
  }

  await csrfPreflight();
  await login();

  console.log(`Checking ${convs.length} conversation(s) @ SLA ${SLA_MIN}m ...`);

  for (const c of convs) {
    const conv = await fetchJson(c.apiUrl);

    const messages = extractMessages(conv);
    if (!messages.length) {
      // helpful debug: show top-level keys so we can extend extractor easily
      const keys = Object.keys(conv || {});
      console.log(`debug: messages array empty; top-level keys = [\n  '${keys.join("',\n  '")}'\n]`);
      continue;
    }

    const lastGuest = pickLast(messages, isGuestMsg);
    const lastAgent = pickLast(messages, isHumanAgentMsg);

    if (!lastGuest) {
      // nothing from guest -> nothing to alert on
      logResult({
        ok: true,
        reason: 'no_guest_msgs',
        convoId: c.uuid,
        conversationLink: c.uiUrl
      });
      continue;
    }

    const tGuest = msgTime(lastGuest);
    const tAgent = lastAgent ? msgTime(lastAgent) : NaN;

    if (!Number.isFinite(tGuest)) {
      logResult({
        ok: true,
        reason: 'no_timestamps',
        convoId: c.uuid,
        conversationLink: c.uiUrl
      });
      continue;
    }

    const agentAfterGuest = Number.isFinite(tAgent) && tAgent >= tGuest;
    const minsSinceAgent = Number.isFinite(tAgent) ? minutesSince(tAgent) : null;
    const minsSinceGuest = minutesSince(tGuest);

    const shouldAlert =
      !agentAfterGuest && minsSinceGuest >= SLA_MIN;

    const result = {
      ok: !shouldAlert,
      reason: shouldAlert ? 'guest_unanswered' : (agentAfterGuest ? 'agent_last' : 'guest_recent'),
      minsSinceAgent,
      convoId: c.uuid,
      conversationLink: c.uiUrl,
      snippet: textOf(lastGuest).slice(0, 220)
    };

    logResult(result);

    if (shouldAlert) {
      await sendAlert({
        slaMin: SLA_MIN,
        minsSinceAgent,
        convoLink: c.uiUrl,
        snippet: textOf(lastGuest)
      });
      console.log('✅ Alert email sent.');
    } else {
      console.log('No alert sent (not guest/unanswered).');
    }
  }
})().catch(err => {
  console.error('Error:', err?.message || err);
  process.exit(1);
});

// pretty log like your previous runs
function logResult(obj) {
  const pretty = JSON.stringify(obj, null, 2);
  console.log('Second check result:', pretty);
}
