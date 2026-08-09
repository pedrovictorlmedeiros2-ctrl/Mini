import { canTransition } from "@atlantic/shared";
import { getServerById, updateServerStatus } from "../repositories/servers.js";
import { bus, Events } from "../lib/bus.js";

export class InvalidTransitionError extends Error {
  constructor(from, to) {
    super(`Cannot transition server from ${from} to ${to}`);
    this.retryable = false;
  }
}

// Single chokepoint for every status change on a server row, so "estados
// impossiveis" (e.g. STOPPED -> RUNNING without going through STARTING)
// can't creep in from some route or job handler forgetting to check.
export function transitionServer(serverId, toStatus, extra = {}) {
  const server = getServerById(serverId);
  if (!server) throw new Error(`server ${serverId} not found`);
  if (server.status === toStatus) return server;
  if (!canTransition(server.status, toStatus)) {
    throw new InvalidTransitionError(server.status, toStatus);
  }
  const updated = updateServerStatus(serverId, toStatus, extra);
  bus.emit(Events.SERVER_CHANGED, updated);
  return updated;
}
