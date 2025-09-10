import axios from "axios";

const BASE  = process.env.BOOM_API_BASE!;
const TOKEN = process.env.BOOM_API_TOKEN!;
const ORG_ID = process.env.BOOM_ORG_ID!; // org / account scope

export type Conv = {
  id: string;
  lastActivityAt: string; // ISO timestamp used for SLA recency
  // add any fields you already read elsewhere (participant ids, link, etc.)
};

export async function getTop50PlatformWide(): Promise<Conv[]> {
  const res = await axios.get(`${BASE}/orgs/${ORG_ID}/conversations`, {
    params: {
      sort: "lastActivityAt",   // adjust if API uses "updatedAt" / "last_message_at"
      order: "desc",
      limit: 50
    },
    headers: { Authorization: `Bearer ${TOKEN}` },
    timeout: 15_000
  });

  const items = res.data.items ?? res.data ?? [];
  return items.map((c: any) => ({
    id: c.id,
    lastActivityAt: c.lastActivityAt || c.updatedAt || c.last_message_at
  }));
}
