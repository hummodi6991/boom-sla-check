import { test, expect } from '@playwright/test';
import { isConversationResolved } from '../src/lib/isResolved.js';

test('detects resolution via status string', async () => {
  const ctx = { conversation: { status: 'Resolved' } };
  expect(isConversationResolved(ctx, [])).toBe(true);
});

test('detects resolution via closed_at timestamp', async () => {
  const ctx = { conversation: { closed_at: '2024-01-01T00:00:00Z' } };
  expect(isConversationResolved(ctx, [])).toBe(true);
});

test('detects resolution via system/status message', async () => {
  const msgs = [{ module: 'status', type: 'change', body: 'Conversation closed by agent' }];
  expect(isConversationResolved({}, msgs)).toBe(true);
});

test('stays false for open threads', async () => {
  const ctx = { conversation: { status: 'open' } };
  expect(isConversationResolved(ctx, [])).toBe(false);
});
