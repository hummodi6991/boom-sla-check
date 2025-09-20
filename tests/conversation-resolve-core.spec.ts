import { test, expect } from '@playwright/test';
import { resolveConversationUuid, conversationDeepLink, mintUuidFromRaw } from '../src/lib/conversation/resolve';
import { prisma } from '../lib/db';

const ORIGINAL_NAMESPACE = process.env.CONVERSATION_UUID_NAMESPACE;

test.beforeEach(() => {
  prisma.conversation._data.clear();
  prisma.conversation_aliases._data.clear();
  process.env.CONVERSATION_UUID_NAMESPACE = '3f3aa693-5b5d-4f6a-9c8e-7b7a1d1d8b7a';
});

test.afterAll(() => {
  if (ORIGINAL_NAMESPACE !== undefined) {
    process.env.CONVERSATION_UUID_NAMESPACE = ORIGINAL_NAMESPACE;
  } else {
    delete process.env.CONVERSATION_UUID_NAMESPACE;
  }
});

test('resolveConversationUuid returns existing uuid for slug', async () => {
  const slug = 'known-slug';
  const uuid = '123e4567-e89b-12d3-a456-426614174111';
  prisma.conversation._data.set(1, { uuid, slug });
  const resolved = await resolveConversationUuid(slug, { allowMintFallback: true });
  expect(resolved).toEqual({ uuid, minted: false });
});

test('resolveConversationUuid returns alias uuid for legacy id', async () => {
  const uuid = '123e4567-e89b-12d3-a456-426614174222';
  prisma.conversation_aliases._data.set(42, {
    legacy_id: 42,
    uuid,
    slug: 'legacy-alias',
    last_seen_at: new Date(),
  });
  const resolved = await resolveConversationUuid('42', { allowMintFallback: true });
  expect(resolved).toEqual({ uuid, minted: false });
});

test('resolveConversationUuid mints uuid for numeric identifier when missing', async () => {
  const resolved = await resolveConversationUuid('555', { allowMintFallback: true });
  expect(resolved?.minted).toBe(true);
  expect(resolved?.uuid).toBe(mintUuidFromRaw('555'));
});

test('resolveConversationUuid mints uuid for slug when missing', async () => {
  const slug = 'missing-slug';
  const resolved = await resolveConversationUuid(slug, { allowMintFallback: true });
  expect(resolved?.minted).toBe(true);
  expect(resolved?.uuid).toBe(mintUuidFromRaw(slug));
});

test('minted uuid is stable across calls', async () => {
  const first = await resolveConversationUuid('stability-check', { allowMintFallback: true });
  const second = await resolveConversationUuid('stability-check', { allowMintFallback: true });
  expect(first?.uuid).toBe(second?.uuid);
  expect(first?.minted).toBe(true);
});

test('resolveConversationUuid returns null for empty input', async () => {
  const resolved = await resolveConversationUuid('', { allowMintFallback: true });
  expect(resolved).toBeNull();
});

test('conversationDeepLink builds absolute deep link with base', () => {
  const uuid = '123e4567-e89b-12d3-a456-426614174000';
  const link = conversationDeepLink(uuid, 'https://app.example.com');
  expect(link).toBe(`https://app.example.com/dashboard/guest-experience/all?conversation=${uuid}`);
});

