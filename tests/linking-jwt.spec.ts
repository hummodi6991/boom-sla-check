import { test, expect } from '@playwright/test';
import { decodeJwt } from 'jose';
import { signLink, verifyLink } from '../packages/linking/src/jwt.js';
import { TEST_PRIVATE_JWK, TEST_PUBLIC_JWK } from './helpers/testKeys';

const JWKS = {
  keys: [{ ...TEST_PUBLIC_JWK, use: 'sig', alg: 'EdDSA', kid: 'unit-test' }],
};

const ISS = 'sla-check';
const AUD = 'boom-app';

function futureDate(seconds) {
  const original = Date.now;
  Date.now = () => original() + seconds * 1000;
  return () => {
    Date.now = original;
  };
}

test('signLink creates EdDSA JWT that verifyLink accepts', async () => {
  const token = await signLink(
    { t: 'conversation', uuid: '123e4567-e89b-12d3-a456-426614174000' },
    { privateJwk: TEST_PRIVATE_JWK, kid: 'unit-test', iss: ISS, aud: AUD, ttlSeconds: 300 },
  );
  const payload = await verifyLink(token, { jwks: JWKS, iss: ISS, aud: AUD });
  expect(payload.t).toBe('conversation');
  expect(payload.uuid).toBe('123e4567-e89b-12d3-a456-426614174000');
  const decoded = decodeJwt(token);
  expect(typeof decoded.exp).toBe('number');
});

test('signLink encodes ttlSeconds and verifyLink enforces expiration', async () => {
  const token = await signLink(
    { ok: true },
    { privateJwk: TEST_PRIVATE_JWK, kid: 'unit-test', iss: ISS, aud: AUD, ttlSeconds: 5, now: 0 },
  );
  const decoded = decodeJwt(token);
  expect(decoded.exp).toBe(5);
  const restore = futureDate(10);
  await expect(async () => verifyLink(token, { jwks: JWKS, iss: ISS, aud: AUD })).rejects.toThrow();
  restore();
});
