import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { decodeJwt } from 'jose';
import {
  buildCanonicalDeepLink,
  resolveConversation,
  unwrapUrl,
  verifyLink,
} from '../../packages/linking/src/index.js';

const COMMON_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nosnippet',
};

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

function cleanBaseUrl() {
  const raw = String(process.env.TARGET_APP_URL || 'https://app.boomnow.com').trim();
  return raw.replace(/\/+$/, '');
}

function allowedRedirectTarget(location) {
  if (typeof location !== 'string' || location.length === 0) return false;
  if (/^https?:\/\//i.test(location)) {
    try {
      const targetHost = new URL(cleanBaseUrl()).host;
      const candidateHost = new URL(location).host;
      return Boolean(targetHost) && candidateHost === targetHost;
    } catch {
      return false;
    }
  }
  return location.startsWith('/');
}

function invalidRedirectResponse() {
  return new Response(null, { status: 400, headers: { ...COMMON_HEADERS } });
}

function decodeLoop(value) {
  if (typeof value !== 'string') return '';
  let current = value;
  for (let i = 0; i < 5; i += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      current = decoded;
    } catch {
      break;
    }
  }
  return current;
}

function candidatesFromRequest(raw, c) {
  const list = [];
  if (raw) list.push(raw);
  const params = ['url', 'u', 'target', 'redirect', 'link'];
  for (const key of params) {
    const val = c?.req?.query(key);
    if (val) list.push(val);
  }
  return list;
}

function parseFromUrl(urlString) {
  try {
    const url = new URL(urlString);
    const params = url.searchParams;
    const conversation = params.get('conversation');
    if (conversation && UUID_RE.test(conversation)) {
      return { uuid: conversation.toLowerCase() };
    }
    const legacyId = params.get('legacyId') || params.get('id');
    if (legacyId && /^\d+$/.test(legacyId)) {
      return { legacyId };
    }
    const slug = params.get('slug') || params.get('conversationSlug');
    if (slug) return { slug };
    const parts = url.pathname.split('/').filter(Boolean);
    for (const part of parts) {
      if (UUID_RE.test(part)) return { uuid: part.toLowerCase() };
      if (/^\d+$/.test(part)) return { legacyId: part };
    }
  } catch {
    // ignore
  }
  return null;
}

function parseRawInput(raw, c) {
  const candidates = candidatesFromRequest(raw, c);
  for (const item of candidates) {
    if (!item) continue;
    const decoded = decodeLoop(item);
    const unwrapped = unwrapUrl(decoded);
    const fromUrl = parseFromUrl(unwrapped);
    if (fromUrl) return fromUrl;
    const trimmed = unwrapped.trim();
    if (!trimmed) continue;
    if (UUID_RE.test(trimmed)) {
      return { uuid: trimmed.toLowerCase() };
    }
    if (/^\d+$/.test(trimmed)) {
      return { legacyId: trimmed };
    }
    return { slug: trimmed };
  }
  return null;
}

async function loadJwks() {
  const inline = process.env.LINK_PUBLIC_JWKS;
  if (inline) {
    try {
      const parsed = JSON.parse(inline);
      if (parsed && Array.isArray(parsed.keys)) {
        return parsed;
      }
    } catch {
      // fall through to remote fetch
    }
  }
  const url = process.env.LINK_JWKS_URL;
  if (!url) {
    throw new Error('LINK_PUBLIC_JWKS missing');
  }
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error('jwks_fetch_failed');
  const json = await res.json();
  if (!json || !Array.isArray(json?.keys)) throw new Error('jwks_invalid');
  return json;
}

const jwksCache = { value: null, ts: 0 };
const JWKS_CACHE_MS = 60_000;

async function currentJwks() {
  const now = Date.now();
  if (jwksCache.value && now - jwksCache.ts < JWKS_CACHE_MS) {
    return jwksCache.value;
  }
  const jwks = await loadJwks();
  jwksCache.value = jwks;
  jwksCache.ts = now;
  return jwks;
}

function fallbackHtml() {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Boom link help</title>
    <style>
      body { font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 48px 16px; display: flex; justify-content: center; }
      main { max-width: 480px; background: rgba(15, 23, 42, 0.75); border-radius: 16px; padding: 32px; box-shadow: 0 20px 45px rgba(15, 23, 42, 0.5); backdrop-filter: blur(12px); }
      h1 { font-size: 1.5rem; margin-bottom: 12px; }
      p { line-height: 1.5; margin: 12px 0; }
      a.button { display: inline-block; padding: 12px 18px; border-radius: 999px; background: #38bdf8; color: #0f172a; font-weight: 600; text-decoration: none; margin-top: 16px; }
      a.button:hover { background: #0ea5e9; }
    </style>
  </head>
  <body>
    <main>
      <h1>We couldn't open that conversation</h1>
      <p>The secure link in your email may have expired or been blocked by another redirector. You can try again below or copy and paste the original link into your browser.</p>
      <p>If the issue continues, forward the email to <a href="mailto:support@boomnow.com">support@boomnow.com</a> for help.</p>
      <a class="button" href="javascript:window.location.reload(true)">Try again</a>
    </main>
  </body>
</html>`;
}

function seeOther(location) {
  if (!allowedRedirectTarget(location)) {
    return invalidRedirectResponse();
  }
  return new Response(null, {
    status: 303,
    headers: { ...COMMON_HEADERS, Location: location },
  });
}

function ok(body, contentType = 'text/html; charset=utf-8') {
  return new Response(body, {
    status: 200,
    headers: { ...COMMON_HEADERS, 'Content-Type': contentType },
  });
}

function headOk(headers = {}) {
  return new Response(null, {
    status: 200,
    headers: { ...COMMON_HEADERS, ...headers },
  });
}

function headSeeOther(location) {
  if (!allowedRedirectTarget(location)) {
    return invalidRedirectResponse();
  }
  return new Response(null, {
    status: 303,
    headers: { ...COMMON_HEADERS, Location: location },
  });
}

function getIssuer() {
  return process.env.LINK_ISSUER || 'sla-check';
}

function getAudience() {
  return process.env.LINK_AUDIENCE || 'boom-app';
}

function buildLegacyFallback(legacyId) {
  const base = cleanBaseUrl();
  const url = new URL('/dashboard/guest-experience/all', base + '/');
  url.searchParams.set('legacyId', String(legacyId));
  return url.toString();
}

async function handleConversationRedirect(record = {}) {
  const base = cleanBaseUrl();
  const resolved = await resolveConversation({
    uuid: record.uuid,
    legacyId: record.legacyId,
    slug: record.slug,
    allowMintFallback: false,
  });
  if (resolved?.uuid) {
    const location = buildCanonicalDeepLink({ appUrl: base, uuid: resolved.uuid });
    return location;
  }
  if (record.legacyId) {
    return buildLegacyFallback(record.legacyId);
  }
  return null;
}

function decodeLegacyFromToken(token) {
  try {
    const payload = decodeJwt(token);
    if (payload && payload.legacyId && /^\d+$/.test(String(payload.legacyId))) {
      return { legacyId: String(payload.legacyId) };
    }
  } catch {
    // ignore
  }
  return null;
}

export function createRedirectorApp() {
  const app = new Hono();

  app.get('/_healthz', () => ok('ok', 'text/plain'));

  app.get('/.well-known/jwks.json', async () => {
    const jwks = await currentJwks();
    return ok(JSON.stringify(jwks), 'application/json');
  });

  app.on('HEAD', '/.well-known/jwks.json', async () => {
    await currentJwks();
    return headOk({ 'Content-Type': 'application/json' });
  });

  app.get('/link/help', () => ok(fallbackHtml()));
  app.on('HEAD', '/link/help', () => headOk({ 'Content-Type': 'text/html; charset=utf-8' }));

  app.get('/u/:token', async (c) => {
    const token = c.req.param('token');
    try {
      const jwks = await currentJwks();
      const payload = await verifyLink(token, {
        jwks,
        iss: getIssuer(),
        aud: getAudience(),
      });
      const target = await handleConversationRedirect(payload);
      if (target) return seeOther(target);
      if (payload.legacyId) return seeOther(buildLegacyFallback(payload.legacyId));
      return seeOther('/link/help');
    } catch {
      const fallback = decodeLegacyFromToken(token);
      if (fallback?.legacyId) {
        return seeOther(buildLegacyFallback(fallback.legacyId));
      }
      return seeOther('/link/help');
    }
  });

  app.on('HEAD', '/u/:token', async (c) => {
    const token = c.req.param('token');
    try {
      const jwks = await currentJwks();
      const payload = await verifyLink(token, {
        jwks,
        iss: getIssuer(),
        aud: getAudience(),
      });
      const target = await handleConversationRedirect(payload);
      if (target) return headSeeOther(target);
      if (payload.legacyId) return headSeeOther(buildLegacyFallback(payload.legacyId));
      return headSeeOther('/link/help');
    } catch {
      const fallback = decodeLegacyFromToken(token);
      if (fallback?.legacyId) {
        return headSeeOther(buildLegacyFallback(fallback.legacyId));
      }
      return headSeeOther('/link/help');
    }
  });

  app.get('/c/:raw', async (c) => {
    const raw = c.req.param('raw');
    const parsed = parseRawInput(raw, c) || {};
    const target = await handleConversationRedirect(parsed);
    if (target) return seeOther(target);
    if (parsed.legacyId) return seeOther(buildLegacyFallback(parsed.legacyId));
    return seeOther('/link/help');
  });

  app.on('HEAD', '/c/:raw', async (c) => {
    const raw = c.req.param('raw');
    const parsed = parseRawInput(raw, c) || {};
    const target = await handleConversationRedirect(parsed);
    if (target) return headSeeOther(target);
    if (parsed.legacyId) return headSeeOther(buildLegacyFallback(parsed.legacyId));
    return headSeeOther('/link/help');
  });

  return app;
}

export function startServer() {
  const app = createRedirectorApp();
  const port = Number(process.env.PORT || 3005);
  serve({ fetch: app.fetch, port });
  console.log(`Redirector listening on :${port}`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  startServer();
}
