import { redirect } from 'next/navigation';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default function Page({ searchParams }: { searchParams: { conversation?: string } }) {
  const conversation =
    typeof searchParams.conversation === 'string' && searchParams.conversation.length > 0
      ? searchParams.conversation
      : undefined;

  if (conversation && !UUID_RE.test(conversation)) {
    redirect(`/c/${encodeURIComponent(conversation)}`);
  }

  return <GuestExperience initialConversationId={conversation} />;
}

function GuestExperience({ initialConversationId }: { initialConversationId?: string }) {
  return (
    <main style={{ padding: 24 }}>
      Guest Experience {initialConversationId ? `(conversation ${initialConversationId})` : ''}
    </main>
  );
}
