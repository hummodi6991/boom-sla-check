import fetch from "node-fetch";

/**
 * Env vars required:
 *   GITHUB_OWNER / GH_OWNER
 *   GITHUB_REPO  / GH_REPO
 *   GITHUB_TOKEN / GH_PAT   (token needs "repo" + "actions:write")
 * Optional:
 *   SHARED_SECRET (if set, request must include header "x-shared-secret")
 */
export default async function (context, req) {
  const log = (...args) => context.log("[boom-notify]", ...args);

  try {
    // Optional shared secret check
    const expected = process.env.SHARED_SECRET;
    const provided = req.headers["x-shared-secret"];
    if (expected && provided !== expected) {
      log("invalid secret");
      context.res = { status: 401, body: "invalid secret" };
      return;
    }

    // Resolve envs (support both names)
    const owner = process.env.GITHUB_OWNER || process.env.GH_OWNER;
    const repo  = process.env.GITHUB_REPO  || process.env.GH_REPO;
    const token = process.env.GITHUB_TOKEN || process.env.GH_PAT;
    if (!owner || !repo || !token) {
      const missing = { owner: !!owner, repo: !!repo, token: !!token };
      log("missing envs", missing);
      context.res = { status: 500, body: "Missing GitHub env vars" };
      return;
    }

    // Build payload (pass through Boom event, but normalize a couple fields)
    const body = req.body || {};
    const conversationUrl =
      body.conversationUrl ||
      (body.conversation && (body.conversation.url || body.conversation.link)) ||
      null;

    const eventType = "boom_push";
    const ghResp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/dispatches`,
      {
        method: "POST",
        headers: {
          "Accept": "application/vnd.github+json",
          "Authorization": `Bearer ${token}`,
          "User-Agent": "boom-webhook-func"
        },
        body: JSON.stringify({
          event_type: eventType,
          client_payload: {
            conversationUrl,
            conversation: body.conversation ?? null,
            boom_notification: body
          }
        })
      }
    );

    if (ghResp.ok) {
      log("repository_dispatch accepted");
      context.res = { status: 202, body: "dispatched" };
    } else {
      const text = await ghResp.text();
      log("repository_dispatch failed", ghResp.status, text);
      context.res = {
        status: 502,
        body: `GitHub dispatch failed: ${ghResp.status} ${text}`
      };
    }
  } catch (err) {
    log("handler error", err?.stack || err);
    context.res = { status: 500, body: "internal error" };
  }
}
