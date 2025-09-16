import { test, expect } from '@playwright/test';
import { GET } from '../app/r/legacy/[id]/route';
import { prisma } from '../lib/db';

test('legacy redirect returns 302 even if DB throws', async () => {
  const originalFindFirst = prisma.conversation.findFirst;
  prisma.conversation.findFirst = async () => {
    throw new Error('boom');
  };

  try {
    const res = await GET(new Request('http://test/r/legacy/981137'), {
      params: { id: '981137' },
    });
    expect([302, 307, 308]).toContain(res.status);
  } finally {
    prisma.conversation.findFirst = originalFindFirst;
  }
});
