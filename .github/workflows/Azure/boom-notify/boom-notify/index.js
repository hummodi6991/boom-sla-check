// azure/boom-notify/boom-notify/index.js
// Purpose: Accept Boom push/webhook POSTs and trigger a GitHub repository_dispatch
// Event type: "boom_push"
// Requires app settings: GITHUB_OWNER, GITHUB_REPO, GITHUB_TOKEN
// Optional: SHARED_SECRET (if you want a shared-secret header check)

import fetch from "node-fetch";

/** Try to pull a conversation ID out of a Boom-style URL */
function extractIdFromUrl(url) {
  if (!url || typeof url !== "string") return "";
  const m = url.match(/conversations\/([^/?#]+)/i);
  return m ? m[1] : "";
}

/** Normalize/guess fields from many possible payload shapes */
function normalizePayload(body) {
  const conversationUrl =
    body.conversationUrl ??
    body.conversation_url ??
    body.data?.conversationUrl ??
    body.data?.conversation_url ??
    body.data?.conversation?.url ??
    "";

  const conversationId =
    body.conversationId ??
    body.conversation_id ??
    body.data?.conversationId ??
    body.data?.conversation_id ??
    extractIdFromUrl(conversationUrl);

  const event =
    body.event ??
    body.type ??
    body.action ??
    body.data?.event ??
    "message_created";

  // Optional convenience fields for your GH Action / scripts
  const message = body.message ?? body.data?.message ?? null;

  return { conversationId, conversationUrl, event, message };
}

export default async function (context, req) {
  try {
    // Ensure JSON body (Azure Functions usually parses this for you)
    const body = req.body && typeof req.body === "object"
      ? req.body
      : (() => { try { return JSON.parse(req.rawBody || "{}"); } catch { return {}; } })();

    // Optional shared-secret header check (set SHARED_SECRET in App Settings)
    const sharedSecret = process.env.SHARED_SECRET || "";
    if (sharedSecret) {
      const incoming = req.headers["x-shared-secret"] || req.headers["X-Shared-Secret".toLowerCase()];
      if (incoming !== sharedSecret) {
        context.log.warn("Shared secret mismatch");
        context.res = { status: 401, body: "Unauthorized" };
        return;
      }
    }

    // Pull out fields we care about (very tolerant to payload shapes)
    const { conversationId, conversationUrl, event, message } = normalizePayload(body);

    // Validate required env vars
    const owner = process.env.GITHUB_OWNER;
    const repo  = process.env.GITHUB_REPO;
    const token = process.env.GITHUB_TOKEN;

    if (!owner || !repo || !token) {
      context.log.error("Missing one of GITHUB_OWNER/GITHUB_REPO/GITHUB_TOKEN");
      context.res = { status: 500, body: "Server not configured" };
      return;
    }

    // Build client_payload that your GitHub Action can read
    const clientPayload = {
      event,                      // e.g., "message_created"
      conversation: conversationId || conversationUrl || "",
      conversationUrl: conversationUrl || "",
      message,                    // optional convenience field
      boom_notification: body     // raw payload for your workflow to use if needed
    };

    // Fire repository_dispatch
    const ghResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/dispatches`, {
      method: "POST",
      headers: {
        "Authorization": `token ${token}`,
        "Accept": "application/vnd.github+json",
        "User-Agent": "boom-notify-hook",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        event_type: "boom_push",
        client_payload: clientPayload
      })
    });

    if (!ghResp.ok) {
      const text = await ghResp.text();
      context.log.error("GitHub dispatch failed:", ghResp.status, text);
      context.res = { status: 502, body: `GitHub dispatch failed: ${text}` };
      return;
    }

    // Success — return 202 so Boom knows we accepted it
    context.res = { status: 202, body: "Dispatched" };
  } catch (err) {
    context.log.error("Unhandled error:", err);
    context.res = { status: 500, body: "Internal error" };
  }
}
