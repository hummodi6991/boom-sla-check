export function keyOf(ts, id) {
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return Number.MIN_SAFE_INTEGER;
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return t + (h % 997) / 1000;
}

export function selectTop50(items) {
  const sorted = [...items].sort((a, b) => {
    const kb = keyOf(b.lastActivityAt, b.id);
    const ka = keyOf(a.lastActivityAt, a.id);
    return kb - ka;
  });
  return sorted.slice(0, 50);
}

export function assertTop50(all, selected) {
  if (selected.length === 0) return;
  const oldestSelected = selected[selected.length - 1];
  const cutoff = Date.parse(oldestSelected.lastActivityAt);
  const offenders = all.filter(
    x => Date.parse(x.lastActivityAt) > cutoff && !selected.some(s => s.id === x.id)
  );
  if (offenders.length > 0) {
    const examples = offenders.slice(0, 5).map(o => `${o.id}@${o.lastActivityAt}`).join(", ");
    throw new Error(`[Top50Selection] Found ${offenders.length} newer-than-cutoff conversations not in selection. e.g. ${examples}`);
  }
}

