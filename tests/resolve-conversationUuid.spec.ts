import { test, expect } from '@playwright/test';
import { resolveConversationUuid } from '../apps/shared/lib/conversationUuid.js';

function toUrl(input: any): string {
  if (typeof input === 'string') return input;
  if (input && typeof input.url === 'string') return input.url;
  return String(input ?? '');
}

test.describe('resolveConversationUuid fallback', () => {
  test('falls back to public resolver when local + internal resolvers unavailable', async () => {
    const originalSecret = process.env.RESOLVE_SECRET;
    const originalBase = process.env.RESOLVE_BASE_URL;
    const originalPublic = process.env.RESOLVE_PUBLIC_BASE_URL;
    const originalApp = process.env.APP_URL;
    const originalFetch = global.fetch;

    delete process.env.RESOLVE_SECRET;
    delete process.env.RESOLVE_BASE_URL;
    delete process.env.RESOLVE_PUBLIC_BASE_URL;
    process.env.APP_URL = 'https://app.example.com';

    const expectedUuid = '123e4567-e89b-12d3-a456-426614174000';
    const requests: string[] = [];

    global.fetch = (async (input: any, init?: any) => {
      const url = toUrl(input);
      requests.push(url);
      if (url.startsWith('https://app.example.com/api/resolve/any')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { uuid: expectedUuid };
          },
        } as any;
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const resolved = await resolveConversationUuid('991130', {
        allowMintFallback: false,
        skipRedirectProbe: true,
      });

      expect(resolved).toBe(expectedUuid);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toContain('/api/resolve/any?id=991130');
    } finally {
      if (originalSecret !== undefined) {
        process.env.RESOLVE_SECRET = originalSecret;
      } else {
        delete process.env.RESOLVE_SECRET;
      }
      if (originalBase !== undefined) {
        process.env.RESOLVE_BASE_URL = originalBase;
      } else {
        delete process.env.RESOLVE_BASE_URL;
      }
      if (originalPublic !== undefined) {
        process.env.RESOLVE_PUBLIC_BASE_URL = originalPublic;
      } else {
        delete process.env.RESOLVE_PUBLIC_BASE_URL;
      }
      if (originalApp !== undefined) {
        process.env.APP_URL = originalApp;
      } else {
        delete process.env.APP_URL;
      }
      global.fetch = originalFetch;
    }
  });
});
