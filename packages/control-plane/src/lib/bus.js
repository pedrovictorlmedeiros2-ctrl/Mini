import { EventEmitter } from "node:events";

// Process-local event bus decoupling state-changing services (which just
// need to announce "this changed") from whatever wants to react to it (the
// WebSocket hub pushing live updates to the panel, future metrics counters,
// etc.) without those modules importing each other directly.
export const bus = new EventEmitter();
bus.setMaxListeners(50);

export const Events = Object.freeze({
  SERVER_CHANGED: "server:changed",
  NODE_CHANGED: "node:changed",
  CONSOLE_LOG: "console:log",
});
