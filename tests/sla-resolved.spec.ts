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

test('does not treat negated statuses as resolved', async () => {
  const statuses = ['Unresolved', 'not_resolved', 'not resolved', 'in_progress', 'reopened'];
  for (const status of statuses) {
    const ctx = { conversation: { status } };
    expect(isConversationResolved(ctx, [])).toBe(false);
  }
});

test('ignores unresolved system messages', async () => {
  const messages = [
    { module: 'status', type: 'change', body: 'Status changed to unresolved' },
  ];
  expect(isConversationResolved({}, messages)).toBe(false);
});

test('ignores conversation reopened messages', async () => {
  const messages = [
    { module: 'system', type: 'update', body: 'Conversation reopened by agent' },
  ];
  expect(isConversationResolved({}, messages)).toBe(false);
});
