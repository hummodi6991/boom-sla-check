import { redirect } from "next/navigation.js";

export default function Page({ params }: { params: { id: string } }) {
  const url = `/dashboard/guest-experience/all?conversation=${encodeURIComponent(params.id)}`;
  redirect(url);
}
