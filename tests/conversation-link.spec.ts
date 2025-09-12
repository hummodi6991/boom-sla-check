import { test, expect } from "@playwright/test";
import { conversationLink } from "../lib/links";
import { GET as cRoute } from "../app/c/[id]/route";
import { GET as convoRoute } from "../app/r/conversation/[id]/route";
import { GET as legacyConvRoute } from "../app/conversations/[id]/route";
import { prisma } from "../lib/db";

const BASE = process.env.APP_URL ?? "https://app.boomnow.com";
const uuid = "123e4567-e89b-12d3-a456-426614174000";

test("builds redirect link for UUID", () => {
  expect(conversationLink({ uuid })).toBe(
    `${BASE}/r/conversation/${uuid}`
  );
});

test("builds redirect link for numeric id", () => {
  expect(conversationLink({ id: 42 })).toBe(
    `${BASE}/r/conversation/42`
  );
});

test("falls back to dashboard when missing", () => {
  expect(conversationLink(undefined)).toBe(
    `${BASE}/dashboard/guest-experience/cs`
  );
});

test("/c/:id redirects UUID directly", async () => {
  const req = new Request(`${BASE}/dashboard/guest-experience/cs?conversation=${uuid}`);
  const res = await cRoute(req as any, { params: { id: uuid } });
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe(
    `${BASE}/dashboard/guest-experience/cs?conversation=${uuid}`
  );
});

test("/c/:id resolves legacy numeric id", async () => {
  prisma.conversation.findFirst = async () => ({ uuid });
  const req = new Request(`${BASE}/c/123`);
  const res = await cRoute(req as any, { params: { id: "123" } });
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe(
    `${BASE}/dashboard/guest-experience/cs?conversation=${uuid}`
  );
});

test("/c/:id resolves slug", async () => {
  prisma.conversation.findFirst = async () => ({ uuid });
  const req = new Request(`${BASE}/c/sluggy`);
  const res = await cRoute(req as any, { params: { id: "sluggy" } });
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe(
    `${BASE}/dashboard/guest-experience/cs?conversation=${uuid}`
  );
});

test("/r/conversation/:id serves HTML redirector", async () => {
  const req = new Request(`${BASE}/r/conversation/${uuid}`);
  const res = await convoRoute(req, { params: { id: uuid } });
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toContain(
    `<meta http-equiv="refresh" content="0; url=${BASE}/dashboard/guest-experience/cs?conversation=${uuid}">`
  );
  expect(text).toContain(
    `<a href="${BASE}/dashboard/guest-experience/cs?conversation=${uuid}" rel="nofollow">`
  );
});

test("legacy /conversations/:id redirects to dashboard", async () => {
  const req = new Request(`${BASE}/conversations/${uuid}`);
  const res = await legacyConvRoute(req, { params: { id: uuid } });
  expect(res.status).toBe(307);
  expect(res.headers.get("location")).toBe(
    `${BASE}/dashboard/guest-experience/cs?conversation=${encodeURIComponent(uuid)}`
  );
});

