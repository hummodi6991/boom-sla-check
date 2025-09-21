import { test, expect } from '@playwright/test';
import { buildAlertEmail } from '../apps/worker/mailer/alerts';
import { verifyConversationLink } from '../apps/shared/lib/verifyLink';
import { setTestKeyEnv } from './helpers/testKeys';

function snapshotEnv(keys: string[]) {
  const snapshot = new Map<string, string | undefined>();
  for (const key of keys) {
    snapshot.set(key, process.env[key]);
  }
  return {
    restore() {
      for (const [key, value] of snapshot.entries()) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    },
  };
}

test('verifyConversationLink accepts 303/307/308 to login or deep link', async () => {
  const orig = global.fetch;
  function fake(status: number, location?: string) {
    return async () =>
      ({
        status,
        headers: new Map(location ? [['location', location]] : []),
      } as any);
  }
  try {
    global.fetch = fake(303, 'https://app.boomnow.com/login');
    await expect(verifyConversationLink('https://example.com/x')).resolves.toBe(true);

    global.fetch = fake(
      307,
      'https://app.boomnow.com/dashboard/guest-experience/all?conversation=123e4567-e89b-12d3-a456-426614174000',
    );
    await expect(verifyConversationLink('https://example.com/x')).resolves.toBe(true);

    // 308 with unrelated location -> false
    global.fetch = fake(308, 'https://app.boomnow.com/somewhere-else');
    await expect(verifyConversationLink('https://example.com/x')).resolves.toBe(false);
  } finally {
    global.fetch = orig as any;
  }
});

test('mailer emits /u/<jwt> in production', async () => {
  const uuid = '01890b14-b4cd-7eef-b13e-bb8c083bad60';
  const env = snapshotEnv([
    'REQUIRE_SIGNED_ALERT_LINKS',
    'ALERT_LINK_BASE',
    'TARGET_APP_URL',
    'LINK_PRIVATE_JWK',
    'LINK_PUBLIC_JWKS',
    'LINK_KID',
    'LINK_ISSUER',
    'LINK_AUDIENCE',
    'LINK_JWKS_URL',
    'LINK_SECRET',
    'LINK_PRIVATE_KEY_PEM',
    'LINK_PUBLIC_KEY_PEM',
  ]);
  try {
    process.env.REQUIRE_SIGNED_ALERT_LINKS = '1';
    process.env.ALERT_LINK_BASE = 'https://go.example.com';
    process.env.TARGET_APP_URL = 'https://app.example.com';
    setTestKeyEnv();

    const html = await buildAlertEmail({ conversation_uuid: uuid }, { verify: async () => true });
    expect(html).toBeTruthy();
    const href = html?.match(/href="([^"]+)"/i)?.[1];
    expect(href).toBeDefined();
    expect(href?.startsWith('https://go.example.com/u/')).toBe(true);
  } finally {
    env.restore();
  }
});

test('guard blocks when keys missing', async () => {
  const uuid = '01890b14-b4cd-7eef-b13e-bb8c083bad60';
  const env = snapshotEnv([
    'REQUIRE_SIGNED_ALERT_LINKS',
    'ALERT_LINK_BASE',
    'TARGET_APP_URL',
    'LINK_PRIVATE_JWK',
    'LINK_PUBLIC_JWKS',
    'LINK_KID',
    'LINK_ISSUER',
    'LINK_AUDIENCE',
    'LINK_JWKS_URL',
    'LINK_SECRET',
    'LINK_PRIVATE_KEY_PEM',
    'LINK_PUBLIC_KEY_PEM',
  ]);
  try {
    process.env.REQUIRE_SIGNED_ALERT_LINKS = '1';
    process.env.ALERT_LINK_BASE = 'https://go.example.com';
    process.env.TARGET_APP_URL = 'https://app.example.com';
    setTestKeyEnv();
    delete process.env.LINK_PRIVATE_JWK;

    await expect(
      buildAlertEmail({ conversation_uuid: uuid }, { verify: async () => true })
    ).rejects.toThrow(
      /Signed alert links required/
    );
  } finally {
    env.restore();
  }
});
