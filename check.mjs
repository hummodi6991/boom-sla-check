/* Boom SLA checker (API/REST only) – with conversation link in the email
 * - Logs into Boom using /api/login
 * - Fetches messages for one or more conversations
 * - Decides guest unanswered >= SLA minutes
 * - Sends email via SMTP secrets, including a clickable UI link
 */

import nodemailer from "nodemailer";

// ---------- Config & inputs ----------
const loginUrl = process.env.BOOM_LOGIN_URL || "https://app.boomnow.com/api/login";
const apiBase  = process.env.BOOM_API_BASE  || "https://app.boomnow.com/api";

const email = process.env.BOOM_USER;
const password = process.env.BOOM_PASS;
const tenantId = process.env.BOOM_TENANT_ID ?? null;

// INPUTS (from workflow_dispatch)
const rawUrls = (process.env.INPUT_CONVERSATION_URLS || "").trim();
const SLA_MIN = Math.max(1, parseInt(process.env.INPUT_SLA_MIN || "5", 10));

// Email / SMTP
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const ALERT_TO  = process.env.ALERT_TO;
const ALERT_CC  = process.env.ALERT_CC || "";
const FROM_NAME = process.env.ALERT_FROM_NAME || "Oaktree Boom SLA Bot";

// Optional heuristic toggle
const AGENT_SIDE = (process.env.AGENT_SIDE || "").toLowerCase();

// ---------- Helpers ----------
function fail(msg, ctx = {}) {
  console.error("Error:", msg, ctx);
  process.exitCode = 1;
}
const nowIso = () => new Date().toISOString();

// Parse conversation ID from:
// - /api/conversations/<uuid>
// - /dashboard/.../<uuid>
// - raw <uuid>
function extractConversationId(anyUrl) {
  try {
    const u = new URL(anyUrl, "https://app.boomnow.com");
    const parts = u.pathname.split("/").filter(Boolean);
    const idxApi = parts.findIndex(p => p === "conversations");
    if (idxApi >= 0 && parts[idxApi+1]) return parts[idxApi+1];
    const maybeId = parts[parts.length - 1];
    if (maybeId && /^[0-9a-f-]{36}$/i.test(maybeId)) return maybeId;
  } catch {}
  if (/^[0-9a-f-]{36}$/i.test(anyUrl)) return anyUrl;
  return null;
}

function coerceMessages(any) {
  if (!any) return [];
  if (Array.isArray(any)) return any;
  for (const k of Object.keys(any)) {
    if (Array.isArray(any[k]) && k.toLowerCase().includes("message")) return any[k];
    if (any[k] && typeof any[k] === "object") {
      const found = coerceMessages(any[k]);
      if (found.length) return found;
    }
  }
  return [];
}

function parseTimestamp(msg) {
  const keys = ["created_at", "inserted_at", "createdAt", "timestamp", "ts"];
  for (const k of keys) {
    if (msg[k]) {
      const d = new Date(msg[k]);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  if (msg.meta && msg.meta.ts) {
    const d = new Date(msg.meta.ts);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

function isAutomation(msg) {
  const flags = [
    msg.is_automation, msg.isAutomation, msg.automation,
    msg.is_ai, msg.isAi, msg.ai, msg.is_bot, msg.bot, msg.is_suggestion
  ];
  if (flags.some(Boolean)) return true;
  const t = (msg.type || msg.message_type || "").toString().toLowerCase();
  if (t.includes("suggestion") || t.includes("automation") || t.includes("ai")) return true;
  const text = ((msg.text || msg.body || msg.content || "") + "").toLowerCase();
  if (text.includes("confidence:") && (text.includes("approve") || text.includes("reject"))) return true;
  return false;
}

function isGuestMessage(msg) {
  const role = (msg.role || msg.sender_role || msg.senderType || msg.side || "").toString().toLowerCase();
  const authorType = (msg.author?.type || msg.author_type || "").toLowerCase();
  if (role.includes("guest") || role.includes("customer") || role === "inbound") return true;
  if (authorType.includes("guest")) return true;
  const channel = (msg.channel || msg.source || "").toString().toLowerCase();
  if (["whatsapp", "sms", "email_inbound"].includes(channel) && !isAutomation(msg)) return true;
  return false;
}

function isAgentHumanMessage(msg) {
  if (AGENT_SIDE === "channel") {
    const role = (msg.role || msg.sender_role || "").toString().toLowerCase();
    if (role.includes("agent") || role.includes("user") || role.includes("staff")) return !isAutomation(msg);
  }
  if (AGENT_SIDE === "agent") {
    const role = (msg.role || msg.sender_role || msg.side || "").toString().toLowerCase();
    if (role.includes("agent") || role.includes("user") || role.includes("staff")) return !isAutomation(msg);
  }
  const authorType = (msg.author?.type || msg.author_type || "").toLowerCase();
  const role = (msg.role || msg.sender_role || msg.side || "").toLowerCase();
  if (authorType.includes("user") || authorType.includes("agent") || role.includes("agent") || role.includes("staff")) {
    return !isAutomation(msg);
  }
  if (msg.private || msg.internal) return false;
  return false;
}

// ---------- Core ----------
async function loginAndGetCookie() {
  const body = { email, password, tenant_id: tenantId ?? null };
  const r = await fetch(loginUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json, text/plain, */*" },
    body: JSON.stringify(body),
    redirect: "manual"
  });
  if (!r.ok && r.status !== 302) throw new Error(`Login failed: HTTP ${r.status}`);
  const setCookie = r.headers.get("set-cookie");
  if (!setCookie) throw new Error("Login succeeded but no Set-Cookie header returned.");
  const cookie = setCookie.split(",").map(s => s.split(";")[0].trim()).join("; ");
  return cookie;
}

async function fetchConversation(cookie, idOrUrl) {
  const id = extractConversationId(idOrUrl);
  if (!id) throw new Error(`Could not parse conversation id from: ${idOrUrl}`);
  const url = `${apiBase}/conversations/${id}`;
  const r = await fetch(url, { headers: { "Accept": "application/json", "Cookie": cookie } });
  if (!r.ok) throw new Error(`Fetch conversation failed: HTTP ${r.status}`);
  const json = await r.json();
  const messages = coerceMessages(json);
  return { id, url, json, messages };
}

function decideSLA(messages, slaMin) {
  if (!messages.length) return { ok: true, reason: "no_messages" };
  const timed = messages.map(m => ({ m, ts: parseTimestamp(m) }))
                        .filter(x => x.ts !== null)
                        .sort((a, b) => a.ts - b.ts);
  if (!timed.length) return { ok: true, reason: "no_timestamps" };

  let lastAgentTs = null;
  let lastGuestTs = null;
  for (const { m, ts } of timed) {
    if (isGuestMessage(m)) lastGuestTs = ts;
    if (isAgentHumanMessage(m)) lastAgentTs = ts;
  }
  if (!lastGuestTs) return { ok: true, reason: "no_guest" };
  if (lastAgentTs && lastAgentTs >= lastGuestTs) return { ok: true, reason: "agent_after_guest" };

  const now = new Date();
  const minsSinceAgent = lastAgentTs ? Math.floor((now - lastAgentTs) / 60000) : Infinity;
  if (minsSinceAgent >= slaMin) return { ok: false, reason: "guest_unanswered", minsSinceAgent };
  return { ok: true, reason: "within_sla", minsSinceAgent };
}

async function sendEmail({ subject, html, text }) {
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS || !ALERT_TO) {
    console.log("Email not sent (SMTP or recipients not fully set).");
    return false;
  }
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  const info = await transporter.sendMail({
    from: `"${FROM_NAME}" <${SMTP_USER}>`,
    to: ALERT_TO,
    cc: ALERT_CC || undefined,
    subject,
    text,
    html
  });
  console.log("Alert email sent:", info.messageId);
  return true;
}

// ---------- Run ----------
(async () => {
  try {
    if (!email || !password) throw new Error("Missing BOOM_USER/BOOM_PASS secrets.");
    if (!rawUrls) throw new Error("No conversation_urls provided (workflow input).");

    const cookie = await loginAndGetCookie();
    const urls = rawUrls.split(",").map(s => s.trim()).filter(Boolean);
    if (urls.length === 0) throw new Error("conversation_urls input is empty after parsing.");

    for (const u of urls) {
      const convo = await fetchConversation(cookie, u);
      const result = decideSLA(convo.messages, SLA_MIN);

      console.log("Second check result:", JSON.stringify(result, null, 2));

      if (!result.ok && result.reason === "guest_unanswered") {
        // ✅ UI link added (clickable)
        const uiLink = `https://app.boomnow.com/dashboard/guest-experience/sales/${convo.id}`;
        const shortId = convo.id.slice(0, 8);
        const subject = `⚠️ Boom SLA: guest unanswered ≥ ${SLA_MIN}m — ${shortId}`;
        const text = [
          `Boom SLA Alert`,
          `Conversation: ${convo.id}`,
          `Reason: ${result.reason}`,
          `Minutes since last human agent: ${result.minsSinceAgent}`,
          `Open: ${uiLink}`,
          `Sent: ${nowIso()}`
        ].join("\n");

        const html = `
          <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; line-height:1.45">
            <h3 style="margin:0 0 8px">Boom SLA Alert</h3>
            <p style="margin:0 0 4px"><strong>Conversation:</strong> ${convo.id}</p>
            <p style="margin:0 0 4px"><strong>Reason:</strong> ${result.reason}</p>
            <p style="margin:0 0 12px"><strong>Minutes since last human agent:</strong> ${result.minsSinceAgent}</p>
            <p style="margin:0 0 12px">
              <a href="${uiLink}">🔗 Open conversation in Boom</a>
            </p>
            <hr style="border:none;border-top:1px solid #eee;margin:12px 0">
            <p style="color:#666;font-size:12px;margin:0">Sent ${nowIso()}</p>
          </div>
        `;

        await sendEmail({ subject, html, text });
      } else {
        console.log("No alert sent (not guest/unanswered).");
      }
    }
  } catch (err) {
    fail(err.message);
  }
})();
