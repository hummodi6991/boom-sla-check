import { test, expect } from '@playwright/test';
import { resolveConversationToken } from '../app/go/c/[token]/route';
import { prisma } from '../lib/db';

const DIRECT_UUID = '01890b14-b4cd-7eef-b13e-bb8c083bad70';
const LEGACY_ID = 445566;
const LEGACY_UUID = '01890b14-b4cd-7eef-b13e-bb8c083bad71';
const SLUG = 'suite-guest-checkin';
const SLUG_UUID = '01890b14-b4cd-7eef-b13e-bb8c083bad72';

test.beforeEach(() => {
  prisma.conversation._data.clear();
  prisma.conversation_aliases._data.clear();
});

test('resolveConversationToken returns uuid as-is when provided', async () => {
  await expect(resolveConversationToken(DIRECT_UUID)).resolves.toBe(DIRECT_UUID.toLowerCase());
});

test('resolveConversationToken looks up legacy ids in prisma conversation store', async () => {
  prisma.conversation._data.set(LEGACY_ID, { uuid: LEGACY_UUID, legacyId: LEGACY_ID });
  await expect(resolveConversationToken(String(LEGACY_ID))).resolves.toBe(LEGACY_UUID.toLowerCase());
});

test('resolveConversationToken resolves slugs to their canonical uuid', async () => {
  prisma.conversation._data.set(LEGACY_ID + 1, { uuid: SLUG_UUID, slug: SLUG });
  await expect(resolveConversationToken(SLUG)).resolves.toBe(SLUG_UUID.toLowerCase());
});

test('resolveConversationToken returns null when lookup fails', async () => {
  await expect(resolveConversationToken('missing-conversation')).resolves.toBeNull();
});
