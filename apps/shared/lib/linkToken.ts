import type { JWTPayload, JWTVerifyResult } from 'jose';
import { signLinkToken as signToken, verifyLinkToken as verifyToken } from '../../../src/lib/links/tokens';

export type LinkTokenPayload = JWTPayload & { conversation: string };

export async function signLinkToken(payload: LinkTokenPayload, ttl = '15m'): Promise<string> {
  return signToken(payload, ttl);
}

export async function verifyLinkToken(token: string): Promise<JWTVerifyResult<JWTPayload>> {
  return verifyToken(token);
}
