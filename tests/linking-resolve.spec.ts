import { test, expect } from '@playwright/test';
import { resolveConversation } from '../packages/linking/src/resolve.js';
import { prisma } from '../lib/db.js';
import { mintUuidFromRaw } from '../apps/shared/lib/canonicalConversationUuid.js';

const CONV_MAP = prisma.conversation._data;
const ALIAS_MAP = prisma.conversation_aliases._data;

test.beforeEach(() => {
  CONV_MAP.clear();
  ALIAS_MAP.clear();
});

test('resolveConversation returns direct uuid', async () => {
  const result = await resolveConversation({ uuid: '123e4567-e89b-12d3-a456-426614174000' });
  expect(result).toEqual({ uuid: '123e4567-e89b-12d3-a456-426614174000' });
});

test('resolveConversation looks up legacy id via database', async () => {
  CONV_MAP.set(1010993, { legacyId: 1010993, uuid: '11111111-2222-4333-8444-555555555555' });
  const result = await resolveConversation({ legacyId: 1010993 });
  expect(result).toEqual({ uuid: '11111111-2222-4333-8444-555555555555' });
});

test('resolveConversation resolves slug via alias table', async () => {
  const aliasUuid = '01890b14-b4cd-7eef-b13e-bb8c083bad60';
  ALIAS_MAP.set(0, { legacy_id: 0, slug: 'support-slug', uuid: aliasUuid });
  const result = await resolveConversation({ slug: 'support-slug' });
  expect(result).toEqual({ uuid: aliasUuid });
});

test('resolveConversation mints uuid when allowed and nothing else resolves', async () => {
  const slug = 'mint-me';
  const result = await resolveConversation({ slug });
  expect(result?.uuid).toBe(mintUuidFromRaw(slug));
});

test('resolveConversation returns null when minting disabled', async () => {
  const result = await resolveConversation({ slug: 'mint-me', allowMintFallback: false });
  expect(result).toBeNull();
});
