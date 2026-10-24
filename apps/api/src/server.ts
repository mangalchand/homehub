import { createApp } from './app.js';
import { config } from './config.js';
import { prisma } from './db.js';
import { logger } from './logger.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';

const app = createApp();
const server = app.listen(config.API_PORT, () => {
  logger.info(`FamilyHub API listening on :${config.API_PORT} (docs: ${config.API_PUBLIC_URL}/api/docs)`);
});
if (config.WORKER_MODE === 'inline') startScheduler();

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  stopScheduler();
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
