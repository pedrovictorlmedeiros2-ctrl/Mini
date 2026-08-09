import { registerHandler } from "./queue.js";
import { JobType } from "@atlantic/shared";
import { provisionServer } from "../services/provisioning.js";
import { getServerById } from "../repositories/servers.js";
import { startServer, stopServer, restartServer, deleteServer } from "../services/serverLifecycle.js";
import { runBackup, runRestore } from "../services/backupService.js";
import { runReconciliation } from "../services/reconciler.js";
import { transitionOrderStatus } from "../repositories/orders.js";

// True once this job has definitively exhausted its retries (mirrors the
// same retry/attempts arithmetic queue.js's failJob uses), so a handler can
// tell "will run again" from "this is the end" without duplicating state.
function isFinalAttempt(err, job) {
  const willRetry = err.retryable !== false && job.attempts + 1 < job.max_attempts;
  return !willRetry;
}

export function registerJobHandlers() {
  registerHandler(JobType.PROVISION_SERVER, async (payload, job) => {
    try {
      await provisionServer(payload);
    } catch (err) {
      if (payload.orderId && isFinalAttempt(err, job)) {
        transitionOrderStatus(payload.orderId, "FAILED", { failure_reason: String(err.message || err).slice(0, 200) });
      }
      throw err;
    }
  });

  registerHandler(JobType.START_SERVER, async (payload) => {
    const server = getServerById(payload.serverId);
    if (!server) return; // already deleted, nothing to do
    await startServer(server, payload.actorUserId);
  });

  registerHandler(JobType.STOP_SERVER, async (payload) => {
    const server = getServerById(payload.serverId);
    if (!server) return;
    await stopServer(server, payload.actorUserId);
  });

  registerHandler(JobType.RESTART_SERVER, async (payload) => {
    const server = getServerById(payload.serverId);
    if (!server) return;
    await restartServer(server, payload.actorUserId);
  });

  registerHandler(JobType.DELETE_SERVER, async (payload) => {
    const server = getServerById(payload.serverId);
    if (!server) return;
    await deleteServer(server, payload.actorUserId);
  });

  registerHandler(JobType.BACKUP_SERVER, async (payload) => {
    await runBackup(payload.serverId, payload.backupId);
  });

  registerHandler(JobType.RESTORE_BACKUP, async (payload) => {
    await runRestore(payload.serverId, payload.backupId, payload.actorUserId);
  });

  registerHandler(JobType.RECONCILE, async () => {
    await runReconciliation();
  });
}
