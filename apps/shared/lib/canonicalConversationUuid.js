import crypto from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DNS_NS  = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; // RFC 4122 DNS namespace

function parseUuid(u) {
  const hex = String(u || '').replace(/-/g, '').toLowerCase();
  if (hex.length !== 32) throw new Error('bad namespace uuid');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
function toUuidString(bytes) {
  const h = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
function uuidV5(name, ns) {
  const nsBytes = parseUuid(ns);
  const hash = crypto.createHash('sha1');
  hash.update(nsBytes);
  hash.update(Buffer.from(String(name), 'utf8'));
  const buf = hash.digest();
  const bytes = new Uint8Array(buf.slice(0, 16));
  // Version 5
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  // Variant RFC 4122
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return toUuidString(bytes);
}
function baseTenantNamespace() {
  const explicit = String(process.env.CONV_UUID_NAMESPACE || '').trim();
  if (explicit && UUID_RE.test(explicit)) return explicit.toLowerCase();
  const app = (process.env.APP_URL || 'https://app.boomnow.com').trim().toLowerCase();
  return uuidV5(app, DNS_NS);
}
function convNamespace() {
  const tenant = baseTenantNamespace();
  const org = (process.env.BOOM_ORG_ID || 'global').toString();
  return uuidV5(`boom-conversation:${org}`, tenant);
}
export function mintUuidFromLegacyId(legacyId) {
  if (!Number.isInteger(legacyId)) throw new Error('legacyId must be integer');
  return uuidV5(`legacy:${legacyId}`, convNamespace());
}
export function mintUuidFromSlug(slug) {
  const s = String(slug || '').trim();
  if (!s) throw new Error('slug required');
  return uuidV5(`slug:${s}`, convNamespace());
}
export function mintUuidFromRaw(raw) {
  const r = String(raw || '').trim();
  if (!r) return null;
  if (/^\d+$/.test(r)) return mintUuidFromLegacyId(Number(r));
  if (UUID_RE.test(r)) return r.toLowerCase();
  return mintUuidFromSlug(r);
}
export function isUuid(v) {
  return UUID_RE.test(v || '');
}
