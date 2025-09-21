import { test, expect } from '@playwright/test';
import { buildCanonicalDeepLink } from '../packages/linking/src/deeplink.js';

test('buildCanonicalDeepLink prefers uuid route', () => {
  const url = buildCanonicalDeepLink({ appUrl: 'https://app.example.com', uuid: 'abc' });
  expect(url).toBe('https://app.example.com/go/c/abc');
});

test('buildCanonicalDeepLink falls back to legacy id', () => {
  const url = buildCanonicalDeepLink({ appUrl: 'https://app.example.com/', legacyId: 42 });
  expect(url).toBe('https://app.example.com/go/c/42');
});

test('buildCanonicalDeepLink supports slug tokens', () => {
  const url = buildCanonicalDeepLink({ appUrl: 'https://app.example.com', slug: 'welcome-guests' });
  expect(url).toBe('https://app.example.com/go/c/welcome-guests');
});

test('buildCanonicalDeepLink throws without identifier', () => {
  expect(() => buildCanonicalDeepLink({ appUrl: 'https://app.example.com' })).toThrow(
    'identifier_required'
  );
});
