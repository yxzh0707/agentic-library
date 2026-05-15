import express from 'express';
import cors from 'cors';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { DEFAULT_HOST, DEFAULT_PORT } from '@kb/shared';
import { logger } from '../util/logger.js';
import { loadOrInitConfig, isConfigComplete } from '../config/config.js';
import { initApp } from '../app.js';
import { registerRoutes } from './routes.js';
import { registerWs } from './ws.js';

export async function startServer() {
  const config = loadOrInitConfig();
  const app = await initApp(config);

  const server = express();
  server.use(cors({ origin: true, credentials: true }));
  server.use(express.json({ limit: '20mb' }));

  registerRoutes(server, app);

  const httpServer = http.createServer(server);
  const wss = new WebSocketServer({ server: httpServer, path: '/ws/events' });
  registerWs(wss, app);

  await new Promise<void>((resolve) =>
    httpServer.listen(DEFAULT_PORT, DEFAULT_HOST, () => resolve()),
  );
  logger.info(
    { host: DEFAULT_HOST, port: DEFAULT_PORT, configReady: isConfigComplete(config) },
    'server listening',
  );

  const shutdown = async (sig: string) => {
    logger.info({ sig }, 'shutting down');
    await app.shutdown();
    httpServer.close(() => process.exit(0));
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
