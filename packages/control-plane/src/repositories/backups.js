import crypto from "node:crypto";
import { db } from "../db/index.js";

export function createBackup(serverId) {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO backups (id, server_id, status) VALUES (?, ?, 'PENDING')").run(id, serverId);
  return getBackupById(id);
}

export function getBackupById(id) {
  return db.prepare("SELECT * FROM backups WHERE id = ?").get(id);
}

export function listBackupsByServer(serverId) {
  return db.prepare("SELECT * FROM backups WHERE server_id = ? ORDER BY created_at DESC").all(serverId);
}

export function completeBackup(id, { sizeBytes, checksum, storagePath }) {
  db.prepare(`
    UPDATE backups SET status = 'COMPLETED', size_bytes = ?, checksum = ?, storage_path = ?, completed_at = datetime('now')
    WHERE id = ?
  `).run(sizeBytes, checksum, storagePath, id);
  return getBackupById(id);
}

export function failBackup(id, reason) {
  db.prepare("UPDATE backups SET status = 'FAILED', failure_reason = ? WHERE id = ?").run(reason, id);
  return getBackupById(id);
}

export function deleteBackup(id) {
  db.prepare("DELETE FROM backups WHERE id = ?").run(id);
}

// Oldest-first backups beyond the plan's retention count, for cleanup jobs.
export function listBackupsBeyondRetention(serverId, retain) {
  return db.prepare(`
    SELECT * FROM backups WHERE server_id = ? AND status = 'COMPLETED'
    ORDER BY created_at DESC LIMIT -1 OFFSET ?
  `).all(serverId, retain);
}
