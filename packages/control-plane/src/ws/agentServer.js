import { getNodeById, setNodeStatus, recordHeartbeat } from "../repositories/nodes.js";
import { registerConnection, unregisterConnection, resolvePending } from "../services/agentRegistry.js";
import { hashToken } from "../lib/crypto.js";
import { getServerById } from "../repositories/servers.js";
import { handleUnexpectedExit } from "../services/serverLifecycle.js";
import { ServerStatus, AuditEvent } from "@atlantic/shared";
import { recordAudit } from "../repositories/auditLog.js";
import { bus, Events } from "../lib/bus.js";
import { logger } from "../lib/logger.js";

export function authenticateAgent(nodeId, rawToken) {
  const node = getNodeById(nodeId);
  if (!node || !rawToken) return null;
  return node.agent_token_hash === hashToken(rawToken) ? node : null;
}

export function handleAgentConnection(ws, node) {
  registerConnection(node.id, ws);
  const wasOffline = node.status === "OFFLINE" || node.status === "PENDING";
  setNodeStatus(node.id, "ACTIVE");
  if (wasOffline) {
    recordAudit({ actorType: "system", event: AuditEvent.NODE_ONLINE, targetType: "node", targetId: node.id });
  }
  logger.info({ nodeId: node.id }, "node-agent connected");

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (msg.type) {
      case "heartbeat":
        recordHeartbeat(node.id, msg.metrics || {});
        break;
      case "result":
        resolvePending(msg.id, msg);
        break;
      case "log":
        bus.emit(Events.CONSOLE_LOG, { serverId: msg.serverId, line: msg.line, ts: msg.ts || Date.now() });
        break;
      case "exited": {
        const server = getServerById(msg.serverId);
        if (server && server.status === ServerStatus.RUNNING) {
          handleUnexpectedExit(server).catch((err) => logger.error({ err: err.message }, "auto-heal failed"));
        }
        break;
      }
      default:
        logger.debug({ type: msg.type }, "unhandled agent message type");
    }
  });

  ws.on("close", () => {
    unregisterConnection(node.id, ws);
    setNodeStatus(node.id, "OFFLINE");
    recordAudit({ actorType: "system", event: AuditEvent.NODE_OFFLINE, targetType: "node", targetId: node.id, metadata: { reason: "connection_closed" } });
    logger.warn({ nodeId: node.id }, "node-agent disconnected");
  });

  ws.on("error", (err) => {
    logger.error({ nodeId: node.id, err: err.message }, "agent websocket error");
  });
}
