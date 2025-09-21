import { test, expect } from '@playwright/test';
import { buildCanonicalDeepLink } from '../packages/linking/src/deeplink.js';

test('buildCanonicalDeepLink prefers uuid route', () => {
  const url = buildCanonicalDeepLink({ appUrl: 'https://app.example.com', uuid: 'abc' });
  expect(url).toBe('https://app.example.com/dashboard/guest-experience/all?conversation=abc');
});

test('buildCanonicalDeepLink falls back to legacy id', () => {
  const url = buildCanonicalDeepLink({ appUrl: 'https://app.example.com/', legacyId: 42 });
  expect(url).toBe('https://app.example.com/dashboard/guest-experience/all?legacyId=42');
});

test('buildCanonicalDeepLink throws without identifier', () => {
  expect(() => buildCanonicalDeepLink({ appUrl: 'https://app.example.com' })).toThrow();
});
