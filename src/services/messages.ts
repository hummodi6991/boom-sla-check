import axios from "axios";

const BASE  = process.env.BOOM_API_BASE!;
const TOKEN = process.env.BOOM_API_TOKEN!;
const ORG_ID = process.env.BOOM_ORG_ID!;

export async function listMessagesPage(params: { order: "asc" | "desc"; cursor?: string; since?: number }) {
  const { order, cursor, since } = params;
  const res = await axios.get(`${BASE}/orgs/${ORG_ID}/messages`, {
    params: { order, cursor, since },
    headers: { Authorization: `Bearer ${TOKEN}` },
    timeout: 15000,
  });
  const items = res.data.items ?? res.data ?? [];
  const nextCursor = res.data.nextCursor ?? res.data.next_cursor;
  return { items, nextCursor };
}
