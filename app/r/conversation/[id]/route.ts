import { NextResponse } from "next/server";
import { buildConversationLink } from "@/src/lib/links";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const target = buildConversationLink(params.id);
  return NextResponse.redirect(new URL(target, req.url));
}
