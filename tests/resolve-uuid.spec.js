import { test, expect } from '@playwright/test';
import { tryResolveConversationUuid } from '../apps/server/lib/conversations.js';
import { prisma } from '../lib/db.js';

const aliasStore = prisma?.conversation_aliases?._data;

async function withAlias(
  { legacyId, slug, uuid },
  fn,
) {
  const store = aliasStore;
  const had = Boolean(store?.has?.(legacyId));
  const prev = had ? store?.get?.(legacyId) : undefined;
  await prisma.conversation_aliases.upsert({
    where: { legacy_id: legacyId },
    create: { legacy_id: legacyId, uuid, slug },
    update: { uuid, slug },
  });
  try {
    await fn();
  } finally {
    if (!store) return;
    if (had) {
      store.set(legacyId, prev);
    } else {
      store.delete(legacyId);
    }
  }
}

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

test('resolves slug via alias when conversation record is missing', async () => {
  const uuid = '123e4567-e89b-12d3-a456-426614174000';
  const slug = 'alias-only-slug-test';
  await withAlias({ legacyId: 40123, slug, uuid }, async () => {
    const got = await tryResolveConversationUuid(slug, {});
    expect(got).toBe(uuid);
  });
});

test('mines slug from inlineThread via alias when uuid absent', async () => {
  const uuid = '123e4567-e89b-12d3-a456-426614174000';
  const slug = 'inline-thread-alias-slug';
  await withAlias({ legacyId: 40124, slug, uuid }, async () => {
    const inlineThread = { messages: [{ conversation_slug: slug }] };
    const got = await tryResolveConversationUuid('no-match', { inlineThread });
    expect(got).toBe(uuid);
  });
});
