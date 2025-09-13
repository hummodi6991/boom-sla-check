import { test, expect } from '@playwright/test';
import { tryResolveConversationUuid } from '../apps/server/lib/conversations.js';

test('mines uuid from inlineThread messages (body contains deep link)', async () => {
  const uuid = '123e4567-e89b-12d3-a456-426614174000';
  const inlineThread = {
    messages: [{ body: `see https://app.boomnow.com/dashboard/guest-experience/cs?conversation=${uuid}` }],
  };
  const got = await tryResolveConversationUuid('991130', { inlineThread });
  expect(got).toBe(uuid);
});

test('mines uuid from structured conversation.uuid in messages', async () => {
  const uuid = '123e4567-e89b-12d3-a456-426614174000';
  const inlineThread = { messages: [{ conversation: { uuid } }] };
  const got = await tryResolveConversationUuid('995536', { inlineThread });
  expect(got).toBe(uuid);
});
