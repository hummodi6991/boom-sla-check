export type WithTimestamp = { id: string; lastActivityAt: string };

function keyOf(ts: string, id: string): number {
  // Combine timestamp + tie-breaker (id) for stable ordering
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return Number.MIN_SAFE_INTEGER;
  // Push id hash into the fractional part to break ties deterministically
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return t + (h % 997) / 1000;
}

/** Return the objective newest 50, sorted desc by lastActivityAt (stable tiebreak by id). */
export function selectTop50<T extends WithTimestamp>(items: T[]): T[] {
  // Keep it simple: full sort then slice. n log n is fine for a couple thousand.
  const sorted = [...items].sort((a, b) => {
    const kb = keyOf(b.lastActivityAt, b.id);
    const ka = keyOf(a.lastActivityAt, a.id);
    return kb - ka;
  });
  return sorted.slice(0, 50);
}

/** Debug guard: ensure none of the skipped items is newer than the slowest of the selected 50. */
export function assertTop50<T extends WithTimestamp>(all: T[], selected: T[]): void {
  if (selected.length === 0) return;
  const oldestSelected = selected[selected.length - 1];
  const cutoff = Date.parse(oldestSelected.lastActivityAt);
  const offenders = all.filter(
    x => Date.parse(x.lastActivityAt) > cutoff && !selected.some(s => s.id === x.id)
  );
  if (offenders.length > 0) {
    // Throw with a concise summary so CI/logs catch it immediately.
    const examples = offenders.slice(0, 5).map(o => `${o.id}@${o.lastActivityAt}`).join(", ");
    throw new Error(`[Top50Selection] Found ${offenders.length} newer-than-cutoff conversations not in selection. e.g. ${examples}`);
  }
}

