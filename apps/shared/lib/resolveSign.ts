import crypto from 'node:crypto';
export function signResolve(id: string, ts: number, nonce: string, secret = process.env.RESOLVE_SECRET || '') {
  const payload = `id=${id}&ts=${ts}&nonce=${nonce}`;
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}
