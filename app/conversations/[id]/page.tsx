import { redirect } from "next/navigation.js";

export default function Page({ params }: { params: { id: string } }) {
  const url = `/dashboard/guest-experience/cs?conversation=${encodeURIComponent(params.id)}`;
  redirect(url);
}
