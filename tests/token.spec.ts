import { test, expect } from '@playwright/test';
import { signLinkToken, verifyLinkToken } from '../apps/shared/lib/linkToken';
import { GET as tokenRoute } from '../app/r/t/[token]/route';
import { conversationDeepLink } from '../src/lib/conversation/resolve';
import { setTestKeyEnv } from './helpers/testKeys';

const uuid = '123e4567-e89b-12d3-a456-426614174000';

function extractRedirect(err: unknown): string {
  if (err && typeof err === 'object' && 'digest' in err && typeof (err as any).digest === 'string') {
    const digest: string = (err as any).digest;
    const parts = digest.split(';');
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const candidate = parts[i];
      if (!candidate) continue;
      if (candidate.startsWith('http://') || candidate.startsWith('https://') || candidate.startsWith('/')) {
        return candidate;
      }
    }
  }
  return '';
}

test.beforeEach(() => {
  setTestKeyEnv();
});

test('token round-trip', async () => {
  const tok = await signLinkToken({ conversation: uuid }, '1h');
  const res = await verifyLinkToken(tok);
  expect(res.payload.conversation).toBe(uuid);
});

test('token tamper fails', async () => {
  const tok = await signLinkToken({ conversation: uuid }, '1h');
  const bad = (tok[0] === 'a' ? 'b' : 'a') + tok.slice(1);
  await expect(verifyLinkToken(bad)).rejects.toThrow();
});

test('token expiry fails', async () => {
  const tok = await signLinkToken({ conversation: uuid }, '1s');
  await new Promise((r) => setTimeout(r, 1500));
  await expect(verifyLinkToken(tok)).rejects.toThrow(/exp/);
});

test('GET /r/t/:token redirects', async () => {
  const tok = await signLinkToken({ conversation: uuid }, '1h');
  const req = new Request(`https://app.boomnow.com/r/t/${tok}`);
  let location = '';
  try {
    await tokenRoute(req, { params: { token: tok } });
  } catch (err) {
    location = extractRedirect(err);
  }
  expect(location).toBe(conversationDeepLink(uuid, 'https://app.boomnow.com'));
});

test('GET /r/t/:token prefers request origin for localhost', async () => {
  process.env.APP_URL = 'https://app.boomnow.com';
  const tok = await signLinkToken({ conversation: uuid }, '1h');
  const req = new Request(`http://localhost:9999/r/t/${tok}`);
  let location = '';
  try {
    await tokenRoute(req, { params: { token: tok } });
  } catch (err) {
    location = extractRedirect(err);
  }
  expect(location).toBe(conversationDeepLink(uuid, 'http://localhost:9999'));
  delete process.env.APP_URL;
});

test('GET /r/t/:token falls back to backup conversation query parameter', async () => {
  const backupUuid = '01890b14-b4cd-7eef-b13e-bb8c083bad60';
  const badToken = 'malformed-token';
  const req = new Request(
    `https://app.boomnow.com/r/t/${badToken}?conversation=${backupUuid}`,
  );
  let location = '';
  try {
    await tokenRoute(req, { params: { token: badToken } });
  } catch (err) {
    location = extractRedirect(err);
  }
  expect(location).toBe(conversationDeepLink(backupUuid, 'https://app.boomnow.com'));
});

test('GET /r/t/:token without backup query redirects to expired message', async () => {
  const badToken = 'still-malformed';
  const req = new Request(`https://app.boomnow.com/r/t/${badToken}`);
  let location = '';
  try {
    await tokenRoute(req, { params: { token: badToken } });
  } catch (err) {
    location = extractRedirect(err);
  }
  expect(location).toBe('/dashboard/guest-experience/all?m=link-expired');
});
