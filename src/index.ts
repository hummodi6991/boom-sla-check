import { buildPoolFromMessages, PoolItem } from "./pool/fromMessages";

// Placeholder for existing SLA check implementation
async function checkSLA(pool: PoolItem[]) {
  // existing SLA checks proceed unchanged
}

async function run() {
  const target = Number(process.env.POOL_SIZE ?? 50);
  const pool = await buildPoolFromMessages(target);
  console.log(`processing up to ${target} newest global convos by guest msg (actual: ${pool.length})`);

  // existing SLA checks proceed unchanged:
  await checkSLA(pool);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
