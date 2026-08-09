import { getServerById, updateServerStatus } from "../repositories/servers.js";
import { getBackupById, completeBackup, failBackup, listBackupsBeyondRetention, deleteBackup as deleteBackupRow } from "../repositories/backups.js";
import { getPlanById } from "../repositories/plans.js";
import { sendCommand } from "./agentRegistry.js";
import { transitionServer } from "./serverStateMachine.js";
import { recordAudit } from "../repositories/auditLog.js";
import { AuditEvent, ServerStatus } from "@atlantic/shared";
import { logger } from "../lib/logger.js";

export async function runBackup(serverId, backupId) {
  const server = getServerById(serverId);
  const backup = getBackupById(backupId);
  if (!server || !backup) return;
  const previousStatus = server.status;
  try {
    if (server.status === ServerStatus.RUNNING || server.status === ServerStatus.STOPPED) {
      transitionServer(serverId, ServerStatus.BACKING_UP);
    }
    const result = await sendCommand(server.node_id, "CREATE_BACKUP", {
      serverId,
      containerId: server.container_id,
    }, { timeoutMs: 300_000 });

    completeBackup(backupId, {
      sizeBytes: result.sizeBytes,
      checksum: result.checksum,
      storagePath: result.storagePath,
    });
    recordAudit({ event: AuditEvent.BACKUP_CREATED, targetType: "server", targetId: serverId, metadata: { backupId } });

    // Enforce retention: delete oldest backups beyond the plan's max_backups.
    const plan = getPlanById(server.plan_id);
    if (plan) {
      const stale = listBackupsBeyondRetention(serverId, plan.max_backups);
      for (const old of stale) {
        try {
          await sendCommand(server.node_id, "DELETE_BACKUP", { storagePath: old.storage_path }, { timeoutMs: 30_000 });
        } catch (err) {
          logger.warn({ backupId: old.id, err: err.message }, "failed to delete stale backup file; will retry via reconciler");
          continue;
        }
        deleteBackupRow(old.id);
      }
    }
  } catch (err) {
    failBackup(backupId, err.message);
    throw err;
  } finally {
    if (previousStatus === ServerStatus.RUNNING || previousStatus === ServerStatus.STOPPED) {
      transitionServer(serverId, previousStatus);
    }
  }
}

export async function runRestore(serverId, backupId, actorUserId) {
  const server = getServerById(serverId);
  const backup = getBackupById(backupId);
  if (!server || !backup) return;
  if (backup.status !== "COMPLETED") {
    throw Object.assign(new Error("backup is not in a restorable state"), { retryable: false });
  }
  transitionServer(serverId, ServerStatus.RESTORING);
  try {
    await sendCommand(server.node_id, "RESTORE_BACKUP", {
      serverId,
      containerId: server.container_id,
      storagePath: backup.storage_path,
      expectedChecksum: backup.checksum,
    }, { timeoutMs: 300_000 });
    transitionServer(serverId, ServerStatus.STOPPED);
    recordAudit({ actorUserId, event: AuditEvent.BACKUP_RESTORED, targetType: "server", targetId: serverId, metadata: { backupId } });
  } catch (err) {
    updateServerStatus(serverId, ServerStatus.ERROR, { last_error: err.message });
    throw err;
  }
}
