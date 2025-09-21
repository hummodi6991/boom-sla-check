import ConversationResolver from './ConversationResolver';

export default function Page({ searchParams }: { searchParams: { conversation?: string; legacyId?: string } }) {
  const conversation =
    typeof searchParams.conversation === 'string' && searchParams.conversation.trim().length > 0
      ? searchParams.conversation.trim()
      : undefined;
  const legacyId =
    typeof searchParams.legacyId === 'string' && searchParams.legacyId.trim().length > 0
      ? searchParams.legacyId.trim()
      : undefined;

  return (
    <ConversationResolver
      initialConversationId={conversation}
      initialLegacyId={legacyId}
    />
  );
}
