import { NextResponse } from 'next/server.js'
import { prisma } from '../../../../lib/db'

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i
const appUrl = () => {
  let url = process.env.APP_URL ?? 'https://app.boomnow.com'
  while (url.endsWith('/')) url = url.slice(0, -1)
  return url
}

async function resolveUuid(legacyIdStr: string) {
  const n = Number(legacyIdStr)
  if (!Number.isInteger(n)) return null

  // optional fast path if you have an alias table
  try {
    const alias = await prisma.conversation_aliases?.findUnique({ where: { legacy_id: n } })
    if (alias?.uuid && UUID_RE.test(alias.uuid)) return alias.uuid.toLowerCase()
  } catch {}

  const row = await prisma.conversation.findFirst({ where: { legacyId: n }, select: { uuid: true } })
  return row?.uuid && UUID_RE.test(row.uuid) ? row.uuid.toLowerCase() : null
}

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const revalidate = 0

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const base = appUrl()
  const uuid = await resolveUuid(params.id)

  const target = uuid
    ? `${base}/dashboard/guest-experience/cs?conversation=${encodeURIComponent(uuid)}`
    : `${base}/conversation-not-found`

  const html = `<!doctype html>
    <meta http-equiv="refresh" content="0; url=${target}">
    <script>try{location.replace(${JSON.stringify(target)})}catch(e){location.href=${JSON.stringify(target)}}<\/script>`
  return new NextResponse(html, {
    status: 302,
    headers: { Location: target, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
  })
}

