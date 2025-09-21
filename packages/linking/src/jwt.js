import { SignJWT, createLocalJWKSet, importJWK, jwtVerify } from 'jose';

const ALG = 'EdDSA';

function parseJsonMaybe(input) {
  if (!input) return null;
  if (typeof input === 'object') return input;
  const trimmed = String(input).trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    throw new Error('invalid_jwk_json');
  }
}

function normalizeTtlSeconds(ttl) {
  if (typeof ttl === 'number' && Number.isFinite(ttl)) {
    return Math.max(1, Math.floor(ttl));
  }
  if (typeof ttl === 'string') {
    const trimmed = ttl.trim();
    if (!trimmed) return 0;
    const asNumber = Number(trimmed);
    if (Number.isFinite(asNumber)) {
      return Math.max(1, Math.floor(asNumber));
    }
    const match = trimmed.match(/^(\d+)([smhd])$/i);
    if (match) {
      const value = Number(match[1]);
      const unit = match[2].toLowerCase();
      const multipliers = { s: 1, m: 60, h: 3600, d: 86400 };
      const mult = multipliers[unit] || 1;
      return Math.max(1, Math.floor(value * mult));
    }
    throw new Error('invalid_ttl');
  }
  return 0;
}

async function importPrivateKey(privateJwk) {
  const jwk = parseJsonMaybe(privateJwk);
  if (!jwk) throw new Error('private_jwk_required');
  return importJWK(jwk, ALG);
}

function createJwksVerifier(jwks) {
  const parsed = parseJsonMaybe(jwks);
  if (!parsed || !Array.isArray(parsed?.keys)) {
    throw new Error('invalid_jwks');
  }
  return createLocalJWKSet(parsed);
}

export async function signLink(payload, opts = {}) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('payload_required');
  }
  const ttlSeconds = normalizeTtlSeconds(opts.ttlSeconds ?? 0) || 300;
  const nowSeconds = Math.floor((opts.now ?? Date.now()) / 1000);
  const privateKey = await importPrivateKey(opts.privateJwk);
  const header = { alg: ALG };
  if (opts.kid) header.kid = String(opts.kid);
  const issuer = opts.iss ? String(opts.iss) : undefined;
  const audience = opts.aud ? String(opts.aud) : undefined;

  const signer = new SignJWT({ ...payload });
  signer.setProtectedHeader(header);
  if (issuer) signer.setIssuer(issuer);
  if (audience) signer.setAudience(audience);
  signer.setIssuedAt(nowSeconds);
  signer.setExpirationTime(nowSeconds + ttlSeconds);
  return signer.sign(privateKey);
}

export async function verifyLink(token, opts = {}) {
  if (!token || typeof token !== 'string') {
    throw new Error('token_required');
  }
  const verifier = createJwksVerifier(opts.jwks);
  const options = { algorithms: [ALG] };
  if (opts.iss) options.issuer = String(opts.iss);
  if (opts.aud) options.audience = String(opts.aud);
  const result = await jwtVerify(token, verifier, options);
  return result.payload;
}

export const __test__ = {
  normalizeTtlSeconds,
  parseJsonMaybe,
};
