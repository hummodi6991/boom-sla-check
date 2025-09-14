import crypto from 'node:crypto';
export function signResolve(id, ts, nonce, secret = process.env.RESOLVE_SECRET || '') {
  const payload = `id=${id}&ts=${ts}&nonce=${nonce}`;
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}
