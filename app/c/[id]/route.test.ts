/**
 * Minimal unit test to verify redirects from /c/:id.
 * Uses a simple mock for global.fetch and NextRequest/NextResponse.
 */
import { GET } from './route';
import { NextRequest } from 'next/server';

const mkReq = (url: string) => new NextRequest(url);

describe('GET /c/:id', () => {
  const base = 'https://app.boomnow.com';

  beforeEach(() => {
    // @ts-ignore
    global.fetch = jest.fn();
    process.env.BOOM_API_BASE = 'https://api.example';
    process.env.BOOM_API_TOKEN = 'tok';
    process.env.BOOM_ORG_ID = 'org';
  });

  it('redirects UUID directly to dashboard', async () => {
    const uuid = '6a79ee22-5763-4e24-8b43-942840060b61';
    const res = await GET(mkReq(`${base}/c/${uuid}`), { params: { id: uuid } });
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe(`${base}/dashboard/guest-experience/all?conversation=${uuid}`);
  });

  it('resolves numeric id via API then redirects', async () => {
    const legacy = '997715';
    const uuid = '6a79ee22-5763-4e24-8b43-942840060b61';
    // @ts-ignore
    global.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ uuid }), { status: 200 }));
    const res = await GET(mkReq(`${base}/c/${legacy}`), { params: { id: legacy } });
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe(`${base}/dashboard/guest-experience/all?conversation=${uuid}`);
  });

  it('falls back gracefully when resolution fails', async () => {
    const legacy = '123456';
    // @ts-ignore
    global.fetch.mockResolvedValueOnce(new Response('', { status: 404 }));
    const res = await GET(mkReq(`${base}/c/${legacy}`), { params: { id: legacy } });
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/dashboard/guest-experience/all');
  });
});
