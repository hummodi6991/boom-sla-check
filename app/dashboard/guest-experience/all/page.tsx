import { redirect } from 'next/navigation';
import GuestExperience from './GuestExperience';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default function Page({ searchParams }: { searchParams: { conversation?: string; legacyId?: string } }) {
  const conversation =
    typeof searchParams.conversation === 'string' && searchParams.conversation.length > 0
      ? searchParams.conversation
      : undefined;
  const legacyId =
    typeof searchParams.legacyId === 'string' && searchParams.legacyId.length > 0
      ? searchParams.legacyId
      : undefined;

  // Forward non-UUID/legacy to the client-side resolver to avoid redirect loops.
  if (legacyId) redirect(`/dashboard/guest-experience/cs?legacyId=${encodeURIComponent(legacyId)}`);
  if (conversation && !UUID_RE.test(conversation)) {
    redirect(`/dashboard/guest-experience/cs?conversation=${encodeURIComponent(conversation)}`);
  }

  return <GuestExperience initialConversationId={conversation} />;
}
