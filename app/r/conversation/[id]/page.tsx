import { redirect } from "next/navigation";

export default function Page({ params }: { params: { id: string } }) {
  redirect(`/inbox/conversations/${encodeURIComponent(params.id)}`);
}
