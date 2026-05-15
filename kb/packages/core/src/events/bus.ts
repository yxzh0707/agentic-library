import { EventEmitter } from 'node:events';
import type { WSEvent } from '@kb/shared';

class EventBus extends EventEmitter {
  publish(event: WSEvent) {
    this.emit('event', event);
  }
  subscribe(fn: (e: WSEvent) => void) {
    this.on('event', fn);
    return () => this.off('event', fn);
  }
}

export const bus = new EventBus();
