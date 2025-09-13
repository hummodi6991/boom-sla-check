import { test, expect } from '@playwright/test';
import { middleware } from '../middleware';
import { NextRequest } from 'next/server.js';
import { POST as loginRoute } from '../app/api/login/route';

const uuid = '123e4567-e89b-12d3-a456-426614174000';

test('GET /inbox/conversations/123 -> 308 cs deep link', async () => {
  const req = new NextRequest('https://app.boomnow.com/inbox/conversations/123');
  const res = await middleware(req);
  expect(res.status).toBe(308);
  expect(res.headers.get('location')).toBe(
    'https://app.boomnow.com/dashboard/guest-experience/cs?conversation=123'
  );
});

test('middleware redirects legacy /inbox?cid=uuid to /c', async () => {
  const req = new NextRequest(`https://app.boomnow.com/inbox?cid=${uuid}`);
  const res = await middleware(req);
  expect(res.status).toBe(308);
  expect(res.headers.get('location')).toBe(
    `https://app.boomnow.com/dashboard/guest-experience/cs?conversation=${uuid}`
  );
});

test('POST /api/login with next=dashboard link -> 303 to that path', async () => {
  const next = `/dashboard/guest-experience/cs?conversation=${uuid}`;
  const body = new URLSearchParams({
    email: 'test@example.com',
    password: 'x',
    next,
  });
  const req = new Request('https://app.boomnow.com/api/login', {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  const res = await loginRoute(req);
  expect(res.status).toBe(303);
  expect(res.headers.get('location')).toBe(
    `https://app.boomnow.com${next}`
  );
});
