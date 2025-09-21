import { test, expect } from '@playwright/test';

const originalFetch = global.fetch;

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

test.describe('resolveConversationUuidHedged', () => {
  test('falls back to probe when internal resolver stalls past hedge delay', async () => {
    const originalSecret = process.env.RESOLVE_SECRET;
    const originalBase = process.env.RESOLVE_BASE_URL;
    const originalApp = process.env.APP_URL;
    const originalHedge = process.env.HEDGE_MS;
    const originalAttempts = process.env.RESOLVER_MAX_ATTEMPTS;

    process.env.RESOLVE_SECRET = 'secret';
    process.env.RESOLVE_BASE_URL = 'https://internal.test';
    process.env.APP_URL = 'https://app.example.com';
    process.env.HEDGE_MS = '20';
    process.env.RESOLVER_MAX_ATTEMPTS = '2';

    const probeUuid = '123e4567-e89b-12d3-a456-426614174111';
    const internalUuid = '123e4567-e89b-12d3-a456-426614174222';

    let internalCalls = 0;

    global.fetch = (async (input: any) => {
      const url = typeof input === 'string' ? input : input?.url ?? '';
      if (url.includes('/api/resolve/conversation')) {
        internalCalls++;
        await new Promise((resolve) => setTimeout(resolve, 80));
        return {
          ok: true,
          status: 200,
          async json() {
            return { uuid: internalUuid };
          },
        } as any;
      }
      if (url.includes('/api/internal/resolve-conversation')) {
        return { ok: false, status: 404, async json() { return {}; } } as any;
      }
      if (url.includes('/api/resolve/any')) {
        return { ok: false, status: 404, async json() { return {}; } } as any;
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const mod = await import(`../apps/shared/lib/conversationUuid.js?hedge=${Date.now()}`);
      const { resolveConversationUuidHedged } = mod as any;

      const result = await resolveConversationUuidHedged('991130', {
        fetchFirstMessage: async () => ({ conversation_uuid: probeUuid }),
      });

      expect(result).toBe(probeUuid.toLowerCase());
      expect(internalCalls).toBe(1);
    } finally {
      restoreEnv('RESOLVE_SECRET', originalSecret);
      restoreEnv('RESOLVE_BASE_URL', originalBase);
      restoreEnv('APP_URL', originalApp);
      restoreEnv('HEDGE_MS', originalHedge);
      restoreEnv('RESOLVER_MAX_ATTEMPTS', originalAttempts);
      global.fetch = originalFetch;
    }
  });

  test('opens breaker after repeated 5xx responses and short-circuits later attempts', async () => {
    const originalSecret = process.env.RESOLVE_SECRET;
    const originalBase = process.env.RESOLVE_BASE_URL;
    const originalApp = process.env.APP_URL;
    const originalHedge = process.env.HEDGE_MS;
    const originalAttempts = process.env.RESOLVER_MAX_ATTEMPTS;

    process.env.RESOLVE_SECRET = 'secret';
    process.env.RESOLVE_BASE_URL = 'https://internal.test';
    process.env.APP_URL = 'https://app.example.com';
    process.env.HEDGE_MS = '5';
    process.env.RESOLVER_MAX_ATTEMPTS = '1';

    const fallbackUuid = '123e4567-e89b-12d3-a456-426614174333';
    let internalCalls = 0;

    global.fetch = (async (input: any) => {
      const url = typeof input === 'string' ? input : input?.url ?? '';
      if (url.includes('/api/resolve/conversation')) {
        internalCalls++;
        return {
          ok: false,
          status: 503,
          async json() {
            return {};
          },
        } as any;
      }
      if (url.includes('/api/internal/resolve-conversation')) {
        return { ok: false, status: 404, async json() { return {}; } } as any;
      }
      if (url.includes('/api/resolve/any')) {
        return { ok: false, status: 404, async json() { return {}; } } as any;
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const mod = await import(`../apps/shared/lib/conversationUuid.js?breaker=${Date.now()}`);
      const { resolveConversationUuidHedged } = mod as any;

      let lastCount = 0;
      let breakerOpened = false;

      for (let i = 0; i < 8; i++) {
        const result = await resolveConversationUuidHedged('991130', {
          fetchFirstMessage: async () => ({ conversation_uuid: fallbackUuid }),
        });
        expect(result).toBe(fallbackUuid.toLowerCase());
        if (internalCalls === lastCount) {
          breakerOpened = true;
          break;
        }
        lastCount = internalCalls;
      }

      expect(breakerOpened).toBe(true);
    } finally {
      restoreEnv('RESOLVE_SECRET', originalSecret);
      restoreEnv('RESOLVE_BASE_URL', originalBase);
      restoreEnv('APP_URL', originalApp);
      restoreEnv('HEDGE_MS', originalHedge);
      restoreEnv('RESOLVER_MAX_ATTEMPTS', originalAttempts);
      global.fetch = originalFetch;
    }
  });
});
