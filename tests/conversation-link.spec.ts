import { test, expect } from "@playwright/test";
import { conversationDeepLink } from "../lib/links";
import { GET as cRoute } from "../app/c/[id]/route";
import { GET as convoRoute } from "../app/r/conversation/[id]/route";
import { GET as legacyConvRoute } from "../app/conversations/[id]/route";
import { prisma } from "../lib/db";

const BASE = process.env.APP_URL ?? "https://app.boomnow.com";
const uuid = "123e4567-e89b-12d3-a456-426614174000";

// Unit tests for conversationDeepLink

test("conversationDeepLink builds UUID link", () => {
  expect(conversationDeepLink(uuid)).toBe(
    `${BASE}/dashboard/guest-experience/cs?conversation=${encodeURIComponent(uuid)}`
  );
});

test("conversationDeepLink handles empty", () => {
  expect(conversationDeepLink()).toBe(
    `${BASE}/dashboard/guest-experience/cs`
  );
});

// Integration tests for routes

test("/c/:id resolves legacy numeric id", async () => {
  prisma.conversation.findFirst = async () => ({ uuid });
  const req = new Request(`${BASE}/c/123`);
  const res = await cRoute(req as any, { params: { id: "123" } });
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe(
    `${BASE}/dashboard/guest-experience/cs?conversation=${uuid}`
  );
});

test("/r/conversation/:id redirects to deep link", async () => {
  prisma.conversation.findFirst = async () => ({ uuid });
  const req = new Request(`${BASE}/r/conversation/123`);
  const res = await convoRoute(req, { params: { id: "123" } });
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe(
    `${BASE}/dashboard/guest-experience/cs?conversation=${uuid}`
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
