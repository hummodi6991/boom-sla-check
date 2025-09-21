import { signLink, verifyLink } from '../packages/linking/src/index.js';

function getIssuer() {
  return process.env.LINK_ISSUER || 'sla-check';
}

function getAudience() {
  return process.env.LINK_AUDIENCE || 'boom-app';
}

function getKid() {
  return process.env.LINK_KID || 'link-1';
}

let cachedJwks = null;
let cachedJwksLoadedAt = 0;
const CACHE_MS = 60_000;

function now() {
  return Date.now();
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

async function loadRemoteJwks(url) {
  const res = await fetch(url, { method: 'GET', headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error('jwks_fetch_failed');
  const json = await res.json();
  if (!json || !Array.isArray(json?.keys)) throw new Error('jwks_invalid');
  return json;
}

async function currentJwks() {
  const inline = parseJson(process.env.LINK_PUBLIC_JWKS);
  if (inline && Array.isArray(inline?.keys)) return inline;
  const url = process.env.LINK_JWKS_URL;
  if (!url) throw new Error('LINK_PUBLIC_JWKS missing');
  if (cachedJwks && now() - cachedJwksLoadedAt < CACHE_MS) {
    return cachedJwks;
  }
  const fetched = await loadRemoteJwks(url);
  cachedJwks = fetched;
  cachedJwksLoadedAt = now();
  return fetched;
}

function requirePrivateJwk() {
  const raw = process.env.LINK_PRIVATE_JWK;
  if (!raw) throw new Error('LINK_PRIVATE_JWK missing');
  return raw;
}

export async function signLinkToken(payload, ttl = '900') {
  const privateJwk = requirePrivateJwk();
  return signLink(payload, {
    privateJwk,
    kid: getKid(),
    iss: getIssuer(),
    aud: getAudience(),
    ttlSeconds: ttl,
  });
}

export async function verifyLinkToken(token) {
  const jwks = await currentJwks();
  const payload = await verifyLink(token, {
    jwks,
    iss: getIssuer(),
    aud: getAudience(),
  });
  return { payload };
}

export async function currentLinkJwks() {
  return currentJwks();
}

function resetCaches() {
  cachedJwks = null;
  cachedJwksLoadedAt = 0;
}

export const __test__ = {
  parseJson,
  loadRemoteJwks,
  resetCaches,
  getIssuer,
  getAudience,
  getKid,
};
