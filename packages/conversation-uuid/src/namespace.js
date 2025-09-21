import { validate as uuidValidate } from 'uuid';
import { normalizeIdentifier } from './utils.js';

export const CONVERSATION_UUID_NAMESPACE_DEFAULT = '3f3aa693-5b5d-4f6a-9c8e-7b7a1d1d8b7a';

function normalizeNamespace(candidate) {
  const normalized = normalizeIdentifier(candidate);
  if (normalized && uuidValidate(normalized)) return normalized.toLowerCase();
  return null;
}

export function conversationUuidNamespace() {
  const envCandidates = [
    process.env.CONVERSATION_UUID_NAMESPACE,
    process.env.CONV_UUID_NAMESPACE,
  ];
  for (const candidate of envCandidates) {
    const normalized = normalizeNamespace(candidate);
    if (normalized) return normalized;
  }
  return CONVERSATION_UUID_NAMESPACE_DEFAULT;
}

export const __test__ = {
  normalizeNamespace,
};
