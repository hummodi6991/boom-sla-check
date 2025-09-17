import { test, expect } from '@playwright/test';
import { verifyConversationLink } from '../apps/shared/lib/verifyLink';

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
