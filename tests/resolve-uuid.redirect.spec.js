import { test, expect } from '@playwright/test';
import { tryResolveConversationUuid } from '../apps/server/lib/conversations.js';

const OLD_FETCH = global.fetch;

test.afterEach(() => { global.fetch = OLD_FETCH; });

test('redirect-probe: 302 Location header', async () => {
  global.fetch = async (_u, _o) => ({
    headers: new Map([[
      'location',
      'https://app.boomnow.com/go/c/123e4567-e89b-12d3-a456-426614174000'
    ]]),
    text: async () => '',
  });
  const got = await tryResolveConversationUuid('991130', {});
  expect(got).toBe('123e4567-e89b-12d3-a456-426614174000');
});

test('redirect-probe: 200 meta-refresh body', async () => {
  let calls = 0;
  global.fetch = async (_u, _o) => {
    calls++;
    if (calls === 1) {
      return { headers: new Map(), text: async () => '' };
    }
    return {
      headers: new Map(),
      text: async () => '<meta http-equiv="refresh" content="0; url=/go/c/123e4567-e89b-12d3-a456-426614174000">',
    };
  };
  const got = await tryResolveConversationUuid('991130', {});
  expect(got).toBe('123e4567-e89b-12d3-a456-426614174000');
});

test('redirect-probe: 200 location.replace body', async () => {
  let calls = 0;
  global.fetch = async (_u, _o) => {
    calls++;
    if (calls === 1) {
      return { headers: new Map(), text: async () => '' };
    }
    return {
      headers: new Map(),
      text: async () => '<script>location.replace("https://app.boomnow.com/go/c/123e4567-e89b-12d3-a456-426614174000")</script>',
    };
  };
  const got = await tryResolveConversationUuid('991130', {});
  expect(got).toBe('123e4567-e89b-12d3-a456-426614174000');
});

test('messages-probe: returns conversation_uuid', async () => {
  const got = await tryResolveConversationUuid('991130', {
    fetchFirstMessage: async () => ({ conversation_uuid: '123e4567-e89b-12d3-a456-426614174000' })
  });
  expect(got).toBe('123e4567-e89b-12d3-a456-426614174000');
});
