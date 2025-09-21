import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { decodeJwt } from 'jose';
import {
  resolveConversation,
  unwrapUrl,
  verifyLink,
} from '../../packages/linking/src/index.js';
import { normalizeAlertLinkInput } from '../../lib/conversationLink.js';

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
    const universalMatch = url.pathname.match(/\/go\/c\/([^/]+)/);
    if (universalMatch) {
      let token = universalMatch[1] || '';
      try {
        token = decodeURIComponent(token);
      } catch {
        // ignore decode failures and use raw value
      }
      token = token.trim();
      if (token) {
        if (UUID_RE.test(token)) return { uuid: token.toLowerCase() };
        if (/^\d+$/.test(token)) return { legacyId: token };
        return { slug: token };
      }
    }
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

function appOrigin() {
  try {
    return new URL(cleanBaseUrl()).origin;
  } catch {
    return 'https://app.boomnow.com';
  }
}

function normalizeIdentifier(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'string') {
    const trimmed = value.replace(/[\u0000-\u001F\u007F]/g, '').trim();
    return trimmed || null;
  }
  return null;
}

function messagesUrlCandidates(identifier) {
  const cleaned = normalizeIdentifier(identifier);
  if (!cleaned) return [];
  const encoded = encodeURIComponent(cleaned);
  const primary = String(process.env.MESSAGES_URL || '').trim();
  const urls = [];
  if (primary) {
    if (primary.includes('{{conversationId}}')) {
      urls.push(primary.replace('{{conversationId}}', encoded));
    } else if (/\bconversation(?:_id|Id)?=/i.test(primary)) {
      urls.push(primary);
    } else {
      const sep = primary.includes('?') ? '&' : '?';
      urls.push(`${primary}${sep}conversation=${encoded}`);
    }
  }
  const base = appOrigin();
  const convUrl = `${base}/api/conversations/${encoded}/messages`;
  const ge1 = `${base}/api/guest-experience/messages?conversation=${encoded}`;
  const ge2 = `${base}/api/guest-experience/messages?conversation_id=${encoded}`;
  const order = UUID_RE.test(cleaned) ? [convUrl, ge1, ge2] : [ge1, ge2, convUrl];
  const seen = new Set(urls);
  for (const url of order) {
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

function authHeaders() {
  const headers = { accept: 'application/json' };
  if (process.env.BOOM_BEARER) {
    headers.authorization = `Bearer ${process.env.BOOM_BEARER}`;
  }
  if (process.env.BOOM_COOKIE) {
    headers.cookie = process.env.BOOM_COOKIE;
  }
  return headers;
}

async function fetchConversationPayload(identifier) {
  const urls = messagesUrlCandidates(identifier);
  if (!urls.length) return null;
  const headers = authHeaders();
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers, redirect: 'manual' });
      if (!res.ok) continue;
      const json = await res.json().catch(() => null);
      if (json) {
        return { payload: json, url };
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

function findUuidInObject(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const match = value.match(UUID_RE);
    return match ? match[0].toLowerCase() : null;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUuidInObject(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    for (const key of Object.keys(value)) {
      const found = findUuidInObject(value[key]);
      if (found) return found;
    }
  }
  return null;
}

function extractUuidFromPayload(payload, fallback) {
  if (!payload || typeof payload !== 'object') return null;
  try {
    const normalized = normalizeAlertLinkInput(payload);
    if (normalized?.uuid && UUID_RE.test(normalized.uuid)) {
      return normalized.uuid.toLowerCase();
    }
  } catch {
    // ignore normalize failures
  }
  const mined = findUuidInObject(payload);
  if (mined) return mined;
  if (fallback && UUID_RE.test(String(fallback))) {
    return String(fallback).toLowerCase();
  }
  return null;
}

const WORKSPACE_PATHS = [
  ['conversation', 'workspace', 'slug'],
  ['conversation', 'workspace', 'id'],
  ['conversation', 'workspace_slug'],
  ['conversation', 'workspaceSlug'],
  ['conversation', 'portfolio', 'slug'],
  ['conversation', 'portfolio', 'id'],
  ['conversation', 'property', 'slug'],
  ['conversation', 'property', 'id'],
  ['conversation', 'account', 'slug'],
  ['conversation', 'account', 'id'],
  ['account', 'slug'],
  ['account', 'id'],
];

function valueByPath(obj, path) {
  let current = obj;
  for (const key of path) {
    if (!current || typeof current !== 'object') return null;
    current = current[key];
  }
  return current;
}

function sanitizeWorkspaceValue(value) {
  const normalized = normalizeIdentifier(value);
  if (!normalized) return null;
  if (UUID_RE.test(normalized)) return null;
  if (/^null$/i.test(normalized)) return null;
  return normalized;
}

function isSlugCandidate(value) {
  if (!value) return false;
  if (/^\d+$/.test(value)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/.test(value);
}

function collectWorkspaceCandidates(payload, exclude = []) {
  const result = [];
  const skip = new Set((exclude || []).map((v) => normalizeIdentifier(v)).filter(Boolean));
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (value != null && typeof value !== 'object') {
        if (/(workspace|portfolio|property|account|tenant|company)/i.test(key)) {
          const sanitized = sanitizeWorkspaceValue(value);
          if (sanitized && !skip.has(sanitized)) {
            result.push(sanitized);
          }
        }
      }
      if (typeof value === 'object') walk(value);
    }
  };
  walk(payload);
  return result;
}

function extractWorkspaceHint(payload, exclude = []) {
  if (!payload || typeof payload !== 'object') return null;
  for (const path of WORKSPACE_PATHS) {
    const value = valueByPath(payload, path);
    const sanitized = sanitizeWorkspaceValue(value);
    if (sanitized && !exclude.includes(sanitized)) {
      return sanitized;
    }
  }
  const candidates = collectWorkspaceCandidates(payload, exclude);
  const slug = candidates.find(isSlugCandidate);
  if (slug) return slug;
  const numeric = candidates.find((value) => /^\d+$/.test(value));
  if (numeric) return numeric;
  return candidates[0] || null;
}

async function resolveViaMessages(record = {}) {
  const identifiers = [];
  if (record.legacyId != null) identifiers.push(record.legacyId);
  if (record.uuid) identifiers.push(record.uuid);
  if (record.slug) identifiers.push(record.slug);
  const seen = new Set();
  for (const candidate of identifiers) {
    const normalized = normalizeIdentifier(candidate);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    const fetched = await fetchConversationPayload(normalized);
    if (!fetched?.payload) continue;
    const uuid = extractUuidFromPayload(fetched.payload, record.uuid || normalized);
    if (!uuid) continue;
    const workspace = extractWorkspaceHint(fetched.payload, [
      uuid,
      normalized,
      record.uuid,
      record.slug,
      record.legacyId,
    ]);
    return { uuid, workspace: workspace || null, source: 'messages-api' };
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
  return `${base}/go/c/${encodeURIComponent(String(legacyId))}`;
}

function buildDashboardUrl({ baseUrl, uuid, workspace }) {
  const base = String(baseUrl || '').trim();
  if (!base || !uuid) return null;
  const normalizedUuid = String(uuid).toLowerCase();
  const workspaceHint = workspace ? String(workspace).trim() : '';
  try {
    const url = new URL('/dashboard/guest-experience/all', `${base}/`);
    url.searchParams.set('conversation', normalizedUuid);
    if (workspaceHint) url.searchParams.set('workspace', workspaceHint);
    url.hash = '';
    return url.toString();
  } catch {
    let target = `${base}/dashboard/guest-experience/all?conversation=${encodeURIComponent(
      normalizedUuid,
    )}`;
    if (workspaceHint) {
      target += `&workspace=${encodeURIComponent(workspaceHint)}`;
    }
    return target;
  }
}

const IN_APP_SIGNATURES = [
  'FBAN',
  'FBAV',
  'FB_IAB',
  'FBIOS',
  'Instagram',
  'GSA/',
  'EdgiOS',
  'Outlook-iOS',
  '; wv',
  '\\bwv\\b',
  'Line/',
  'MicroMessenger',
  'Snapchat',
  'TikTok',
  'Twitter',
];

function shouldServeInterstitial(userAgent = '') {
  if (!userAgent) return false;
  const ua = String(userAgent);
  if (/android/i.test(ua) && /\bwv\b/i.test(ua)) return true;
  return IN_APP_SIGNATURES.some((signature) => {
    try {
      return new RegExp(signature, 'i').test(ua);
    } catch {
      return false;
    }
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function interstitialHtml(finalUrl) {
  const safeHref = escapeHtml(finalUrl);
  const signatures = JSON.stringify(IN_APP_SIGNATURES);
  const finalJs = JSON.stringify(finalUrl);
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Open in browser</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; margin: 0; color: #e2e8f0; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 16px; }
      main { max-width: 520px; background: rgba(15, 23, 42, 0.82); border-radius: 18px; padding: 32px; box-shadow: 0 24px 60px rgba(15, 23, 42, 0.55); backdrop-filter: blur(14px); }
      h1 { margin-top: 0; font-size: 1.6rem; }
      p { line-height: 1.6; }
      button { appearance: none; border: none; border-radius: 999px; padding: 12px 20px; font-size: 1rem; font-weight: 600; background: #38bdf8; color: #0f172a; cursor: pointer; margin-top: 16px; }
      button:hover { background: #0ea5e9; }
      a.link { color: #38bdf8; word-break: break-all; text-decoration: none; }
      a.link:hover { text-decoration: underline; }
      .note { font-size: 0.875rem; color: #94a3b8; margin-top: 20px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Open this conversation in your browser</h1>
      <p>We've detected an in-app browser that might block Boom from loading correctly. Use the button below to continue in your default browser.</p>
      <button id="open-button" type="button">Open in Safari</button>
      <p class="note">If nothing happens, copy or tap this link:</p>
      <p><a id="fallback-link" class="link" href="${safeHref}" target="_blank" rel="noopener">${safeHref}</a></p>
    </main>
    <script>
      (function() {
        const finalUrl = ${finalJs};
        const signatures = ${signatures};
        const ua = navigator.userAgent || '';
        const isAndroidWv = /android/i.test(ua) && /\\bwv\\b/i.test(ua);
        const isInApp = signatures.some(function(pattern) {
          try { return new RegExp(pattern, 'i').test(ua); } catch { return false; }
        });
        if (!isAndroidWv && !isInApp) {
          window.location.replace(finalUrl);
          return;
        }
        const link = document.getElementById('fallback-link');
        if (link) link.href = finalUrl;
        const btn = document.getElementById('open-button');
        if (btn) {
          btn.addEventListener('click', function() {
            const win = window.open(finalUrl, '_blank', 'noopener');
            if (!win) {
              window.location.href = finalUrl;
            }
          });
        }
      })();
    </script>
    <noscript>
      <p style="padding:16px;">JavaScript is required to open this conversation automatically. Copy this link into your browser: <a class="link" href="${safeHref}" target="_blank" rel="noopener">${safeHref}</a></p>
    </noscript>
  </body>
</html>`;
}

function redirectResponse(c, location) {
  if (c.req.method === 'HEAD') {
    return headSeeOther(location);
  }
  if (!allowedRedirectTarget(location)) {
    return invalidRedirectResponse();
  }
  const ua = c.req.header('user-agent') || '';
  if (shouldServeInterstitial(ua)) {
    return ok(interstitialHtml(location));
  }
  return new Response(null, {
    status: 303,
    headers: { ...COMMON_HEADERS, Location: location },
  });
}

async function handleConversationRedirect(record = {}) {
  const base = cleanBaseUrl();
  const viaMessages = await resolveViaMessages(record).catch(() => null);
  if (viaMessages?.uuid) {
    const location = buildDashboardUrl({
      baseUrl: base,
      uuid: viaMessages.uuid,
      workspace: viaMessages.workspace,
    });
    if (location) {
      return {
        location,
        uuid: viaMessages.uuid,
        workspace: viaMessages.workspace,
        source: 'messages-api',
      };
    }
  }
  const resolved = await resolveConversation({
    uuid: record.uuid,
    legacyId: record.legacyId,
    slug: record.slug,
    allowMintFallback: false,
  }).catch(() => null);
  if (resolved?.uuid) {
    const location = buildDashboardUrl({ baseUrl: base, uuid: resolved.uuid });
    if (location) {
      return { location, uuid: resolved.uuid, workspace: null, source: 'resolver' };
    }
  }
  if (record.legacyId) {
    return {
      location: buildLegacyFallback(record.legacyId),
      uuid: null,
      workspace: null,
      source: 'legacy',
    };
  }
  return { location: null, uuid: null, workspace: null, source: 'none' };
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

  // Pass-through for universal deep links accidentally pointed at the redirector host.
  // Always forward to the app host's /go/c/:token so these links never 404.
  app.get('/go/c/:token', (c) => {
    const base = cleanBaseUrl();
    const token = c.req.param('token') || '';
    const location = `${base}/go/c/${encodeURIComponent(token)}`;
    return redirectResponse(c, location);
  });
  app.on('HEAD', '/go/c/:token', (c) => {
    const base = cleanBaseUrl();
    const token = c.req.param('token') || '';
    const location = `${base}/go/c/${encodeURIComponent(token)}`;
    return headSeeOther(location);
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
      if (target?.location) return redirectResponse(c, target.location);
      if (payload.legacyId) return redirectResponse(c, buildLegacyFallback(payload.legacyId));
      return seeOther('/link/help');
    } catch {
      const fallback = decodeLegacyFromToken(token);
      if (fallback?.legacyId) {
        return redirectResponse(c, buildLegacyFallback(fallback.legacyId));
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
      if (target?.location) return redirectResponse(c, target.location);
      if (payload.legacyId) return redirectResponse(c, buildLegacyFallback(payload.legacyId));
      return headSeeOther('/link/help');
    } catch {
      const fallback = decodeLegacyFromToken(token);
      if (fallback?.legacyId) {
        return redirectResponse(c, buildLegacyFallback(fallback.legacyId));
      }
      return headSeeOther('/link/help');
    }
  });

  app.get('/c/:raw', async (c) => {
    const raw = c.req.param('raw');
    const parsed = parseRawInput(raw, c) || {};
    const target = await handleConversationRedirect(parsed);
    if (target?.location) return redirectResponse(c, target.location);
    if (parsed.legacyId) return redirectResponse(c, buildLegacyFallback(parsed.legacyId));
    return seeOther('/link/help');
  });

  app.on('HEAD', '/c/:raw', async (c) => {
    const raw = c.req.param('raw');
    const parsed = parseRawInput(raw, c) || {};
    const target = await handleConversationRedirect(parsed);
    if (target?.location) return redirectResponse(c, target.location);
    if (parsed.legacyId) return redirectResponse(c, buildLegacyFallback(parsed.legacyId));
    return headSeeOther('/link/help');
  });

  app.get('/boom/open/conv/:raw', async (c) => {
    const raw = c.req.param('raw');
    const parsed = parseRawInput(raw, c) || {};
    const target = await handleConversationRedirect(parsed);
    if (target?.location) return redirectResponse(c, target.location);
    if (parsed.legacyId) return redirectResponse(c, buildLegacyFallback(parsed.legacyId));
    return seeOther('/link/help');
  });

  app.on('HEAD', '/boom/open/conv/:raw', async (c) => {
    const raw = c.req.param('raw');
    const parsed = parseRawInput(raw, c) || {};
    const target = await handleConversationRedirect(parsed);
    if (target?.location) return redirectResponse(c, target.location);
    if (parsed.legacyId) return redirectResponse(c, buildLegacyFallback(parsed.legacyId));
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
