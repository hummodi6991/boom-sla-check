import { test, expect } from '@playwright/test';
import { makeLinkToken, verifyLinkToken } from '../apps/shared/lib/linkToken';
import { GET as tokenRoute } from '../app/r/t/[token]/route';
import { conversationDeepLinkFromUuid } from '../apps/shared/lib/links';

const uuid = '123e4567-e89b-12d3-a456-426614174000';

function setSecret() {
  process.env.LINK_SECRET = 'test-secret';
}

test('token round-trip', () => {
  setSecret();
  const tok = makeLinkToken({ uuid, exp: Math.floor(Date.now() / 1000) + 60 });
  const res = verifyLinkToken(tok);
  expect('uuid' in res ? res.uuid : null).toBe(uuid);
});

test('token tamper fails', () => {
  setSecret();
  const tok = makeLinkToken({ uuid, exp: Math.floor(Date.now() / 1000) + 60 });
  const bad = (tok[0] === 'a' ? 'b' : 'a') + tok.slice(1);
  const res = verifyLinkToken(bad);
  expect('error' in res).toBe(true);
});

test('token expiry fails', () => {
  setSecret();
  const tok = makeLinkToken({ uuid, exp: Math.floor(Date.now() / 1000) - 10 });
  const res = verifyLinkToken(tok);
  expect(res).toEqual({ error: 'expired' });
});

test('GET /r/t/:token redirects', async () => {
  setSecret();
  const tok = makeLinkToken({ uuid, exp: Math.floor(Date.now() / 1000) + 60 });
  const req = new Request(`https://app.boomnow.com/r/t/${tok}`);
  const res = await tokenRoute(req, { params: { token: tok } });
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toBe(conversationDeepLinkFromUuid(uuid));
});

test('GET /r/t/:token prefers request origin for localhost', async () => {
  setSecret();
  process.env.APP_URL = 'https://app.boomnow.com';
  const tok = makeLinkToken({ uuid, exp: Math.floor(Date.now() / 1000) + 60 });
  const req = new Request(`http://localhost:9999/r/t/${tok}`);
  const res = await tokenRoute(req, { params: { token: tok } });
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toBe(
    conversationDeepLinkFromUuid(uuid, { baseUrl: 'http://localhost:9999' })
  );
  delete process.env.APP_URL;
});
