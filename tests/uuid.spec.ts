import { test, expect } from '@playwright/test';
import { isUuid } from '../apps/shared/lib/uuid';

test('isUuid accepts UUIDv7 strings', () => {
  const v7 = '01890b14-b4cd-7eef-b13e-bb8c083bad60';
  expect(isUuid(v7)).toBe(true);
});

test('isUuid rejects malformed values', () => {
  expect(isUuid('not-a-uuid')).toBe(false);
  expect(isUuid('12345678-1234-1234-1234-1234567890')).toBe(false);
});
