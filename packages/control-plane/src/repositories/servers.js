import crypto from "node:crypto";
import { db } from "../db/index.js";

export function createServer(data) {
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO servers (id, user_id, plan_id, order_id, name, slug, type, status, image, start_command, ram_mb, cpu_percent, disk_mb, pids_limit, volume_path)
    VALUES (@id, @user_id, @plan_id, @order_id, @name, @slug, @type, 'CREATING', @image, @start_command, @ram_mb, @cpu_percent, @disk_mb, @pids_limit, @volume_path)
  `).run({ id, order_id: null, start_command: null, volume_path: null, ...data });
  return getServerById(id);
}

export function getServerById(id) {
  return db.prepare("SELECT * FROM servers WHERE id = ?").get(id);
}

// Ownership-scoped lookup: the single chokepoint every route MUST use when a
// non-admin user requests a specific server. Returns undefined (-> 404, not
// 403, to avoid leaking existence) if the server belongs to someone else.
export function getServerOwnedBy(id, userId) {
  return db.prepare("SELECT * FROM servers WHERE id = ? AND user_id = ?").get(id, userId);
}

export function listServersByUser(userId) {
  return db.prepare("SELECT * FROM servers WHERE user_id = ? AND status != 'DELETED' ORDER BY created_at DESC").all(userId);
}

export function listServersByNode(nodeId) {
  return db.prepare("SELECT * FROM servers WHERE node_id = ? AND status != 'DELETED'").all(nodeId);
}

export function countActiveServersByUser(userId) {
  return db.prepare("SELECT COUNT(*) AS c FROM servers WHERE user_id = ? AND status != 'DELETED'").get(userId).c;
}

export function listAllServers({ limit = 50, offset = 0 } = {}) {
  const rows = db.prepare(`
    SELECT s.*, u.email AS owner_email FROM servers s
    JOIN users u ON u.id = s.user_id
    WHERE s.status != 'DELETED'
    ORDER BY s.created_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
  const total = db.prepare("SELECT COUNT(*) AS c FROM servers WHERE status != 'DELETED'").get().c;
  return { rows, total };
}

export function updateServerStatus(id, status, extra = {}) {
  const fields = ["status = @status", "updated_at = datetime('now')"];
  const params = { id, status, ...extra };
  for (const key of Object.keys(extra)) {
    fields.push(`${key} = @${key}`);
  }
  db.prepare(`UPDATE servers SET ${fields.join(", ")} WHERE id = @id`).run(params);
  return getServerById(id);
}

export function assignNode(id, nodeId) {
  db.prepare("UPDATE servers SET node_id = ?, updated_at = datetime('now') WHERE id = ?").run(nodeId, id);
  return getServerById(id);
}

export function incrementCrashCount(id) {
  db.prepare("UPDATE servers SET crash_count = crash_count + 1, updated_at = datetime('now') WHERE id = ?").run(id);
  return getServerById(id);
}

export function resetCrashCount(id) {
  db.prepare("UPDATE servers SET crash_count = 0, updated_at = datetime('now') WHERE id = ?").run(id);
}

export function slugExists(slug) {
  return !!db.prepare("SELECT 1 FROM servers WHERE slug = ?").get(slug);
}

export function listServersByStatus(status) {
  return db.prepare("SELECT * FROM servers WHERE status = ?").all(status);
}
