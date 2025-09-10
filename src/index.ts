import { getNewest50 } from "./fetchConversations";
import { buildConversationLink, pickUiConversationId } from "./lib/links";

// Placeholder for existing SLA check implementation
async function runChecker() {
  const conversations = await getNewest50();
  for (const convo of conversations) {
    const uiId = pickUiConversationId(convo);
    const link = buildConversationLink(uiId);
    // ... your checks
  }
}

runChecker().catch(err => {
  console.error(err);
  process.exit(1);
});

export { runChecker };
