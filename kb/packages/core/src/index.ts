import { startServer } from './server/index.js';
import { logger } from './util/logger.js';

async function main() {
  try {
    await startServer();
  } catch (err) {
    logger.error({ err }, 'failed to start');
    process.exit(1);
  }
}

main();
