import crypto from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function secret() {
  const s = process.env.LINK_SECRET;
  if (!s) throw new Error('LINK_SECRET missing');
  return s;
}

export function makeLinkToken({ uuid, exp }) {
  if (!UUID_RE.test(uuid || '')) throw new Error('uuid required');
  if (!exp || typeof exp !== 'number') throw new Error('exp required');
  const payload = `${uuid.toLowerCase()}.${exp}`;
  const sig = crypto.createHmac('sha256', secret()).update(payload).digest('hex');
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}
