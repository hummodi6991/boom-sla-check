import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { id } = params;

  // Defensive: if id is missing, send users to inbox root
  if (!id) {
    return NextResponse.redirect(new URL("/inbox", req.url));
  }

  // Canonical target path within the UI
  const targetPath = `/inbox/conversations/${encodeURIComponent(id)}`;

  // Require authentication. If no session, bounce to login with next param
  const session = await getSession();
  if (!session) {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("next", targetPath);
    return NextResponse.redirect(loginUrl);
  }

  // Auth ok: redirect straight to conversation
  return NextResponse.redirect(new URL(targetPath, req.url));
}
