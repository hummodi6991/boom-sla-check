import type { JWTPayload, JWTVerifyResult } from 'jose';
import {
  currentLinkJwks as coreCurrentLinkJwks,
  signLinkToken as coreSignLinkToken,
  verifyLinkToken as coreVerifyLinkToken,
} from '../../../lib/linkTokensCore.js';

export type LinkTokenPayload = JWTPayload & {
  conversation: string;
  jti?: string;
  aud?: string;
};

export async function signLinkToken(payload: LinkTokenPayload, ttl = '15m'): Promise<string> {
  return coreSignLinkToken(payload, ttl);
}

export async function verifyLinkToken(token: string): Promise<JWTVerifyResult<JWTPayload>> {
  return coreVerifyLinkToken(token);
}

export async function currentLinkJwks() {
  return coreCurrentLinkJwks();
}
