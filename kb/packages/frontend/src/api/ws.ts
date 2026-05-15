import type { WSEvent } from '@kb/shared';

type Listener = (ev: WSEvent) => void;

let socket: WebSocket | null = null;
const listeners = new Set<Listener>();
let connected = false;

export function connectWS() {
  if (socket) return;
  const url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/events`;
  socket = new WebSocket(url);
  socket.addEventListener('open', () => {
    connected = true;
  });
  socket.addEventListener('close', () => {
    connected = false;
    socket = null;
    setTimeout(connectWS, 2000);
  });
  socket.addEventListener('message', (ev) => {
    try {
      const data = JSON.parse(ev.data) as WSEvent;
      for (const fn of listeners) fn(data);
    } catch {
      // ignore
    }
  });
}

export function isConnected() {
  return connected;
}

export function onEvent(fn: Listener) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
