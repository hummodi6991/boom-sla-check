import { test, expect } from "@playwright/test";
import { buildConversationLink } from "../lib/email.js";
import { GET as convoRoute } from "../app/r/conversation/[id]/route";

test("buildConversationLink uses UI conversations URL", () => {
  const url = buildConversationLink("123456");
  expect(url).toBe("https://app.boomnow.com/inbox/conversations/123456");
});

test("legacy /r/conversation/:id redirects to /inbox", async () => {
  const req = new Request(
    "https://app.boomnow.com/r/conversation/123456"
  );
  const res = await convoRoute(req, { params: { id: "123456" } });
  expect(res.status).toBe(307);
  expect(res.headers.get("location")).toBe(
    "https://app.boomnow.com/inbox/conversations/123456"
  );
});

