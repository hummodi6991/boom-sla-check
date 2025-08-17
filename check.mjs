// check.mjs
// Boom SLA checker (REST approach)
// - Logs in using BOOM_USER / BOOM_PASS
// - Fetches each conversation (API or page URL both accepted)
// - If last guest message is older than SLA and no agent reply after it -> send alert email
// - CHANGE from your working version: email now includes a direct "Open conversation" link

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
  // existingCookieHeader: "a=1; b=2"
  // setCookieHeader may contain multiple Set-Cookie lines joined by comma
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
    // split on comma between cookies (naive but works for common cases)
    // safer approach: split on ", " only when next token contains = and no expires confusion
    // we’ll just split and push – Boom’s cookies don’t contain commas in names.
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
  // Returns API URL.
  const id = getConversationIdFromUrl(anyUrl);
  if (!id) throw new Error(`Could not find conversation id in URL: ${anyUrl}`);
  return `${origin}/api/conversations/${id}`;
}

function guessOrigin(anyUrl) {
  const u = new URL(anyUrl);
  return `${u.protocol}//${u.host}`;
}

function classifySender(msg) {
  // We try to be robust to schema differences.
  const raw =
    (msg.sender_type ?? msg.senderType ?? msg.author_role ?? msg.role ?? msg.from_role ?? msg.sender ?? "").toString().toLowerCase();

  // allow hints from source/channel
  const src = (msg.source ?? msg.channel ?? msg.via ?? "").toString().toLowerCase();

  // Heuristics:
  if (/agent|staff|teammate|operator/.test(raw)) return "agent";
  if (/guest|customer|user|visitor/.test(raw)) return "guest";
  if (/whatsapp/.test(src)) return "guest"; // whatsapp inbound is from guest
  if (/channel|web|sms|email/.test(src)) return "guest";

  // AI / suggestion hint – often present as system/ai
  const sys = (msg.type ?? msg.kind ?? "").toString().toLowerCase();
  if (/ai|suggestion|system/.test(sys)) return "ignore";

  // Best-effort fallback: if there’s an explicit is_agent flag:
  if (msg.is_agent === true) return "agent";
  if (msg.is_agent === false) return "guest";

  // Otherwise unknown => treat as guest text
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
  // Normalize
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
  if (!lastGuest) {
    // No guest messages at all -> OK
    return { ok: true, reason: "no_guest" };
  }

  const agentAfterGuest = [...norm]
    .reverse()
    .find((x) => x.sender === "agent" && x.ts > lastGuest.ts);

  if (agentAfterGuest) {
    return { ok: true, reason: "agent_after_guest" };
  }

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
// Main
// -----------------------------
async function main() {
  const urls = splitUrls(inputUrls);
  if (!urls.length) {
    throw new Error("No conversation_urls provided (workflow input).");
  }

  const firstOrigin = guessOrigin(urls[0]);
  const { cookie } = await loginAndGetSession(firstOrigin, BOOM_USER, BOOM_PASS);

  console.log(`Checking ${urls.length} conversation(s) @ SLA ${slaMinutes}m ...`);

  let anyAlert = false;

  for (const originalUrl of urls) {
    const origin = guessOrigin(originalUrl);
    const apiUrl = apiUrlFromAny(origin, originalUrl);

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

      // --------- ONLY-CHANGE PART: include link in the email ----------
      const link = toHumanUrl(originalUrl); // ADDED

      const subject = `⚠️ Boom SLA: guest unanswered ≥ ${slaMinutes}m`;
      const html =
        `<div>Guest appears unanswered for <b>${status.minsSinceAgent} minutes</b>.</div>
         <div style="margin-top:10px">
           <a href="${link}" target="_blank" rel="noopener noreferrer">Open conversation</a>
         </div>`;
      const text =
        `Guest appears unanswered for ${status.minsSinceAgent} minutes.\n` +
        `Open conversation: ${link}\n`;

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
