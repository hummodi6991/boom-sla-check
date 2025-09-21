import { test, expect } from '@playwright/test'
import { GET } from '../app/r/legacy/[id]/route'
import { prisma } from '../lib/db'

function extractRedirect(err: unknown): string {
  if (err && typeof err === 'object' && 'digest' in err && typeof (err as any).digest === 'string') {
    const digest: string = (err as any).digest
    const parts = digest.split(';')
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const candidate = parts[i]
      if (!candidate) continue
      if (candidate.startsWith('http://') || candidate.startsWith('https://') || candidate.startsWith('/')) {
        return candidate
      }
    }
  }
  return ''
}

test('legacy redirect resolves to uuid deep link', async () => {
  const uuid = '123e4567-e89b-12d3-a456-426614174000'
  const legacyId = 1000576
  prisma.conversation._data.set(legacyId, { uuid, legacyId })
  let location = ''
  try {
    await GET(new Request(`http://test/r/legacy/${legacyId}`), { params: { id: String(legacyId) } })
  } catch (err) {
    location = extractRedirect(err)
  }
  expect(location).toBe(`http://test/go/c/${uuid}`)
})

test('legacy redirect mints deterministic uuid when mapping missing', async () => {
  let location = ''
  try {
    await GET(new Request('http://test/r/legacy/999'), { params: { id: '999' } })
  } catch (err) {
    location = extractRedirect(err)
  }
  expect(location).toMatch(/^http:\/\/test\/go\/c\//)
})

test('legacy redirect resolves via alias when conversation missing', async () => {
  const uuid = '123e4567-e89b-12d3-a456-426614174111'
  const legacyId = 4321
  prisma.conversation_aliases._data.set(legacyId, {
    legacy_id: legacyId,
    uuid,
    last_seen_at: new Date(),
  })

  let location = ''
  try {
    await GET(new Request(`http://test/r/legacy/${legacyId}`), {
      params: { id: String(legacyId) },
    })
  } catch (err) {
    location = extractRedirect(err)
  }

  expect(location).toBe(`http://test/go/c/${uuid}`)

  prisma.conversation_aliases._data.delete(legacyId)
})

