import { listMessagesPage } from "../services/messages";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type PoolItem = { convId: string; lastGuestTs: number };

function isGuestMessage(m: any): boolean {
  // adapt to your schema; keep it strict
  return m?.senderRole === "guest" || m?.direction === "inbound" || m?.from === "guest";
}
function tsFromMessage(m: any): number {
  return Number(m?.timestamp || m?.createdAt || m?.date || 0);
}

function readWatermark(): number | undefined {
  const p = join(".state", "lastProcessedMessageTs.json");
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8"))?.lastProcessedMessageTs;
  } catch {
    return undefined;
  }
}
function writeWatermark(ts: number) {
  const dir = ".state";
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "lastProcessedMessageTs.json"), JSON.stringify({ lastProcessedMessageTs: ts }), "utf8");
}

export async function buildPoolFromMessages(target = Number(process.env.POOL_SIZE ?? 50)) {
  const seen = new Set<string>();
  const pool: PoolItem[] = [];

  const tolerance = Number(process.env.POOL_TOLERANCE_MS ?? 120000);
  const watermark = readWatermark();
  const since = watermark ? Math.max(0, watermark - tolerance) : undefined;

  let cursor: string | undefined = undefined;
  let maxSeenTs = watermark ?? 0;

  do {
    const page = await listMessagesPage({ order: "desc", cursor, since }); // must return { items, nextCursor }
    for (const m of page.items ?? []) {
      const convId = m?.conversationId ?? m?.conversation_id;
      const ts = tsFromMessage(m);
      if (ts > maxSeenTs) maxSeenTs = ts;

      if (!convId || !isGuestMessage(m)) continue;
      if (seen.has(convId)) continue;

      seen.add(convId);
      pool.push({ convId, lastGuestTs: ts });

      if (pool.length >= target) break;
    }
    if (pool.length >= target) break;
    cursor = (page as any).nextCursor;
  } while (cursor);

  // newest by guest activity
  pool.sort((a, b) => b.lastGuestTs - a.lastGuestTs);

  // advance watermark even if we found < target (prevents misses)
  if (maxSeenTs) writeWatermark(maxSeenTs);

  return pool;
}
