import { runChecker } from './dist/index.js';

runChecker().catch(err => {
  console.error('Cron failed', err);
  process.exit(1);
});
