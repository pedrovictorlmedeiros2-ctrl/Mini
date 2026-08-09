import { sendFireAndForget } from "../services/agentRegistry.js";

// serverId -> Set<ws>. Tracks which panel clients currently want live logs
// for which server, so we only ask the node-agent to stream logs for
// containers someone is actually watching (mission section 35: avoid
// per-bot overhead that doesn't scale to hundreds/thousands of servers).
const subscribers = new Map();

export function subscribe(serverId, ws, nodeId, containerId) {
  let set = subscribers.get(serverId);
  const wasEmpty = !set || set.size === 0;
  if (!set) {
    set = new Set();
    subscribers.set(serverId, set);
  }
  set.add(ws);
  if (wasEmpty && nodeId) {
    sendFireAndForget(nodeId, "WATCH_LOGS", { serverId, containerId });
  }
}

export function unsubscribe(serverId, ws, nodeId) {
  const set = subscribers.get(serverId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) {
    subscribers.delete(serverId);
    if (nodeId) sendFireAndForget(nodeId, "UNWATCH_LOGS", { serverId });
  }
}

export function unsubscribeAll(ws, resolveNodeId) {
  for (const [serverId, set] of subscribers.entries()) {
    if (set.has(ws)) {
      set.delete(ws);
      if (set.size === 0) {
        subscribers.delete(serverId);
        const nodeId = resolveNodeId(serverId);
        if (nodeId) sendFireAndForget(nodeId, "UNWATCH_LOGS", { serverId });
      }
    }
  }
}

export function getSubscribers(serverId) {
  return subscribers.get(serverId) || new Set();
}

// Docker's log-follow stream on a stopped container ends immediately rather
// than waiting for a future start, so a panel client that subscribed to
// console output before the container was running would otherwise see
// nothing at all once it starts. Called after a successful start/restart so
// any already-subscribed clients get a freshly attached (and therefore
// live) log stream.
export function resubscribeIfWatched(serverId, nodeId, containerId) {
  const set = subscribers.get(serverId);
  if (set && set.size > 0 && nodeId) {
    sendFireAndForget(nodeId, "WATCH_LOGS", { serverId, containerId });
  }
}
