import { prisma } from './db.js';
import { logger } from './logger.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';

/** Standalone background worker (set WORKER_MODE=separate on API instances when running this). */
startScheduler();
logger.info('FamilyHub worker running');
const keepAlive = setInterval(() => undefined, 1 << 30);
async function shutdown() {
  clearInterval(keepAlive);
  stopScheduler();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
