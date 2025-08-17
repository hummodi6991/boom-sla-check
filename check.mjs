// check.mjs  — Boom SLA checker (REST)
// Node 20+ required (global fetch). One dependency: nodemailer.
// Env / Inputs expected (with sensible fallbacks):
//   INPUT_CONVERSATION_URLS or CONVERSATION_URLS  -> comma/newline/space separated list of URLs
//   INPUT_SLA_MINUTES or SLA_MINUTES              -> integer, default 5
//   BOOM_USER or LOGIN_EMAIL                      -> Boom login email
//   BOOM_PASS or LOGIN_PASSWORD                   -> Boom login password
//   ALERT_TO                                      -> comma-separated recipients
//   ALERT_CC (optional)                           -> comma-separated cc
//   ALERT_FROM_NAME (optional)                    -> display name in From
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS    -> SMTP settings for sending mail
//
// Exit codes:
//   0 -> finished (alert may or may not be sent)
//   1 -> configuration or hard failure

import nodemailer from "nodemailer";

// ---------- small utils ----------
const nowUtcMs = () => Date.now();

function readEnv(...names) {
  for (const n of names) {
    const v = process.env[n];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

function parseUrlList(raw) {
  if (!raw) return [];
  return raw
    .split(/[\n,\s]+/g)
    .map(s => s.trim())
    .filter(Boolean);
}

// Extract a UUID if present, then derive both the API and the human page links.
function deriveLinks(inputUrl) {
  try {
    const u = new URL(inputUrl);
    const idMatch = u.pathname.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    const id = idMatch ? idMatch[0] : null;

    const api =
      /\/api\/conversations\//i.test(u.pathname)
        ? inputUrl
        : (id ? `${u.origin}/api/conversations/${id}` : inputUrl);

    const page =
      /\/dashboard\//i.test(u.pathname)
        ? inputUrl
        : (id ? `${u.origin}/dashboard/guest-experience/sales/${id}` : inputUrl);

    return { api, page, id };
  } catch {
    return { api: inputUrl, page: inputUrl, id: null };
  }
}

function minutesBetween(msA, msB) {
  return Math.floor(Math.abs(msA - msB) / 60000);
}

function toInt(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

// Very small cookie jar for fetch
class CookieJar {
  constructor() { this.map = new Map(); }
  // store all cookies keyed by name
  storeFrom(setCookieHeaders = []) {
    for (const line of setCookieHeaders) {
      const [kv] = line.split(";"); // name=value; Path=/; HttpOnly...
      const [name, ...rest] = kv.split("=");
      this.map.set(name.trim(), rest.join("=").trim());
    }
  }
  header() {
    if (this.map.size === 0) return undefined;
    const parts = [];
    for (const [k, v] of this.map) parts.push(`${k}=${v}`);
    return parts.join("; ");
  }
}

// fetch wrapper that keeps cookies and can add headers easily
async function fetchJson(url, opts = {}, jar) {
  const headers = Object.assign(
    { "accept": "application/json, text/plain, */*" },
    opts.headers || {}
  );
  const cookie = jar?.header();
  if (cookie) headers["cookie"] = cookie;

  const res = await fetch(url, { ...opts, headers });
  // capture set-cookie
  const setCookie = res.headers.getSetCookie?.() || res.headers.raw?.()["set-cookie"] || [];
  if (jar && setCookie.length) jar.storeFrom(setCookie);

  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    // Some endpoints return 204 or text; try to JSON parse anyway
    const text = await res.text();
    try { return { res, json: JSON.parse(text) }; }
    catch {
      throw new Error(`Non-JSON response from ${url}`);
    }
  }
  const json = await res.json();
  return { res, json };
}

// ---------- Boom-specific API helpers ----------
async function loginBoom({ base, email, password }) {
  const jar = new CookieJar();

  // Some installations use a CSRF preflight (Laravel Sanctum style).
  // Not all environments set a cookie here; we tolerate that.
  const csrfCandidates = [
    `${base}/sanctum/csrf-cookie`,
    `${base}/api/csrf`,
  ];
  for (const u of csrfCandidates) {
    try {
      const res = await fetch(u, { method: "GET" });
      const setCookie = res.headers.getSetCookie?.() || res.headers.raw?.()["set-cookie"] || [];
      if (setCookie.length) jar.storeFrom(setCookie);
      else console.log("CSRF preflight returned no Set-Cookie. Will attempt login anyway.");
      break; // try only the first reachable endpoint
    } catch {
      // ignore and continue to login
    }
  }

  const body = { email, password, tenant_id: null };
  const { res, json } = await fetchJson(`${base}/api/login`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      // Pass whatever cookie we have; Boom may also return a token here
    }
  }, jar);

  if (!res.ok) {
    throw new Error(`Login failed: HTTP ${res.status}`);
  }

  let bearer;
  // Prefer explicit token if present
  if (json && (json.token || json.access_token)) {
    bearer = `Bearer ${json.token || json.access_token}`;
  }

  return { jar, bearer };
}

async function getConversation({ base, apiUrl, auth }) {
  // Ensure we hit the API form
  const { api } = deriveLinks(apiUrl);
  const headers = {};
  const cookie = auth.jar.header();
  if (cookie) headers["cookie"] = cookie;
  if (auth.bearer) headers["authorization"] = auth.bearer;

  const { res, json } = await fetchJson(api, { method: "GET", headers }, auth.jar);
  if (!res.ok) {
    throw new Error(`Fetch conversation failed: HTTP ${res.status}`);
  }
  return json;
}

// Normalize Boom message shapes into {role: 'guest'|'agent'|'system', tsMs: number}
function normalizeMessages(payload) {
  // Try common locations
  const candidates = [
    payload?.messages,
    payload?.data?.messages,
    payload?.data,
  ].filter(Array.isArray);

  const list = candidates[0] || [];
  const out = [];

  const toTs = (obj) => {
    const v =
      obj?.created_at ?? obj?.createdAt ??
      obj?.inserted_at ?? obj?.ts ?? obj?.timestamp ?? obj?.sent_at;
    if (!v) return undefined;
    // support ISO strings or numbers
    const ms = typeof v === "number" ? v * (v < 2e12 ? 1000 : 1) : Date.parse(v);
    return Number.isFinite(ms) ? ms : undefined;
  };

  const toRole = (obj) => {
    const s =
      (obj?.sender_type || obj?.senderType || obj?.author_type || obj?.authorType ||
        obj?.from_type || obj?.fromType || obj?.role || "").toString().toLowerCase();

    if (/(guest|customer|visitor|whatsapp|sms)/.test(s)) return "guest";
    if (/(agent|user|staff|employee|operator)/.test(s)) return "agent";

    // Sometimes the API uses booleans:
    if (obj?.is_guest === true) return "guest";
    if (obj?.is_agent === true) return "agent";

    // Fallback: treat unknown as 'guest' only if flagged, else 'system'
    return "system";
  };

  for (const m of list) {
    const tsMs = toTs(m);
    const role = toRole(m);
    if (tsMs) out.push({ role, tsMs });
  }
  // sort asc
  out.sort((a, b) => a.tsMs - b.tsMs);
  return out;
}

function evaluateSLA(messages, slaMinutes) {
  if (!messages.length) {
    return { ok: true, reason: "no_messages" };
  }
  const last = messages[messages.length - 1];
  // Find last agent and last guest timestamps
  let lastAgent, lastGuest;
  for (let i = messages.length - 1; i >= 0; i--) {
    const r = messages[i].role;
    if (!lastAgent && r === "agent") lastAgent = messages[i].tsMs;
    if (!lastGuest && r === "guest") lastGuest = messages[i].tsMs;
    if (lastAgent && lastGuest) break;
  }
  if (!lastAgent || !lastGuest) {
    return { ok: true, reason: "no_timestamps" };
  }

  // Alert only if the last message is from the GUEST and agent hasn't replied within SLA
  if (last.role !== "guest") {
    return { ok: true, reason: "agent_last" };
  }

  const minsSinceAgent = minutesBetween(nowUtcMs(), lastAgent);
  if (minsSinceAgent >= slaMinutes) {
    return { ok: false, reason: "guest_unanswered", minsSinceAgent };
  }
  return { ok: true, reason: "within_sla", minsSinceAgent };
}

// ---------- email ----------
function buildTransport() {
  const host = readEnv("SMTP_HOST");
  const port = toInt(readEnv("SMTP_PORT"), 587);
  const user = readEnv("SMTP_USER");
  const pass = readEnv("SMTP_PASS");
  if (!host || !user || !pass) return null;

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass }
  });
}

async function sendMail({ to, cc, subject, html, text }) {
  const transporter = buildTransport();
  if (!transporter) {
    console.log("SMTP not fully configured. Skipping email send.");
    return { skipped: true };
  }
  const fromName = readEnv("ALERT_FROM_NAME") || "Oaktree Boom SLA Bot";
  const fromAddr = readEnv("SMTP_USER");
  const from = `${fromName} <${fromAddr}>`;

  await transporter.sendMail({
    from,
    to,
    cc,
    subject,
    html,
    text
  });
  console.log("✓ Alert email sent.");
}

// ---------- main ----------
(async () => {
  try {
    const rawUrls = readEnv("INPUT_CONVERSATION_URLS", "CONVERSATION_URLS");
    const conversationUrls = parseUrlList(rawUrls);

    if (!conversationUrls.length) {
      throw new Error("No conversation_urls provided (workflow input).");
    }

    const SLA_MINUTES = toInt(readEnv("INPUT_SLA_MINUTES", "SLA_MINUTES"), 5);

    const email = readEnv("BOOM_USER", "LOGIN_EMAIL");
    const password = readEnv("BOOM_PASS", "LOGIN_PASSWORD");
    if (!email || !password) {
      throw new Error("Missing BOOM_USER/BOOM_PASS (or LOGIN_EMAIL/LOGIN_PASSWORD).");
    }

    const base = "https://app.boomnow.com";

    // Login once, reuse for all conversations
    const auth = await loginBoom({ base, email, password });

    console.log(`Checking ${conversationUrls.length} conversation(s) @ SLA ${SLA_MINUTES}m ...`);

    for (const originalUrl of conversationUrls) {
      const { api: apiUrl, page: humanUrl, id } = deriveLinks(originalUrl);
      if (!id) {
        throw new Error(`Could not extract conversation id from URL: ${originalUrl}`);
      }

      // Fetch conversation JSON
      const conv = await getConversation({ base, apiUrl, auth });

      // Normalize and evaluate
      const msgs = normalizeMessages(conv);
      const status = evaluateSLA(msgs, SLA_MINUTES);

      // Log a compact summary for the workflow logs
      console.log("Second check result:", JSON.stringify(status, null, 2));

      if (!status.ok && status.reason === "guest_unanswered") {
        // Prepare email
        const subject = `⚠️ Boom SLA: guest unanswered ≥ ${SLA_MINUTES}m`;
        const html = `
          <div>Guest appears unanswered for <b>${status.minsSinceAgent} minutes</b>.</div>
          <div style="margin-top:10px">
            <a href="${humanUrl}" target="_blank" rel="noopener noreferrer">Open conversation</a>
          </div>
          <hr/>
          <div style="font:12px/1.4 monospace; color:#666">API: ${apiUrl}</div>
        `;
        const text =
          `Guest appears unanswered ≥ ${SLA_MINUTES} minutes.\n` +
          `Open conversation: ${humanUrl}\n` +
          `API: ${apiUrl}\n`;

        const to = readEnv("ALERT_TO");
        const cc = readEnv("ALERT_CC");
        if (!to) {
          console.log("Alert needed, but ALERT_TO is not set. Skipping email.");
        } else {
          await sendMail({ to, cc, subject, html, text });
        }
      } else {
        console.log("No alert sent (not guest/unanswered).");
      }
    }
  } catch (err) {
    console.error("Error:", err.message || err);
    process.exit(1);
  }
})();
