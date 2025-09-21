import { __test__ as linkTokenTestUtils } from '../../lib/linkTokensCore.js';

export const TEST_PRIVATE_JWK = {
  crv: 'Ed25519',
  d: 'LjDVPJHTMsGZixBY-SMpmvDqGq8_CUJ9FoEaFOKbh8k',
  x: 'F-10BJTf1fc7okY313H4o8BlQDIHvjNT5YkDVu8aw5c',
  kty: 'OKP',
};

export const TEST_PUBLIC_JWK = {
  crv: 'Ed25519',
  x: 'F-10BJTf1fc7okY313H4o8BlQDIHvjNT5YkDVu8aw5c',
  kty: 'OKP',
};

export function setTestKeyEnv(): void {
  process.env.LINK_PRIVATE_JWK = JSON.stringify(TEST_PRIVATE_JWK);
  process.env.LINK_PUBLIC_JWKS = JSON.stringify({
    keys: [
      { ...TEST_PUBLIC_JWK, use: 'sig', alg: 'EdDSA', kid: 'test-key' },
    ],
  });
  process.env.LINK_KID = 'test-key';
  process.env.LINK_ISSUER = 'sla-check';
  process.env.LINK_AUDIENCE = 'boom-app';
  delete process.env.LINK_JWKS_URL;
  delete process.env.LINK_SECRET;
  delete process.env.LINK_PRIVATE_KEY_PEM;
  delete process.env.LINK_PUBLIC_KEY_PEM;
  linkTokenTestUtils?.resetCaches?.();
}
