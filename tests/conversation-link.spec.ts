import { test, expect } from "@playwright/test";
import { conversationLink } from "../lib/links";
import { GET as cRoute } from "../app/c/[id]/route";
import { GET as convoRoute } from "../app/r/conversation/[id]/route";
import { GET as legacyConvRoute } from "../app/conversations/[id]/route";
import { prisma } from "../lib/db";

const uuid = "123e4567-e89b-12d3-a456-426614174000";

test("conversationLink uses path-based redirect for UUID", () => {
  const url = conversationLink({ uuid });
  expect(url).toBe(`https://app.boomnow.com/r/conversation/${uuid}`);
});

test("conversationLink uses path-based redirect for numeric id", () => {
  const url = conversationLink({ id: 994018 });
  expect(url).toBe(`https://app.boomnow.com/r/conversation/994018`);
});

test("/c/:id redirects UUID directly", async () => {
  const req = new Request(
    `https://app.boomnow.com/dashboard/guest-experience/all?conversation=${uuid}`
  );
  const res = await cRoute(req as any, { params: { id: uuid } });
  expect(res.status).toBe(308);
  expect(res.headers.get("location")).toBe(
    `https://app.boomnow.com/dashboard/guest-experience/all?conversation=${uuid}`
  );
});

test("/c/:id resolves legacy numeric id", async () => {
  prisma.conversation.findFirst = async () => ({ uuid });
  const req = new Request(`https://app.boomnow.com/c/123`);
  const res = await cRoute(req as any, { params: { id: "123" } });
  expect(res.status).toBe(308);
  expect(res.headers.get("location")).toBe(
    `https://app.boomnow.com/dashboard/guest-experience/all?conversation=${uuid}`
  );
});

test("/c/:id resolves slug", async () => {
  prisma.conversation.findFirst = async () => ({ uuid });
  const req = new Request(`https://app.boomnow.com/c/sluggy`);
  const res = await cRoute(req as any, { params: { id: "sluggy" } });
  expect(res.status).toBe(308);
  expect(res.headers.get("location")).toBe(
    `https://app.boomnow.com/dashboard/guest-experience/all?conversation=${uuid}`
  );
});

test("/r/conversation/:id resolves numeric id", async () => {
  prisma.conversation.findFirst = async () => ({ uuid });
  const req = new Request(`https://app.boomnow.com/r/conversation/123`);
  const res = await convoRoute(req, { params: { id: "123" } });
  expect(res.status).toBe(308);
  expect(res.headers.get("location")).toBe(
    `https://app.boomnow.com/dashboard/guest-experience/all?conversation=${uuid}`
  );
});

test("legacy /conversations/:id redirects to dashboard", async () => {
  const req = new Request(`https://app.boomnow.com/conversations/${uuid}`);
  const res = await legacyConvRoute(req, { params: { id: uuid } });
  expect(res.status).toBe(307);
  expect(res.headers.get("location")).toBe(
    `https://app.boomnow.com/dashboard/guest-experience/all?conversation=${encodeURIComponent(
      uuid
    )}`
  );
});

