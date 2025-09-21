import { test, expect } from '@playwright/test';
import { GET } from '../app/r/legacy/[id]/route';
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

test('legacy redirect returns 302 even if DB throws', async () => {
  const originalFindFirst = prisma.conversation.findFirst;
  prisma.conversation.findFirst = async () => {
    throw new Error('boom');
  };

  try {
    let location = '';
    try {
      await GET(new Request('http://test/r/legacy/981137'), {
        params: { id: '981137' },
      });
    } catch (err) {
      location = extractRedirect(err);
    }
    expect(location).toMatch(/\/go\/c\//);
  } finally {
    prisma.conversation.findFirst = originalFindFirst;
  }
});
