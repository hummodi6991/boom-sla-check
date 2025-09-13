import { isUuid } from './uuid';

export function lintAlertEvent(evt: any): void {
  const uuid = evt?.conversation_uuid;
  if (!uuid) throw new Error('conversation_uuid is required');
  if (!isUuid(uuid)) throw new Error('conversation_uuid must be a UUID');
}
