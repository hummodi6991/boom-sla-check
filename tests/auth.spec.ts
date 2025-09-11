import { test, expect } from '@playwright/test';
import { middleware } from '../middleware';
import { NextRequest } from 'next/server.js';
import { POST as loginRoute } from '../app/api/login/route';
import { GET as convoRoute } from '../app/r/conversation/[id]/route';

test('Unauthed GET /inbox/conversations/123 -> 307 /login?next=/inbox?cid=123', async () => {
  const req = new NextRequest('https://app.boomnow.com/inbox/conversations/123');
  const res = await middleware(req);
  expect(res.status).toBe(307);
  expect(res.headers.get('location')).toBe('https://app.boomnow.com/login?next=/inbox?cid=123');
});

test('POST /api/login with next=/inbox?cid=123 -> 303 to that path', async () => {
  const body = new URLSearchParams({ email: 'test@example.com', password: 'x', next: '/inbox?cid=123' });
  const req = new Request('https://app.boomnow.com/api/login', {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  const res = await loginRoute(req);
  expect(res.status).toBe(303);
  expect(res.headers.get('location')).toBe('https://app.boomnow.com/inbox?cid=123');
});

test('GET /r/conversation/123 -> 307 /inbox/conversations/123', async () => {
  const req = new Request('https://app.boomnow.com/r/conversation/123');
  const res = await convoRoute(req, { params: { id: '123' } });
  expect(res.status).toBe(307);
  expect(res.headers.get('location')).toBe('https://app.boomnow.com/inbox/conversations/123');
});
