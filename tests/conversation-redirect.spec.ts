import { test, expect } from '@playwright/test';
import { GET } from '../app/r/conversation/[slug]/route';
import { prisma } from '../lib/db';

function extractRedirect(err: unknown): string {
  if (err && typeof err === 'object' && 'digest' in err && typeof (err as any).digest === 'string') {
    const digest: string = (err as any).digest;
    const parts = digest.split(';');
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const candidate = parts[i];
      if (!candidate) continue;
      if (candidate.startsWith('http://') || candidate.startsWith('https://') || candidate.startsWith('/')) {
        return candidate;
      }
    }
  }
  return '';
}

test('conversation redirect resolves known slug to deep link', async () => {
  const uuid = '123e4567-e89b-12d3-a456-426614174000';
  prisma.conversation._data.set(99, { uuid, slug: 'known-slug' });
  let location = '';
  try {
    await GET(new Request('http://test/r/conversation/known-slug'), { params: { slug: 'known-slug' } });
  } catch (err) {
    location = extractRedirect(err);
  }
  expect(location).toBe(`http://test/dashboard/guest-experience/all?conversation=${uuid}`);
});

test('conversation redirect mints uuid when slug unknown', async () => {
  let location = '';
  try {
    await GET(new Request('http://test/r/conversation/new-slug'), { params: { slug: 'new-slug' } });
  } catch (err) {
    location = extractRedirect(err);
  }
  expect(location).toMatch(/conversation=/);
  expect(location).toMatch(/^http:\/\/test\/dashboard\/guest-experience\/all\?conversation=/);
});
