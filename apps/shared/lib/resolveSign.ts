import crypto from 'node:crypto';

const DEFAULT_SECRET = () => process.env.RESOLVE_SECRET || '';

function payload(id: string, ts: number, nonce: string) {
  return `id=${id}&ts=${ts}&nonce=${nonce}`;
}

export function signResolve(id: string, ts: number, nonce: string, secret = DEFAULT_SECRET()) {
  return crypto.createHmac('sha256', secret).update(payload(id, ts, nonce)).digest('hex');
}

export function verifyResolveSignature(args: {
  id: string;
  ts: number;
  nonce: string;
  sig: string;
  secret?: string;
}) {
  const { id, ts, nonce, sig, secret = DEFAULT_SECRET() } = args;
  const expected = signResolve(id, ts, nonce, secret);
  const expectedBuf = Buffer.from(expected);
  const provided = String(sig || '');
  const providedBuf = Buffer.from(provided);
  return expectedBuf.length === providedBuf.length && crypto.timingSafeEqual(expectedBuf, providedBuf);
}
