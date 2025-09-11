import { headers } from 'next/headers.js';
import { redirect } from 'next/navigation.js';
import { getSession } from '../../../../lib/auth';

// If your inbox UI lives at /inbox and supports ?cid=..., this page forwards to it.
export default async function ConversationPage({ params }: { params: { id: string } }) {
  const session = await getSession(headers());
  const dest = `/inbox?cid=${encodeURIComponent(params.id)}`;
  if (!session) redirect(`/login?next=${encodeURIComponent(dest)}`);
  redirect(dest);
}

// If you already have an <Inbox> page that can take an initialConversationId prop,
// replace the two redirects above with a server component that renders that page
// and passes params.id into it.
