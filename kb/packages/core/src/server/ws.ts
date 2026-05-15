import type { WebSocketServer } from 'ws';
import type { AppContext } from '../app.js';
import { bus } from '../events/bus.js';
import { logger } from '../util/logger.js';

export function registerWs(wss: WebSocketServer, _app: AppContext) {
  wss.on('connection', (ws) => {
    logger.info('ws client connected');
    const unsubscribe = bus.subscribe((ev) => {
      try {
        ws.send(JSON.stringify(ev));
      } catch (err) {
        logger.warn({ err }, 'ws send failed');
      }
    });
    ws.on('close', () => {
      unsubscribe();
    });
    ws.send(JSON.stringify({ type: 'hello' }));
  });
}
