import { test, expect } from '@playwright/test';
import { tryResolveConversationUuid } from '../apps/server/lib/conversations'; // TS bridge

const UUID = '123e4567-e89b-12d3-a456-426614174000';

test('TS conversations.ts re-exports robust JS implementation (redirect-probe works)', async () => {
  const OLD = global.fetch;
  try {
    // Simulate redirect-probe path returning deep link with UUID
    global.fetch = (async () =>
      ({
        headers: new Map([
          ['location', `https://app.boomnow.com/go/c/${UUID}`],
        ]),
        text: async () => '',
      } as any)) as any;
    const got = await tryResolveConversationUuid('991130', {});
    expect(got).toBe(UUID);
  } finally {
    global.fetch = OLD as any;
  }
});
