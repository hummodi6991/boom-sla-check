import { test, expect } from "@playwright/test";
import { conversationDeepLinkFromUuid } from "../apps/shared/lib/links";
import { ensureConversationUuid } from "../apps/server/lib/conversations";
import { buildAlertEmail } from "../apps/worker/mailer/alerts";
import { GET as convoRoute } from "../app/r/conversation/[id]/route";
import { prisma } from "../lib/db";

const BASE = process.env.APP_URL ?? "https://app.boomnow.com";
const uuid = "123e4567-e89b-12d3-a456-426614174000";

// Unit: conversationDeepLinkFromUuid

test("conversationDeepLinkFromUuid builds link", () => {
  expect(conversationDeepLinkFromUuid(uuid)).toBe(
    `${BASE}/dashboard/guest-experience/cs?conversation=${encodeURIComponent(uuid)}`
  );
});

test("conversationDeepLinkFromUuid throws when uuid missing", () => {
  expect(() => conversationDeepLinkFromUuid("" as any)).toThrow();
});

// Unit: ensureConversationUuid

test("ensureConversationUuid resolves uuid input", async () => {
  prisma.conversation.findFirst = async () => ({ uuid });
  await expect(ensureConversationUuid(uuid)).resolves.toBe(uuid);
});

test("ensureConversationUuid resolves numeric id", async () => {
  prisma.conversation.findFirst = async (args: any) => {
    if (args.where.legacyId) return { uuid };
    return null;
  };
  await expect(ensureConversationUuid("123")).resolves.toBe(uuid);
});

test("ensureConversationUuid resolves slug", async () => {
  prisma.conversation.findFirst = async (args: any) => {
    if (args.where.slug) return { uuid };
    return null;
  };
  await expect(ensureConversationUuid("sluggy")).resolves.toBe(uuid);
});

test("ensureConversationUuid throws for unknown", async () => {
  prisma.conversation.findFirst = async () => null;
  await expect(ensureConversationUuid("unknown")).rejects.toThrow(/cannot resolve UUID/);
});

// Snapshot: alert email contains deep link

test("alert email includes conversation link", async () => {
  prisma.conversation.findFirst = async () => ({ uuid });
  const html = await buildAlertEmail("123");
  expect(html).toContain(`/dashboard/guest-experience/cs?conversation=${encodeURIComponent(uuid)}`);
});

// API: GET /r/conversation/:id

test("/r/conversation/:id redirects for uuid", async () => {
  prisma.conversation.findFirst = async () => ({ uuid });
  const req = new Request(`${BASE}/r/conversation/${uuid}`);
  const res = await convoRoute(req, { params: { id: uuid } });
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe(
    `${BASE}/dashboard/guest-experience/cs?conversation=${uuid}`
  );
});

test("/r/conversation/:id resolves numeric id", async () => {
  prisma.conversation.findFirst = async (args: any) => {
    if (args.where.legacyId) return { uuid };
    return null;
  };
  const req = new Request(`${BASE}/r/conversation/123`);
  const res = await convoRoute(req, { params: { id: "123" } });
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe(
    `${BASE}/dashboard/guest-experience/cs?conversation=${uuid}`
  );
});

test("/r/conversation/:id resolves slug", async () => {
  prisma.conversation.findFirst = async (args: any) => {
    if (args.where.slug) return { uuid };
    return null;
  };
  const req = new Request(`${BASE}/r/conversation/sluggy`);
  const res = await convoRoute(req, { params: { id: "sluggy" } });
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe(
    `${BASE}/dashboard/guest-experience/cs?conversation=${uuid}`
  );
});

test("/r/conversation/:id unknown id redirects to dashboard", async () => {
  prisma.conversation.findFirst = async () => null;
  const req = new Request(`${BASE}/r/conversation/unknown`);
  const res = await convoRoute(req, { params: { id: "unknown" } });
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe(
    `${BASE}/dashboard/guest-experience/cs`
  );
});
