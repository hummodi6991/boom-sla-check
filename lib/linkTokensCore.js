import { createPublicKey, randomUUID } from 'node:crypto';
import {
  SignJWT,
  createRemoteJWKSet,
  importPKCS8,
  importSPKI,
  jwtVerify,
  exportJWK,
} from 'jose';

const ALG = 'RS256';
const ISSUER = 'alerts';
const DEFAULT_AUDIENCE = 'link';
const DEFAULT_KID = process.env.LINK_SIGNING_KID || 'link-1';
const DEFAULT_TTL_SECONDS = 15 * 60;

let privateKeyPromise = null;
let publicKeyPromise = null;
let cachedPublicPem = undefined;
let cachedRemoteJwks = null;
let cachedRemoteJwksUrl = null;
let redisPromise = undefined;

function normalizePem(pem) {
  if (!pem) return '';
  const trimmed = String(pem).trim();
  if (!trimmed) return '';
  const unquoted =
    trimmed.startsWith('"') && trimmed.endsWith('"')
      ? trimmed.slice(1, -1)
      : trimmed;
  return unquoted.replace(/\\n/g, '\n');
}

function ttlSeconds(input) {
  if (typeof input === 'number' && Number.isFinite(input)) {
    return Math.max(1, Math.floor(input));
  }
  const raw = String(input ?? '').trim();
  if (!raw) return DEFAULT_TTL_SECONDS;
  const direct = Number(raw);
  if (Number.isFinite(direct)) {
    return Math.max(1, Math.floor(direct));
  }
  const match = raw.match(/^(\d+)([smhd])$/i);
  if (!match) {
    throw new Error('invalid ttl format');
  }
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = { s: 1, m: 60, h: 3600, d: 86400 };
  return Math.max(1, Math.floor(value * (multipliers[unit] || 1)));
}

function getAudience() {
  return String(process.env.LINK_TOKEN_AUDIENCE || DEFAULT_AUDIENCE).trim() || DEFAULT_AUDIENCE;
}

function getKid() {
  return String(process.env.LINK_SIGNING_KID || DEFAULT_KID).trim() || DEFAULT_KID;
}

function getPrivateKeyPem() {
  return normalizePem(process.env.LINK_PRIVATE_KEY_PEM);
}

function computePublicPem() {
  if (cachedPublicPem !== undefined) return cachedPublicPem;
  const explicit = normalizePem(process.env.LINK_PUBLIC_KEY_PEM);
  if (explicit) {
    cachedPublicPem = explicit;
    return cachedPublicPem;
  }
  const privatePem = getPrivateKeyPem();
  if (!privatePem) {
    cachedPublicPem = '';
    return cachedPublicPem;
  }
  try {
    const keyObj = createPublicKey(privatePem);
    const exported = keyObj.export({ format: 'pem', type: 'spki' });
    cachedPublicPem = typeof exported === 'string' ? exported : exported.toString();
  } catch {
    cachedPublicPem = '';
  }
  return cachedPublicPem;
}

async function getPrivateKey() {
  if (privateKeyPromise) return privateKeyPromise;
  const pem = getPrivateKeyPem();
  if (!pem) throw new Error('LINK_PRIVATE_KEY_PEM missing');
  privateKeyPromise = importPKCS8(pem, ALG).catch((err) => {
    privateKeyPromise = null;
    throw err;
  });
  return privateKeyPromise;
}

async function getVerificationKey() {
  const jwksUrl = String(process.env.LINK_JWKS_URL || '').trim();
  if (jwksUrl) {
    if (!cachedRemoteJwks || cachedRemoteJwksUrl !== jwksUrl) {
      cachedRemoteJwks = createRemoteJWKSet(new URL(jwksUrl));
      cachedRemoteJwksUrl = jwksUrl;
    }
    return cachedRemoteJwks;
  }
  if (!publicKeyPromise) {
    const pem = computePublicPem();
    if (!pem) throw new Error('LINK_PUBLIC_KEY_PEM missing');
    publicKeyPromise = importSPKI(pem, ALG).catch((err) => {
      publicKeyPromise = null;
      throw err;
    });
  }
  return publicKeyPromise;
}

function redisKey(jti) {
  return `link:jti:${jti}`;
}

async function getRedis() {
  if (redisPromise !== undefined) return redisPromise;
  const url = String(process.env.REDIS_URL || '').trim();
  if (!url) {
    redisPromise = null;
    return redisPromise;
  }
  redisPromise = import('ioredis')
    .then((mod) => {
      const Redis = mod.default || mod.Redis || mod;
      const client = new Redis(url, { lazyConnect: true });
      client.on('error', () => {});
      return client;
    })
    .catch(() => null);
  return redisPromise;
}

export async function signLinkToken(payload, ttl = '15m') {
  const conversation = String(payload?.conversation ?? '').trim();
  if (!conversation) throw new Error('conversation required');
  const ttlSecs = ttlSeconds(ttl);
  const audience = String(payload?.aud || getAudience());
  const kid = getKid();
  const key = await getPrivateKey();
  const redis = await getRedis();
  let jti = payload?.jti ? String(payload.jti) : undefined;
  if (!jti && redis) {
    jti = randomUUID();
  }

  const signer = new SignJWT({ conversation });
  signer.setProtectedHeader({ alg: ALG, kid });
  signer.setIssuer(ISSUER).setAudience(audience).setIssuedAt();
  signer.setExpirationTime(`${ttlSecs}s`);
  if (jti) signer.setJti(jti);
  const token = await signer.sign(key);

  if (jti && redis) {
    try {
      await redis.set(redisKey(jti), '1', 'EX', ttlSecs, 'NX');
    } catch {
      // ignore cache failures
    }
  }

  return token;
}

export async function verifyLinkToken(token) {
  const key = await getVerificationKey();
  const audience = getAudience();
  const result = await jwtVerify(token, key, {
    algorithms: [ALG],
    issuer: ISSUER,
    audience,
  });
  const jti = result.payload?.jti;
  if (jti) {
    const redis = await getRedis();
    if (redis) {
      try {
        const removed = await redis.unlink(redisKey(jti));
        if (removed === 0) {
          throw new Error('link-token-reused');
        }
      } catch (err) {
        if (err?.message === 'link-token-reused') throw err;
        // ignore redis errors to avoid blocking valid tokens when cache unavailable
      }
    }
  }
  return result;
}

export async function currentLinkJwks() {
  const pem = computePublicPem();
  if (!pem) return null;
  const key = await importSPKI(pem, ALG);
  const jwk = await exportJWK(key);
  return {
    keys: [
      {
        ...jwk,
        use: 'sig',
        alg: ALG,
        kid: getKid(),
      },
    ],
  };
}

function resetCaches() {
  privateKeyPromise = null;
  publicKeyPromise = null;
  cachedPublicPem = undefined;
  cachedRemoteJwks = null;
  cachedRemoteJwksUrl = null;
  redisPromise = undefined;
}

export const __test__ = {
  ttlSeconds,
  getAudience,
  getKid,
  resetCaches,
};
