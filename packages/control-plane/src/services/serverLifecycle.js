import { getServerById, resetCrashCount, incrementCrashCount } from "../repositories/servers.js";
import { transitionServer } from "./serverStateMachine.js";
import { sendCommand } from "./agentRegistry.js";
import { releaseReservation } from "./scheduler.js";
import { recordAudit } from "../repositories/auditLog.js";
import { AuditEvent, ServerStatus } from "@atlantic/shared";
import { logger } from "../lib/logger.js";
import { resubscribeIfWatched } from "../ws/consoleSubscriptions.js";

function requireProvisioned(server) {
  if (!server.node_id || !server.container_id) {
    const err = new Error("server has no assigned node/container");
    err.retryable = false;
    throw err;
  }
}

export async function startServer(server, actorUserId) {
  requireProvisioned(server);
  transitionServer(server.id, ServerStatus.STARTING);
  try {
    await sendCommand(server.node_id, "START_CONTAINER", { serverId: server.id, containerId: server.container_id }, { timeoutMs: 30_000 });
    transitionServer(server.id, ServerStatus.RUNNING);
    resetCrashCount(server.id);
    resubscribeIfWatched(server.id, server.node_id, server.container_id);
    recordAudit({ actorUserId, event: AuditEvent.SERVER_STARTED, targetType: "server", targetId: server.id });
  } catch (err) {
    transitionServer(server.id, ServerStatus.STOPPED, { last_error: err.message });
    throw err;
  }
  return getServerById(server.id);
}

export async function stopServer(server, actorUserId) {
  requireProvisioned(server);
  transitionServer(server.id, ServerStatus.STOPPING);
  await sendCommand(server.node_id, "STOP_CONTAINER", { serverId: server.id, containerId: server.container_id }, { timeoutMs: 30_000 });
  transitionServer(server.id, ServerStatus.STOPPED);
  recordAudit({ actorUserId, event: AuditEvent.SERVER_STOPPED, targetType: "server", targetId: server.id });
  return getServerById(server.id);
}

export async function restartServer(server, actorUserId) {
  requireProvisioned(server);
  transitionServer(server.id, ServerStatus.RESTARTING);
  await sendCommand(server.node_id, "RESTART_CONTAINER", { serverId: server.id, containerId: server.container_id }, { timeoutMs: 45_000 });
  transitionServer(server.id, ServerStatus.RUNNING);
  resetCrashCount(server.id);
  resubscribeIfWatched(server.id, server.node_id, server.container_id);
  recordAudit({ actorUserId, event: AuditEvent.SERVER_RESTARTED, targetType: "server", targetId: server.id });
  return getServerById(server.id);
}

export async function deleteServer(server, actorUserId) {
  transitionServer(server.id, ServerStatus.DELETING);
  try {
    if (server.node_id && server.container_id) {
      await sendCommand(server.node_id, "DELETE_CONTAINER", { serverId: server.id, containerId: server.container_id }, { timeoutMs: 60_000 });
    }
  } catch (err) {
    logger.error({ serverId: server.id, err: err.message }, "delete_container command failed; reconciler will retry cleanup");
  }
  if (server.node_id) {
    releaseReservation(server.node_id, { ramMb: server.ram_mb, cpuPercent: server.cpu_percent, diskMb: server.disk_mb });
  }
  transitionServer(server.id, ServerStatus.DELETED);
  recordAudit({ actorUserId, event: AuditEvent.SERVER_DELETED, targetType: "server", targetId: server.id });
  return getServerById(server.id);
}

// Called by the reconciler / crash-report handler when the node-agent
// reports a container exited unexpectedly. Applies bounded auto-healing:
// retry with backoff up to a limit, then give up and surface CRASHED so a
// human (or the panel) can see it instead of crash-looping forever.
const MAX_AUTO_RESTARTS = 5;

export async function handleUnexpectedExit(server) {
  const updated = incrementCrashCount(server.id);
  if (updated.crash_count > MAX_AUTO_RESTARTS) {
    transitionServer(server.id, ServerStatus.CRASHED, { last_error: `exceeded ${MAX_AUTO_RESTARTS} auto-restarts` });
    logger.warn({ serverId: server.id }, "crash loop detected; giving up on auto-restart");
    return;
  }
  transitionServer(server.id, ServerStatus.RECOVERING);
  const backoffMs = Math.min(60_000, 2000 * 2 ** updated.crash_count);
  setTimeout(async () => {
    try {
      await startServer(getServerById(server.id));
    } catch (err) {
      logger.error({ serverId: server.id, err: err.message }, "auto-restart failed");
    }
  }, backoffMs);
}
