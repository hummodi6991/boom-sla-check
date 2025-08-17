/* eslint-disable no-console */
//
// Boom SLA checker (REST)
// - Logs in with email/password (cookies/XSRF optional)
// - Fetches 1+ conversation API URLs
// - Robustly mines timestamps across many shapes/keys
// - Decides if last guest msg is unanswered >= SLA minutes
// - Sends email with a direct web link to the conversation
//
// Env:
//   BOOM_EMAIL, BOOM_PASSWORD               (required)
//   BOOM_LOGIN_URL                          (required; POST JSON)
//   BOOM_CSRF_URL                           (optional; GET cookie)
//   DISPATCH_CONVERSATION_URLS              (required via workflow input)
//   DISPATCH_SLA_MINUTES                    (optional; default 5)
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
//   ALERT_TO_DEFAULT, ALERT_FROM_NAME
//   DISPATCH_ALERT_TO                       (optional override)
//
const now = () => new Date();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const env = (k, d = undefined) => {
  const v = process.env[k];
  return v === undefined || v === "" ? d : v;
};

const BOOM_EMAIL = env("BOOM_EMAIL");
const BOOM_PASSWORD = env("BOOM_PASSWORD");
const BOOM_LOGIN_URL = env("BOOM_LOGIN_URL");
const BOOM_CSRF_URL = env("BOOM_CSRF_URL"); // optional

const RAW_URLS = env("DISPATCH_CONVERSATION_URLS", "").trim();
const SLA_MINUTES = Number(env("DISPATCH_SLA_MINUTES", "5"));
const ALERT_TO = env("DISPATCH_ALERT_TO") || env("ALERT_TO_DEFAULT");
const ALERT_FROM_NAME = env("ALERT_FROM_NAME", "Oaktree Boom SLA Bot");

// --- guardrails ----
if (!BOOM_EMAIL || !BOOM_PASSWORD || !BOOM_LOGIN_URL) {
  throw new Error("Missing BOOM_EMAIL / BOOM_PASSWORD / BOOM_LOGIN_URL env.");
}
if (!RAW_URLS) throw new Error("No conversation_urls provided (workflow input). {}");
if (!ALERT_TO) throw new Error("Missing ALERT_TO (or override)");

// Parse URLs list
const conversationUrls = RAW_URLS.split(/[\n,\s]+/).filter(Boolean);

// ---- very small cookie jar (enough for this flow) ----
const cookieJar = new Map();
const setCookieFromHeader = (setCookieHeader) => {
  if (!setCookieHeader) return;
  // Can be multi-value; normalize to array of strings
  const lines = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const line of lines) {
    const [pair] = line.split(";");
    const [name, ...rest] = pair.split("=");
    const value = rest.join("=");
    if (name && value !== undefined) cookieJar.set(name.trim(), value.trim());
  }
};
const buildCookieHeader = () =>
  Array.from(cookieJar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

// pull token from cookie if present
const xsrfHeader = () => {
  const raw = cookieJar.get("XSRF-TOKEN") || cookieJar.get("xsrf-token");
  if (!raw) return {};
  // XSRF-TOKEN may be URL-encoded
  try {
    const decoded = decodeURIComponent(raw);
    return { "X-XSRF-TOKEN": decoded };
  } catch {
    return { "X-XSRF-TOKEN": raw };
  }
};

// ---- login flow ----
async function doLogin() {
  if (BOOM_CSRF_URL) {
    const pre = await fetch(BOOM_CSRF_URL, { method: "GET", redirect: "manual" });
    setCookieFromHeader(pre.headers.get("set-cookie"));
    if (!cookieJar.size) {
      console.log("CSRF preflight returned no Set-Cookie. Will attempt login anyway.");
    }
  }
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    cookie: buildCookieHeader(),
    ...xsrfHeader(),
  };
  const body = JSON.stringify({ email: BOOM_EMAIL, password: BOOM_PASSWORD, tenant_id: null });
  const res = await fetch(BOOM_LOGIN_URL, { method: "POST", headers, body, redirect: "manual" });
  setCookieFromHeader(res.headers.get("set-cookie"));
  if (res.status === 401) throw new Error(`Login failed: HTTP 401`);
  if (res.status >= 400) throw new Error(`Login failed: HTTP ${res.status}`);
  // some backends return 204/200 with no JSON; that’s fine
  return true;
}

// ---- data fetch ----
async function fetchJson(url) {
  const headers = {
    accept: "application/json",
    cookie: buildCookieHeader(),
    ...xsrfHeader(),
  };
  const res = await fetch(url, { headers, redirect: "manual" });
  setCookieFromHeader(res.headers.get("set-cookie"));
  if (res.status === 401) throw new Error(`Unauthorized GET ${url}`);
  if (res.status >= 400) throw new Error(`HTTP ${res.status} GET ${url}`);
  const txt = await res.text();
  try {
    return JSON.parse(txt);
  } catch (e) {
    throw new Error(`Non-JSON response from ${url.substr(0, 120)}...`);
  }
}

// ---- timestamp + role mining (robust) ----
const TIME_KEYS = [
  "created_at", "createdAt", "created", "inserted_at", "insertedAt",
  "sent_at", "sentAt", "timestamp", "ts", "time", "date"
];
const SENDER_KEYS = [
  "sender", "senderType", "sender_type", "author", "authorType", "from",
  "fromType", "role", "userType", "direction", "via", "source", "type"
];

function normalizeEpochOrISO(v) {
  if (v == null) return null;
  if (typeof v === "number") {
    // seconds vs ms
    const ms = v > 1e12 ? v : v > 1e9 ? v * 1000 : v;
    const d = new Date(ms);
    return isNaN(d) ? null : d;
  }
  if (typeof v === "string") {
    // strip quotes or Z weirdness is fine with Date.parse
    const t = Date.parse(v);
    if (!isNaN(t)) return new Date(t);
    // sometimes string numeric
    if (/^\d{10,}$/.test(v)) return normalizeEpochOrISO(Number(v));
  }
  return null;
}

function classifyRole(obj) {
  // Try known fields
  for (const k of SENDER_KEYS) {
    if (obj && Object.hasOwn(obj, k)) {
      const val = (obj[k] ?? "");
      const s = typeof val === "string" ? val.toLowerCase() : JSON.stringify(val).toLowerCase();
      // guest-ish
      if (/(guest|customer|client|visitor|whatsapp|sms)/.test(s)) return "guest";
      // agent-ish
      if (/(agent|staff|human|team|support|cs|operator)/.test(s)) return "agent";
      // direction styles
      if (/incoming/.test(s)) return "guest";
      if (/outgoing/.test(s)) return "agent";
    }
  }
  // Sometimes nested: obj.author.role, obj.sender.type etc.
  for (const k of SENDER_KEYS) {
    const node = obj?.[k];
    if (node && typeof node === "object") {
      const nested = classifyRole(node);
      if (nested) return nested;
    }
  }
  return null; // unknown
}

function extractTime(obj) {
  for (const k of TIME_KEYS) {
    if (obj && Object.hasOwn(obj, k)) {
      const d = normalizeEpochOrISO(obj[k]);
      if (d) return d;
    }
  }
  // Sometimes nested time in obj.meta or obj.message
  if (obj?.meta && typeof obj.meta === "object") {
    const d = extractTime(obj.meta);
    if (d) return d;
  }
  if (obj?.message && typeof obj.message === "object") {
    const d = extractTime(obj.message);
    if (d) return d;
  }
  return null;
}

// A "message-like" object if it has either a sender-ish field or obvious content
function looksMessagey(o) {
  if (!o || typeof o !== "object") return false;
  for (const k of SENDER_KEYS) if (Object.hasOwn(o, k)) return true;
  if ("text" in o || "body" in o || "content" in o) return true;
  if ("type" in o && /message|msg/i.test(String(o.type))) return true;
  return false;
}

// Recursively mine arrays that appear to hold messages
function mineMessages(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) {
    for (const el of node) mineMessages(el, out);
    return out;
  }
  if (typeof node === "object") {
    // If this object is message-like, extract once
    if (looksMessagey(node)) {
      const t = extractTime(node);
      const who = classifyRole(node);
      if (t) out.push({ at: t, who, raw: node });
    }
    // Recurse into children
    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === "object") mineMessages(v, out);
    }
  }
  return out;
}

function pickLastByRole(items, role) {
  const filtered = items.filter((x) => x.who === role).sort((a, b) => a.at - b.at);
  return filtered.length ? filtered[filtered.length - 1] : null;
}

function computeStatus(items, slaMinutes) {
  const sorted = items.filter(Boolean).sort((a, b) => a.at - b.at);
  if (!sorted.length) {
    return { ok: true, reason: "no_timestamps" }; // nothing to evaluate
  }
  const last = sorted[sorted.length - 1];
  const lastGuest = pickLastByRole(sorted, "guest");
  const lastAgent = pickLastByRole(sorted, "agent");

  if (!lastGuest) return { ok: true, reason: "no_guest_messages" };
  if (lastAgent && +lastAgent.at > +lastGuest.at) {
    return { ok: true, reason: "agent_after_guest" };
  }

  const mins = Math.floor((now() - lastGuest.at) / 60000);
  if (mins >= slaMinutes) {
    return { ok: false, reason: "guest_unanswered", minsSinceAgent: mins };
  }
  return { ok: true, reason: "under_sla" };
}

// Build the human web URL from API URL (just strip `/api/` part)
function toHumanUrl(apiUrl) {
  try {
    const u = new URL(apiUrl);
    // api/conversations/<id>  ->  dashboard/guest-experience/sales/<id>
    // If you want a different area (support vs sales), adjust here:
    if (/\/api\/conversations\//.test(u.pathname)) {
      const id = u.pathname.split("/").pop();
      return `${u.origin}/dashboard/guest-experience/sales/${id}`;
    }
    // Fallback: return origin only
    return u.origin;
  } catch {
    return apiUrl;
  }
}

// ---- email ----
import nodemailer from "nodemailer";
async function sendEmail({ to, subject, html, text }) {
  const host = env("SMTP_HOST");
  const port = Number(env("SMTP_PORT", "587"));
  const user = env("SMTP_USER");
  const pass = env("SMTP_PASS");
  if (!host || !port || !user || !pass) throw new Error("SMTP env missing.");

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
  const from = `"${ALERT_FROM_NAME}" <${user}>`;
  const info = await transporter.sendMail({ from, to, subject, html, text });
  return info;
}

// ---- main ----
(async () => {
  console.log(`Checking ${conversationUrls.length} conversation(s) @ SLA ${SLA_MINUTES}m ...`);
  // Login
  await doLogin();

  let anyAlert = false;
  for (const url of conversationUrls) {
    const apiUrl = url.trim();
    const webUrl = toHumanUrl(apiUrl);
    const json = await fetchJson(apiUrl);

    const mined = mineMessages(json, []);
    const status = computeStatus(mined, SLA_MINUTES);

    console.log("Second check result:", JSON.stringify(status, null, 2));

    if (!status.ok && status.reason === "guest_unanswered") {
      anyAlert = true;
      const subj = `⚠️ Boom SLA: guest unanswered ≥ ${SLA_MINUTES}m`;
      const body = `
        <div>Guest appears unanswered for <b>${status.minsSinceAgent} minutes</b>.</div>
        <div style="margin-top:10px">
          <a href="${webUrl}" target="_blank" rel="noopener noreferrer">Open conversation</a>
        </div>
        <hr/>
        <pre style="font: 12px/1.4 monospace; white-space: pre-wrap">${apiUrl}</pre>
      `;
      await sendEmail({ to: ALERT_TO, subject: subj, html: body, text: `Guest appears unanswered ≥ ${SLA_MINUTES} minutes.\n${webUrl}\n\nAPI: ${apiUrl}` });
      console.log("✅ Alert email sent.");
    } else {
      console.log("No alert sent (", status.reason, ").");
    }
  }

  if (!anyAlert) {
    // succeed quietly
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
