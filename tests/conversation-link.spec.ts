import { test, expect } from "@playwright/test";
import { conversationDeepLinkFromUuid } from "../apps/shared/lib/links";
import { tryResolveConversationUuid } from "../apps/server/lib/conversations";
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

test("conversationDeepLinkFromUuid throws for invalid uuid", () => {
  expect(() => conversationDeepLinkFromUuid("not-a-uuid")).toThrow();
});

// Unit: tryResolveConversationUuid

test("tryResolveConversationUuid resolves uuid input", async () => {
  await expect(tryResolveConversationUuid(uuid)).resolves.toBe(uuid);
});

test("tryResolveConversationUuid resolves numeric id", async () => {
  prisma.conversation.findFirst = async (args: any) => {
    if (args.where.legacyId) return { uuid };
    return null;
  };
  await expect(tryResolveConversationUuid("123")).resolves.toBe(uuid);
});

test("tryResolveConversationUuid resolves slug", async () => {
  prisma.conversation.findFirst = async (args: any) => {
    if (args.where.slug) return { uuid };
    return null;
  };
  await expect(tryResolveConversationUuid("sluggy")).resolves.toBe(uuid);
});

test("tryResolveConversationUuid resolves from inline thread", async () => {
  prisma.conversation.findFirst = async () => null;
  const inlineThread = { conversation_uuid: uuid };
  await expect(tryResolveConversationUuid("x", { inlineThread })).resolves.toBe(uuid);
});

test("tryResolveConversationUuid resolves ids from inline thread", async () => {
  prisma.conversation.findFirst = async (args: any) => {
    if (args.where.legacyId) return { uuid };
    if (args.where.slug) return { uuid };
    return null;
  };
  const inlineThread = { conversation_id: 123 };
  await expect(tryResolveConversationUuid("x", { inlineThread })).resolves.toBe(uuid);
});

test("tryResolveConversationUuid returns null for unknown", async () => {
  prisma.conversation.findFirst = async () => null;
  await expect(tryResolveConversationUuid("unknown")).resolves.toBeNull();
});

// Snapshot: alert email contains deep link

test("alert email includes conversation link", async () => {
  prisma.conversation.findFirst = async () => ({ uuid });
  const html = await buildAlertEmail("123");
  expect(html).toContain(`/dashboard/guest-experience/cs?conversation=${encodeURIComponent(uuid)}`);
});

// Integration: cron/mailer skip when uuid unresolved

async function simulateAlert(convId: string, inlineThread: any, deps: any) {
  const { sendAlertEmail, logger, metrics, skipped } = deps;
  const resolved = await tryResolveConversationUuid(convId, { inlineThread });
  if (!resolved) {
    logger.warn({ convId }, "skip alert: cannot resolve conversation UUID");
    metrics.increment("alerts.skipped_missing_uuid");
    skipped.push(convId);
    return;
  }
  const url = conversationDeepLinkFromUuid(resolved);
  await sendAlertEmail({ url });
}

test("cron path skips alert when uuid unresolved", async () => {
  prisma.conversation.findFirst = async () => null;
  const logs: any[] = [];
  const metrics: string[] = [];
  const emails: any[] = [];
  const logger = { warn: (...args: any[]) => logs.push(args) };
  const metricObj = { increment: (n: string) => metrics.push(n) };
  const skipped: string[] = [];
  await simulateAlert("unknown", null, { sendAlertEmail: (x: any) => emails.push(x), logger, metrics: metricObj, skipped });
  expect(emails.length).toBe(0);
  expect(metrics).toContain("alerts.skipped_missing_uuid");
  expect(skipped).toContain("unknown");
});

test("cron path sends alert when uuid resolved", async () => {
  prisma.conversation.findFirst = async () => ({ uuid });
  const emails: any[] = [];
  const logger = { warn: () => {} };
  const metricObj = { increment: () => {} };
  const skipped: string[] = [];
  await simulateAlert("123", null, { sendAlertEmail: (x: any) => emails.push(x), logger, metrics: metricObj, skipped });
  expect(emails.length).toBe(1);
  const url = emails[0].url;
  expect(url).toContain(`?conversation=${uuid}`);
  expect(url).not.toContain("/r/");
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
