import { getNewest50 } from '@/src/fetchConversations';

global.fetch = jest.fn();

test('prefers platform-wide endpoint', async () => {
  (fetch as jest.Mock).mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));
  process.env.PLATFORM_TOP50_URL = 'https://api/top50';
  const res = await getNewest50();
  expect(fetch).toHaveBeenCalledWith('https://api/top50', undefined);
  expect(Array.isArray(res)).toBe(true);
});
