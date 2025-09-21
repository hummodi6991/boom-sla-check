import { test, expect } from '@playwright/test';
import { GET as jwksRoute } from '../app/.well-known/jwks.json/route';
import { __test__ as linkTokenTestUtils } from '../lib/linkTokensCore.js';
import { setTestKeyEnv, TEST_PUBLIC_JWK } from './helpers/testKeys';

test('JWKS route returns 404 when no signing key is configured', async () => {
  linkTokenTestUtils?.resetCaches?.();
  delete process.env.LINK_PRIVATE_JWK;
  delete process.env.LINK_PUBLIC_JWKS;
  delete process.env.LINK_JWKS_URL;

  const res = await jwksRoute();
  expect(res.status).toBe(404);
  const body = await res.json();
  expect(Array.isArray(body.keys)).toBe(true);
  expect(body.keys).toHaveLength(0);

  setTestKeyEnv();
});

test('JWKS route exposes the active signing key metadata', async () => {
  setTestKeyEnv();

  const res = await jwksRoute();
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.keys)).toBe(true);
  expect(body.keys).toHaveLength(1);

  const key = body.keys[0];
  expect(key.use).toBe('sig');
  expect(key.alg).toBe('EdDSA');
  expect(key.kid).toBe('test-key');
  expect(key.crv).toBe(TEST_PUBLIC_JWK.crv);
  expect(key.x).toBe(TEST_PUBLIC_JWK.x);
});
