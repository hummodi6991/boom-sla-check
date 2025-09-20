import { signLinkToken as signToken, verifyLinkToken as verifyToken } from '../../../lib/linkTokensCore.js';

export function signLinkToken(payload, ttl = '15m') {
  return signToken(payload, ttl);
}

export function verifyLinkToken(token) {
  return verifyToken(token);
}
