import { isUuid } from '../../shared/lib/uuid.js';

export async function tryResolveConversationUuid(idOrUuid, _opts = {}) {
  const id = String(idOrUuid ?? '');
  return isUuid(id) ? id.toLowerCase() : null;
}
