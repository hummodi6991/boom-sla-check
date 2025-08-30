// Azure Function: forward Boom webhook -> GitHub repository_dispatch (boom_message)
module.exports = async function (context, req) {
  try {
    const shared = process.env.SHARED_SECRET || "";
    const header = req.headers["x-shared-secret"] || req.headers["X-Shared-Secret"];
    if (shared && header !== shared) {
      context.res = { status: 401, body: { ok: false, error: "bad_shared_secret" } };
      return;
    }

    const owner = process.env.GITHUB_OWNER || process.env.GH_OWNER;
    const repo  = process.env.GITHUB_REPO  || process.env.GH_REPO;
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

    if (!owner || !repo || !token) {
      context.res = { status: 500, body: { ok:false, error:"missing_github_env", need:["GITHUB_OWNER","GITHUB_REPO","GITHUB_TOKEN"] } };
      return;
    }

    const payload = req.body || {};
    // Shape is flexible; we pass through exactly what Boom sent
    const body = { event_type: "boom_message", client_payload: payload };

    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/dispatches`, {
      method: "POST",
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    context.log("GitHub dispatch status:", res.status);
    if (res.ok) {
      context.res = { status: 200, body: { ok: true } };
    } else {
      const text = await res.text();
      context.res = { status: 502, body: { ok:false, error:"dispatch_failed", status: res.status, body: text } };
    }
  } catch (e) {
    context.log.error(e);
    context.res = { status: 500, body: { ok:false, error:"exception", message: String(e) } };
  }
};
