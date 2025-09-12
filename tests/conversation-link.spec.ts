import { test, expect } from "@playwright/test";
import { buildConversationLink } from "../lib/email.js";
import { GET as convoRoute } from "../app/r/conversation/[id]/route";
import { GET as legacyConvRoute } from "../app/conversations/[id]/route";

const uuid = "123e4567-e89b-12d3-a456-426614174000";

test("buildConversationLink uses dashboard conversation URL", () => {
  const url = buildConversationLink({ uuid });
  expect(url).toBe(
    `https://app.boomnow.com/dashboard/guest-experience/all?conversation=${encodeURIComponent(
      uuid
    )}`
  );
});

test("legacy /r/conversation/:id redirects to dashboard", async () => {
  const req = new Request(`https://app.boomnow.com/r/conversation/${uuid}`);
  const res = await convoRoute(req, { params: { id: uuid } });
  expect(res.status).toBe(307);
  expect(res.headers.get("location")).toBe(
    `https://app.boomnow.com/dashboard/guest-experience/all?conversation=${encodeURIComponent(
      uuid
    )}`
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

