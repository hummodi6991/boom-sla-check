import { redirect } from 'next/navigation.js';

// Redirect legacy /inbox/conversations/:id links to the dashboard deep link.
export default function ConversationPage({ params }: { params: { id: string } }) {
  const dest = `/go/c/${encodeURIComponent(params.id)}`;
  redirect(dest);
}
