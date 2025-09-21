import { redirect } from 'next/navigation';
import ConversationResolver from './ConversationResolver';

export default function Page({ searchParams }: { searchParams: { conversation?: string; legacyId?: string } }) {
  const conversation =
    typeof searchParams.conversation === 'string' && searchParams.conversation.length > 0
      ? searchParams.conversation
      : undefined;
  const legacyId =
    typeof searchParams.legacyId === 'string' && searchParams.legacyId.length > 0
      ? searchParams.legacyId
      : undefined;

  if (legacyId) redirect(`/dashboard/guest-experience/cs?legacyId=${encodeURIComponent(legacyId)}`);

  return <ConversationResolver initialConversationId={conversation} />;
}
