import crypto from "node:crypto";
import { logger } from "../lib/logger.js";

// In-memory registry of live node-agent WebSocket connections, plus
// outstanding RPC calls awaiting a reply. This is intentionally
// process-local: if the control-plane restarts, agents reconnect and
// re-register within a few seconds (see node-agent/src/agent.js retry loop),
// and any in-flight RPCs simply time out and the caller's job retries.
const connections = new Map(); // nodeId -> ws
const pending = new Map(); // commandId -> { resolve, reject, timer }

export function registerConnection(nodeId, ws) {
  const existing = connections.get(nodeId);
  if (existing && existing !== ws) {
    try { existing.close(4001, "superseded by new connection"); } catch { /* noop */ }
  }
  connections.set(nodeId, ws);
}

export function unregisterConnection(nodeId, ws) {
  if (connections.get(nodeId) === ws) connections.delete(nodeId);
}

export function isNodeConnected(nodeId) {
  return connections.has(nodeId);
}

export function resolvePending(commandId, message) {
  const entry = pending.get(commandId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(commandId);
  if (message.ok) entry.resolve(message.data);
  else entry.reject(new Error(message.error || "agent command failed"));
}

export function sendCommand(nodeId, action, payload = {}, { timeoutMs = 30_000 } = {}) {
  const ws = connections.get(nodeId);
  if (!ws || ws.readyState !== ws.OPEN) {
    return Promise.reject(new Error(`node ${nodeId} is not connected`));
  }
  const id = crypto.randomUUID();
  const message = { type: "command", id, action, payload };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`command ${action} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      ws.send(JSON.stringify(message));
    } catch (err) {
      clearTimeout(timer);
      pending.delete(id);
      reject(err);
    }
  });
}

// One-way message (no reply expected) — used for streaming control like
// WATCH_LOGS/UNWATCH_LOGS where an RPC round-trip would be pointless.
export function sendFireAndForget(nodeId, type, payload = {}) {
  const ws = connections.get(nodeId);
  if (!ws || ws.readyState !== ws.OPEN) return false;
  try {
    ws.send(JSON.stringify({ type, ...payload }));
    return true;
  } catch {
    return false;
  }
}

export function connectedNodeIds() {
  return [...connections.keys()];
}

export function failAllPendingForNode() {
  // Best-effort: on disconnect we don't know exactly which pending commands
  // targeted the dropped node without extra bookkeeping, so we rely on the
  // per-command timeout above to eventually reject those callers. Logged so
  // operators can see it happening.
  logger.warn("agent connection dropped; in-flight commands to it will time out");
}
