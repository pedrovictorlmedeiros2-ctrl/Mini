import { listActiveNodes, listStaleNodes, setNodeStatus } from "../repositories/nodes.js";
import { listServersByNode, listServersByStatus } from "../repositories/servers.js";
import { sendCommand } from "./agentRegistry.js";
import { transitionServer } from "./serverStateMachine.js";
import { handleUnexpectedExit } from "./serverLifecycle.js";
import { recordAudit } from "../repositories/auditLog.js";
import { AuditEvent, ServerStatus } from "@atlantic/shared";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";

const STABLE_STATUSES = new Set([ServerStatus.RUNNING, ServerStatus.STOPPED]);
const TRANSIENT_TIMEOUT_MS = 5 * 60 * 1000;

// Runs on a timer (see server.js) and also as a queue job. Compares the
// database's idea of the world against what nodes actually report and fixes
// only the inconsistencies that are safe to fix automatically:
//   - node missed its heartbeat window -> mark OFFLINE (no data touched)
//   - node reports a running container the DB doesn't know about -> the
//     agent removes it (it's an orphan by definition: nothing here owns it)
//   - DB says RUNNING but node says the container is gone/exited -> treat as
//     an unexpected crash and hand it to the existing auto-heal path
//   - a server has been stuck in a transient state (STARTING/STOPPING/...)
//     far longer than any real operation should take -> flag as ERROR so a
//     human/panel can see it, instead of leaving it silently "STARTING"
// It never deletes user data and never invents cross-node failover for
// volumes that only exist on one node (see mission section 20/52).
export async function runReconciliation() {
  const cutoff = new Date(Date.now() - config.heartbeatTimeoutMs).toISOString().replace("T", " ").slice(0, 19);
  const stale = listStaleNodes(cutoff);
  for (const node of stale) {
    setNodeStatus(node.id, "OFFLINE");
    recordAudit({ actorType: "system", event: AuditEvent.NODE_OFFLINE, targetType: "node", targetId: node.id, metadata: { reason: "heartbeat_timeout" } });
    logger.warn({ nodeId: node.id }, "node marked OFFLINE due to missed heartbeats");
  }

  for (const status of ["STARTING", "STOPPING", "RESTARTING", "CREATING", "INSTALLING", "BACKING_UP", "RESTORING", "DELETING"]) {
    for (const server of listServersByStatus(status)) {
      const updatedAt = new Date(server.updated_at.replace(" ", "T") + "Z").getTime();
      if (Date.now() - updatedAt > TRANSIENT_TIMEOUT_MS) {
        logger.warn({ serverId: server.id, status }, "server stuck in transient state, flagging as ERROR");
        try {
          transitionServer(server.id, ServerStatus.ERROR, { last_error: `stuck in ${status} beyond timeout` });
        } catch (err) {
          logger.error({ serverId: server.id, err: err.message }, "failed to flag stuck server");
        }
      }
    }
  }

  for (const node of listActiveNodes()) {
    let report;
    try {
      report = await sendCommand(node.id, "LIST_CONTAINERS", {}, { timeoutMs: 15_000 });
    } catch {
      continue; // node unreachable this tick; heartbeat check above will catch it if it stays down
    }
    const dbServers = listServersByNode(node.id).filter((s) => s.container_id);
    const dbByContainer = new Map(dbServers.map((s) => [s.container_id, s]));
    const liveContainerIds = new Set((report.containers || []).map((c) => c.containerId));

    for (const container of report.containers || []) {
      const server = dbByContainer.get(container.containerId);
      if (!server) {
        // Orphan on the node: nothing in our DB references this container.
        try {
          await sendCommand(node.id, "DELETE_CONTAINER", { containerId: container.containerId }, { timeoutMs: 15_000 });
          logger.warn({ nodeId: node.id, containerId: container.containerId }, "removed orphaned container with no matching server record");
        } catch (err) {
          logger.error({ containerId: container.containerId, err: err.message }, "failed to remove orphan container");
        }
        continue;
      }
      if (server.status === ServerStatus.RUNNING && !container.running) {
        await handleUnexpectedExit(server);
      }
    }

    for (const server of dbServers) {
      if (STABLE_STATUSES.has(server.status) && server.status === ServerStatus.RUNNING && !liveContainerIds.has(server.container_id)) {
        // Container vanished entirely (not just stopped) while DB still says RUNNING.
        await handleUnexpectedExit(server);
      }
    }
  }
}
