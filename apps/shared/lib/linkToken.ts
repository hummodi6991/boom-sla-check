import crypto from 'crypto';
import { isUuid } from './uuid';

function secret(): string {
  const s = process.env.LINK_SECRET;
  if (!s) throw new Error('LINK_SECRET missing');
  return s;
}

export function makeLinkToken({ uuid, exp }: { uuid: string; exp: number }): string {
  if (!isUuid(uuid)) throw new Error('uuid required');
  if (!exp || typeof exp !== 'number') throw new Error('exp required');
  const payload = `${uuid.toLowerCase()}.${exp}`;
  const sig = crypto.createHmac('sha256', secret()).update(payload).digest('hex');
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

export function verifyLinkToken(token: string): { uuid: string } | { error: 'invalid' | 'expired' } {
  try {
    const decoded = Buffer.from(token, 'base64url').toString();
    const [uuid, expStr, sig] = decoded.split('.');
    const exp = Number(expStr);
    if (!isUuid(uuid) || !exp || !sig) return { error: 'invalid' };
    const payload = `${uuid.toLowerCase()}.${exp}`;
    const expected = crypto.createHmac('sha256', secret()).update(payload).digest('hex');
    const validSig =
      sig.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    if (!validSig) return { error: 'invalid' };
    if (Math.floor(Date.now() / 1000) > exp) return { error: 'expired' };
    return { uuid: uuid.toLowerCase() };
  } catch {
    return { error: 'invalid' };
  }
}
