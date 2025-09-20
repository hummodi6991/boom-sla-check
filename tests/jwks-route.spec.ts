import { test, expect } from '@playwright/test';
import { importSPKI, exportJWK } from 'jose';
import { GET as jwksRoute } from '../app/.well-known/jwks.json/route';
import { __test__ as linkTokenTestUtils } from '../lib/linkTokensCore.js';
import { setTestKeyEnv, TEST_PUBLIC_KEY } from './helpers/testKeys';

test('JWKS route returns 404 when no signing key is configured', async () => {
  linkTokenTestUtils?.resetCaches?.();
  delete process.env.LINK_PRIVATE_KEY_PEM;
  delete process.env.LINK_PUBLIC_KEY_PEM;
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
  expect(key.alg).toBe('RS256');
  expect(key.kid).toBe('test-key');

  const expected = await exportJWK(await importSPKI(TEST_PUBLIC_KEY, 'RS256'));
  expect(key.n).toBe(expected.n);
  expect(key.e).toBe(expected.e);
});
