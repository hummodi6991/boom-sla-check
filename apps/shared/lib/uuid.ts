import { isUuid as jsIsUuid } from '../../../packages/conversation-uuid/index.js';

export function isUuid(v: string): boolean {
  return jsIsUuid(v);
}
