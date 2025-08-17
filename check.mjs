// check.mjs
// Boom SLA checker (REST approach)
// - Logs in using BOOM_USER / BOOM_PASS
// - Accepts ANY input: dashboard URL, API URL, UUID, or tracking/redirect link
// - Resolves to conversation id, fetches conversation JSON
// - If last guest message is older than SLA and no agent reply after it -> send alert email
// - Only changes vs your working version:
//     (1) accepts all URL types via normalizeInput()
//     (2) email includes both the input URL and a clickable conversation link

import nodemailer from "nodemailer";

// -----------------------------
// Env & inputs
// -----------------------------
const {
  BOOM_USER,
  BOOM_PASS,

  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,

  ALERT_TO,
  ALERT_CC,
  ALERT_FROM_NAME,

  // Optional: allow passing URLs in env for manual runs
  CONVERSATION_URLS,
  SLA_MINUTES,
} = process.env;

// GitHub Actions "workflow_call" or "workflow_dispatch" inputs arrive as envs
// prefixed with GITHUB_INPUT_. Keep existing names so it “just works”.
const inputUrls =
  process.env.GITHUB_INPUT_CONVERSATION_URLS ||
  CONVERSATION_URLS ||
  "";

const slaMinutes = Number(
  process.env.GITHUB_INPUT_SLA_MINUTES || SLA_MINUTES || 5
);

// -----------------------------
// Minimal utilities
// -----------------------------

const uuidRE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function splitUrls(s) {
  return s
    .split(/[\s,]+/g)
    .map((x) => x.trim())
    .filter(Boolean);
}

function pickFirst(...vals) {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return undefined;
}

function parseTs(any) {
  if (!any) return undefined;
  const t = new Date(any);
  return isNaN(t.getTime()) ? undefined : t;
}

function minutesBetween(a, b) {
  return Math.round((a.getTime() - b.getTime()) / 60000);
}

function getConversationIdFromString(str) {
  if (!str) return undefined;
  // Try direct match
  const m = String(str).match(uuidRE);
  if (m) return m[0];

  // Try decoding once (helps on percent-encoded params)
  try {
    const dec = decodeURIComponent(String(str));
    const m2 = dec.match(uuidRE);
    if (m2) return m2[0];
  } catch {/* ignore */}

  return undefined;
}

function getConversationIdFromUrl(u) {
  try {
    const m = String(u).match(uuidRE);
    return m ? m[0] : undefined;
  } catch {
    return undefined;
  }
}

// --- helper to turn any conversation URL into the human dashboard link (ADDED)
function toHumanUrl(u) {
  try {
    const url = new URL(u);
    const m = url.pathname.match(uuidRE);
    const id = m && m[0];
    if (!id) return u; // fallback
    return `${url.origin}/dashboard/guest-experience/sales/${id}`;
  } catch {
    return u;
  }
}

// very small cookie jar (no external deps)
function mergeSetCookies(existingCookieHeader, setCookieHeader) {
  const jar = new Map();
  const push = (line) => {
    if (!line) return;
    const first = line.split(";")[0]?.trim();
    const eq = first.indexOf("=");
    if (eq > 0) {
      const k = first.slice(0, eq).trim();
      const v = first.slice(eq + 1).trim();
      if (k && v) jar.set(k, v);
    }
  };
  if (existingCookieHeader) {
    existingCookieHeader.split(";").forEach((kv) => push(kv));
  }
  if (setCookieHeader) {
    setCookieHeader.split(/,(?=\s*\w+=)/).forEach((sc) => push(sc));
  }
  return Array.from(jar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

// JSON fetch that keeps a cookie header flowing
async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    redirect: "manual",
    ...opts,
    headers: {
      "accept": "application/json, text/plain, */*",
      ...opts.headers,
    },
  });

  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    const text = await res.text().catch(() => "");
    const msg = `Non-JSON response from ${url}`;
    throw new Error(msg + (text ? `: ${text.slice(0, 200)}` : ""));
  }

  return { res, json: await res.json() };
}

// -----------------------------
// Boom REST login
// -----------------------------
async function loginAndGetSession(origin, email, password) {
  const csrfUrl = `${origin}/sanctum/csrf-cookie`;
  const loginUrl = `${origin}/api/login`;

  // preflight CSRF (some tenants won’t set cookies here—just log and continue)
  let cookie = "";
  try {
    const pre = await fetch(csrfUrl, {
      method: "GET",
      redirect: "manual",
    });
    const setCookie = pre.headers.get("set-cookie");
    if (!setCookie) {
      console.log("CSRF preflight returned no Set-Cookie. Will attempt login anyway.");
    }
    cookie = mergeSetCookies(cookie, setCookie);
  } catch (e) {
    console.log("CSRF preflight failed quietly, proceeding to login.");
  }

  // login
  const { res, json } = await fetchJson(loginUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
    },
    body: JSON.stringify({ email, password, tenant_id: null }),
  });

  if (!res.ok) {
    throw new Error(`Login failed: HTTP ${res.status} ${JSON.stringify(json ?? {})}`);
  }

  const setCookie = res.headers.get("set-cookie");
  cookie = mergeSetCookies(cookie, setCookie);

  return { cookie, account: json };
}

// -----------------------------
// Conversation read
// -----------------------------
function apiUrlFromAny(origin, anyUrl) {
  // Accepts:
  //  - dashboard page: /dashboard/guest-experience/sales/:id
  //  - API URL:        /api/conversations/:id
  //  - UUID itself
  const id = getConversationIdFromString(anyUrl);
  if (!id) throw new Error(`Could not find conversation id in URL: ${anyUrl}`);
  return `${origin}/api/conversations/${id}`;
}

function guessOrigin(anyUrl) {
  try {
    const u = new URL(anyUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    // If it's a bare UUID, default origin is Boom
    return `https://app.boomnow.com`;
  }
}

function classifySender(msg) {
  const raw =
    (msg.sender_type ?? msg.senderType ?? msg.author_role ?? msg.role ?? msg.from_role ?? msg.sender ?? "").toString().toLowerCase();

  const src = (msg.source ?? msg.channel ?? msg.via ?? "").toString().toLowerCase();

  if (/agent|staff|teammate|operator/.test(raw)) return "agent";
  if (/guest|customer|user|visitor/.test(raw)) return "guest";
  if (/whatsapp/.test(src)) return "guest";
  if (/channel|web|sms|email/.test(src)) return "guest";

  const sys = (msg.type ?? msg.kind ?? "").toString().toLowerCase();
  if (/ai|suggestion|system/.test(sys)) return "ignore";

  if (msg.is_agent === true) return "agent";
  if (msg.is_agent === false) return "guest";

  return "guest";
}

function extractTimestamp(msg) {
  return (
    parseTs(msg.created_at) ||
    parseTs(msg.createdAt) ||
    parseTs(msg.ts) ||
    parseTs(msg.timestamp) ||
    undefined
  );
}

function sortByTsAsc(a, b) {
  return a.ts - b.ts;
}

function analyzeMessages(messages, now = new Date(), slaMin = 5) {
  const norm = [];
  for (const m of messages || []) {
    const sender = classifySender(m);
    if (sender === "ignore") continue;
    const ts = extractTimestamp(m);
    if (!ts) continue;
    norm.push({ sender, ts, raw: m });
  }

  if (!norm.length) {
    return { ok: true, reason: "no_timestamps" };
  }

  norm.sort(sortByTsAsc);

  const lastGuest = [...norm].reverse().find((x) => x.sender === "guest");
  if (!lastGuest) return { ok: true, reason: "no_guest" };

  const agentAfterGuest = [...norm]
    .reverse()
    .find((x) => x.sender === "agent" && x.ts > lastGuest.ts);

  if (agentAfterGuest) return { ok: true, reason: "agent_after_guest" };

  const minutes = minutesBetween(now, lastGuest.ts);
  if (minutes >= slaMin) {
    return {
      ok: false,
      reason: "guest_unanswered",
      minsSinceAgent: minutes,
      lastGuestTs: lastGuest.ts.toISOString(),
    };
  }

  return { ok: true, reason: "within_sla" };
}

// -----------------------------
// Mailer
// -----------------------------
function makeTransport() {
  const port = Number(SMTP_PORT || 587);
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });
}

async function sendAlertEmail({ subject, text, html }) {
  const fromName = ALERT_FROM_NAME || "Oaktree Boom SLA Bot";
  const transporter = makeTransport();

  const info = await transporter.sendMail({
    from: `${fromName} <${SMTP_USER}>`,
    to: ALERT_TO,
    cc: ALERT_CC || undefined,
    subject,
    text,
    html,
  });

  return info;
}

// -----------------------------
// NEW: normalize ANY input URL
//  - If it's a UUID: build API + human URLs
//  - If it's a UI/API URL: extract ID
//  - If it's a tracking/redirect link: follow redirect once to capture final URL, then extract ID
// -----------------------------
async function normalizeInput(originalUrl) {
  // 1) fast path: can we pull a UUID straight away?
  let id = getConversationIdFromString(originalUrl);
  let origin = guessOrigin(originalUrl);

  // 2) if no id and it looks like a URL, try to follow redirects
  if (!id) {
    try {
      const u = new URL(originalUrl);
      // Lightweight GET; just to follow redirects and get final URL.
      const res = await fetch(originalUrl, { method: "GET", redirect: "follow" });
      if (res.url) {
        id = getConversationIdFromString(res.url) || id;
        origin = guessOrigin(res.url) || origin;
      }
    } catch {
      // not a URL or redirect failed; keep going with what we have
    }
  }

  // 3) Build URLs if we have an id
  if (id) {
    const apiUrl = `${origin}/api/conversations/${id}`;
    const humanUrl = `${origin}/dashboard/guest-experience/sales/${id}`;
    return { id, apiUrl, humanUrl };
  }

  // 4) Fallback: we didn't find an id; use original as-is (will fail later with clear error)
  return { id: undefined, apiUrl: originalUrl, humanUrl: originalUrl };
}

// -----------------------------
// Main
// -----------------------------
async function main() {
  const urls = splitUrls(inputUrls);
  if (!urls.length) {
    throw new Error("No conversation_urls provided (workflow input).");
  }

  // Login once on Boom origin (we’ll infer from first usable URL or default)
  let boomOrigin = `https://app.boomnow.com`;

  // Pre-normalize first URL to capture origin if possible (does not change behavior)
  try {
    const norm0 = await normalizeInput(urls[0]);
    if (norm0.apiUrl) boomOrigin = guessOrigin(norm0.apiUrl);
  } catch {/* ignore */}

  const { cookie } = await loginAndGetSession(boomOrigin, BOOM_USER, BOOM_PASS);

  console.log(`Checking ${urls.length} conversation(s) @ SLA ${slaMinutes}m ...`);

  let anyAlert = false;

  for (const originalUrl of urls) {
    // NEW: accept all kinds of URL, resolve if needed, and derive API + human URLs
    const { id, apiUrl, humanUrl } = await normalizeInput(originalUrl);
    if (!id) throw new Error(`Could not find conversation id in: ${originalUrl}`);

    // Grab conversation JSON
    const { res, json } = await fetchJson(apiUrl, {
      method: "GET",
      headers: { cookie },
    });
    if (!res.ok) {
      throw new Error(`Conversation fetch failed: HTTP ${res.status}`);
    }

    // Try common JSON shapes
    const messages =
      json?.messages ??
      json?.data?.messages ??
      json?.conversation?.messages ??
      json?.items ??
      json;

    const status = analyzeMessages(messages, new Date(), slaMinutes);

    console.log("Second check result:", JSON.stringify(status, null, 2));

    if (!status.ok && status.reason === "guest_unanswered") {
      anyAlert = true;

      // Email includes BOTH the input URL and a clickable conversation link
      const subject = `⚠️ Boom SLA: guest unanswered ≥ ${slaMinutes}m`;
      const html =
        `<div>Guest appears unanswered for <b>${status.minsSinceAgent} minutes</b>.</div>
         <div style="margin:10px 0">
           <a href="${humanUrl}" target="_blank" rel="noopener noreferrer">🔗 Open conversation</a>
         </div>
         <div style="font:12px/1.4 monospace; color:#666">
           Input URL: ${originalUrl}
         </div>`;
      const text =
        `Guest appears unanswered for ${status.minsSinceAgent} minutes.\n` +
        `Open conversation: ${humanUrl}\n` +
        `Input URL: ${originalUrl}\n`;

      await sendAlertEmail({ subject, text, html });
      console.log("✅ Alert email sent.");
    } else {
      console.log("No alert sent (not guest/unanswered).");
    }
  }

  // Exit 0 always, since absence of alert is not an error.
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
