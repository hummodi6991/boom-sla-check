export default function Page({ searchParams }: { searchParams: { conversation?: string } }) {
  const conversation =
    typeof searchParams.conversation === 'string' && searchParams.conversation.length > 0
      ? searchParams.conversation
      : undefined;

  // Placeholder component to avoid build issues; replace with real implementation.
  return <GuestExperience initialConversationId={conversation} />;
}

function GuestExperience({ initialConversationId }: { initialConversationId?: string }) {
  return (
    <main style={{ padding: 24 }}>
      Guest Experience {initialConversationId ? `(conversation ${initialConversationId})` : ''}
    </main>
  );
}
