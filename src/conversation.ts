type AnyRecord = Record<string, unknown>;

export type Reservation = {
  id: string;
} & AnyRecord;

export type Conversation = {
  id?: string;
  related_reservations: Reservation[];
} & AnyRecord;

type NormalizeConversationOpts = {
  fallbackId?: string;
};

function asRecord(input: unknown): AnyRecord | undefined {
  if (!input || typeof input !== 'object') return undefined;
  if (Array.isArray(input)) return undefined;
  return input as AnyRecord;
}

function toStringId(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  return undefined;
}

function sanitizeReservations(value: unknown): Reservation[] {
  if (!Array.isArray(value)) return [];
  const result: Reservation[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    if (Array.isArray(entry)) continue;
    const record = entry as AnyRecord;
    const id = toStringId(record.id);
    if (!id) continue;
    result.push({ ...record, id });
  }
  return result;
}

export function normalizeConversation(
  raw: unknown,
  opts: NormalizeConversationOpts = {}
): Conversation {
  const base = asRecord(raw) ?? {};
  const related_reservations = sanitizeReservations(base.related_reservations);
  const normalized: Conversation = {
    ...base,
    related_reservations,
  };

  const id = toStringId(base.id) ?? opts.fallbackId;
  if (id) normalized.id = id;

  return normalized;
}
