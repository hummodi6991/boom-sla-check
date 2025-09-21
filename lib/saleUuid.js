const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

const SALE_DIRECT_PATHS = [
  ['sale_uuid'],
  ['saleUuid'],
  ['sale_id'],
  ['saleId'],
  ['saleid'],
  ['sale', 'uuid'],
  ['sale', 'sale_uuid'],
  ['sale', 'saleUuid'],
  ['sale', 'saleId'],
  ['sale', 'id'],
  ['meta', 'sale_uuid'],
  ['meta', 'saleUuid'],
  ['meta', 'sale', 'uuid'],
  ['meta', 'sale', 'sale_uuid'],
  ['payload', 'sale_uuid'],
  ['payload', 'saleUuid'],
  ['payload', 'sale', 'uuid'],
  ['payload', 'sale', 'sale_uuid'],
  ['payload', 'data', 'sale_uuid'],
  ['payload', 'data', 'saleUuid'],
  ['payload', 'data', 'sale', 'uuid'],
  ['context', 'sale_uuid'],
  ['context', 'saleUuid'],
  ['details', 'sale_uuid'],
  ['details', 'saleUuid'],
  ['reservation', 'sale_uuid'],
  ['reservation', 'saleUuid'],
  ['reservation', 'sale', 'uuid'],
  ['reservation', 'sale', 'sale_uuid'],
  ['reservation', 'sale', 'saleUuid'],
  ['meta', 'reservation', 'sale_uuid'],
  ['meta', 'reservation', 'saleUuid'],
  ['order', 'sale_uuid'],
  ['order', 'saleUuid'],
  ['order', 'uuid'],
  ['sale', 'reservation', 'uuid'],
  ['latest_sale', 'uuid'],
  ['latestSale', 'uuid'],
  ['latest_sale_uuid'],
  ['latestSaleUuid'],
  ['linked_sale_uuid'],
  ['related', 'sale_uuid'],
  ['related', 'saleUuid'],
  ['related_sale_uuid'],
  ['relatedSaleUuid'],
  ['entity_uuid'],
  ['entityUuid'],
  ['entity', 'uuid'],
  ['entity', 'sale_uuid'],
  ['entity', 'sale', 'uuid'],
  ['target', 'uuid'],
  ['target_uuid'],
  ['target', 'sale_uuid'],
  ['target', 'sale', 'uuid'],
  ['resource_uuid'],
  ['resourceUuid'],
  ['resource', 'uuid'],
  ['resource', 'sale_uuid'],
  ['resource', 'sale', 'uuid'],
  ['meta', 'entity_uuid'],
  ['meta', 'target_uuid'],
  ['meta', 'resource_uuid'],
];

const SALE_NEST_KEYS = [
  'sale',
  'sales',
  'meta',
  'payload',
  'data',
  'context',
  'details',
  'detail',
  'entity',
  'entities',
  'entity_data',
  'entityData',
  'target',
  'targets',
  'resource',
  'resources',
  'reservation',
  'reservations',
  'booking',
  'bookings',
  'related',
  'relationships',
  'relationship',
  'links',
  'link',
  'result',
  'results',
  'body',
  'message',
  'messages',
  'thread',
  'items',
  'item',
  'extra',
  'info',
  'information',
  'state',
  'status',
  'conversation',
  'inlineThread',
  'payloads',
  'objects',
  'entities_data',
  'latest_sale',
  'latestSale',
  'history',
];

const SALE_KEY_PATTERN = /(sale|reservation|booking|folio|target|entity|resource|related|relationship|link|thread|message|payload|meta|data|context|detail|result|item|inline|history)/i;

const TIMESTAMP_KEYS = [
  'timestamp',
  'ts',
  'created_at',
  'createdAt',
  'sent_at',
  'sentAt',
  'time',
];

const pickUuid = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!UUID_RE.test(trimmed)) return null;
  return trimmed.toLowerCase();
};

const getPath = (record, path) => {
  let current = record;
  for (const key of path) {
    if (current == null) return undefined;
    current = current[key];
  }
  return current;
};

const directSaleUuid = (record) => {
  if (!record || typeof record !== 'object') return null;
  for (const path of SALE_DIRECT_PATHS) {
    const candidate = pickUuid(getPath(record, path));
    if (candidate) return candidate;
  }
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== 'string') continue;
    const normalized = key.toLowerCase();
    if (normalized.includes('sale') && normalized.includes('uuid')) {
      const candidate = pickUuid(value);
      if (candidate) return candidate;
    }
  }
  return null;
};

function extractSaleUuid(value, seen = new Set()) {
  if (!value || typeof value !== 'object') return null;
  if (seen.has(value)) return null;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractSaleUuid(item, seen);
      if (found) return found;
    }
    return null;
  }

  const direct = directSaleUuid(value);
  if (direct) return direct;

  for (const key of SALE_NEST_KEYS) {
    if (key in value) {
      const found = extractSaleUuid(value[key], seen);
      if (found) return found;
    }
  }

  for (const [key, val] of Object.entries(value)) {
    if (typeof val === 'string') {
      if (SALE_KEY_PATTERN.test(key)) {
        const candidate = pickUuid(val);
        if (candidate) return candidate;
      }
      continue;
    }
    if (val && typeof val === 'object') {
      if (SALE_KEY_PATTERN.test(key) || SALE_NEST_KEYS.includes(key)) {
        const found = extractSaleUuid(val, seen);
        if (found) return found;
      }
    }
  }

  return null;
}

const timestampFromMessage = (message) => {
  if (!message || typeof message !== 'object') return 0;
  for (const key of TIMESTAMP_KEYS) {
    const value = message[key];
    if (typeof value === 'string' || typeof value === 'number') {
      const ts = Date.parse(String(value));
      if (Number.isFinite(ts)) return ts;
    }
  }
  return 0;
};

function extractSaleUuidFromMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const sorted = messages
    .filter((m) => m && typeof m === 'object')
    .slice()
    .sort((a, b) => timestampFromMessage(b) - timestampFromMessage(a));
  for (const msg of sorted) {
    const found = extractSaleUuid(msg, new Set());
    if (found) return found;
  }
  return null;
}

export {
  extractSaleUuid,
  extractSaleUuidFromMessages,
};

export const __test__ = {
  pickUuid,
  directSaleUuid,
  getPath,
  extractSaleUuid,
  extractSaleUuidFromMessages,
};
