import { test, expect } from '@playwright/test'
import { GET } from '../app/r/legacy/[id]/route'
import { prisma } from '../lib/db'

test('legacy redirect resolves to uuid deep link', async () => {
  const uuid = '123e4567-e89b-12d3-a456-426614174000'
  const legacyId = 1000576
  prisma.conversation._data.set(legacyId, { uuid, legacyId })
  const res = await GET(new Request(`http://test/r/legacy/${legacyId}`), { params: { id: String(legacyId) } })
  expect(res.status).toBe(302)
  expect(res.headers.get('location')).toBe(`https://app.boomnow.com/dashboard/guest-experience/cs?conversation=${uuid}`)
})

test('legacy redirect sends to conversation-not-found when uuid missing', async () => {
  const res = await GET(new Request('http://test/r/legacy/999'), { params: { id: '999' } })
  expect(res.status).toBe(302)
  expect(res.headers.get('location')).toBe('https://app.boomnow.com/conversation-not-found')
})

