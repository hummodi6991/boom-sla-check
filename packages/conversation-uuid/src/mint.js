import { v5 as uuidv5 } from 'uuid';
import { conversationUuidNamespace } from './namespace.js';
import { isUuid, normalizeIdentifier } from './utils.js';

export function mintUuidFromLegacyId(legacyId) {
  if (!Number.isInteger(legacyId)) throw new Error('legacyId must be integer');
  return uuidv5(`legacy:${legacyId}`, conversationUuidNamespace());
}

export function mintUuidFromSlug(slug) {
  const trimmed = normalizeIdentifier(slug);
  if (!trimmed) throw new Error('slug required');
  return uuidv5(`slug:${trimmed}`, conversationUuidNamespace());
}

export function mintUuidFromRaw(raw) {
  const normalized = normalizeIdentifier(raw);
  if (!normalized) return null;
  if (isUuid(normalized)) return normalized.toLowerCase();
  if (/^\d+$/.test(normalized)) return mintUuidFromLegacyId(Number(normalized));
  return mintUuidFromSlug(normalized);
}

export function deriveMintedResult(raw) {
  const minted = mintUuidFromRaw(raw);
  if (!minted) return null;
  const normalized = normalizeIdentifier(raw);
  const mintedUuid = minted.toLowerCase();
  const mintedFlag = !isUuid(normalized) || mintedUuid !== normalized.toLowerCase();
  return { uuid: mintedUuid, minted: mintedFlag };
}
