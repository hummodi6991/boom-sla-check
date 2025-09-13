import { isUuid } from '../../shared/lib/uuid';

export async function tryResolveConversationUuid(idOrUuid: string): Promise<string | null> {
  const id = String(idOrUuid ?? '');
  return isUuid(id) ? id.toLowerCase() : null;
}
