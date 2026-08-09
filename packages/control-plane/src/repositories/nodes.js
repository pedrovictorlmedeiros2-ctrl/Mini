import crypto from "node:crypto";
import { db } from "../db/index.js";

export function createNode({ name, hostname, region, agentTokenHash, ramMbTotal, cpuPercentTotal, diskMbTotal, weight }) {
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO nodes (id, name, hostname, region, agent_token_hash, status, ram_mb_total, cpu_percent_total, disk_mb_total, weight)
    VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)
  `).run(id, name, hostname, region || "default", agentTokenHash, ramMbTotal || 0, cpuPercentTotal || 0, diskMbTotal || 0, weight ?? 100);
  return getNodeById(id);
}

export function getNodeById(id) {
  return db.prepare("SELECT * FROM nodes WHERE id = ?").get(id);
}

export function listNodes() {
  return db.prepare("SELECT * FROM nodes ORDER BY created_at ASC").all();
}

export function listActiveNodes() {
  return db.prepare("SELECT * FROM nodes WHERE status = 'ACTIVE'").all();
}

export function setNodeStatus(id, status) {
  db.prepare("UPDATE nodes SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
  return getNodeById(id);
}

export function recordHeartbeat(id, metrics) {
  const { ramMbTotal, cpuPercentTotal, diskMbTotal, containersCount } = metrics || {};
  db.prepare(`
    UPDATE nodes SET
      status = CASE WHEN status = 'OFFLINE' THEN 'ACTIVE' ELSE status END,
      last_heartbeat_at = datetime('now'),
      ram_mb_total = COALESCE(?, ram_mb_total),
      cpu_percent_total = COALESCE(?, cpu_percent_total),
      disk_mb_total = COALESCE(?, disk_mb_total),
      containers_count = COALESCE(?, containers_count),
      last_metrics_json = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(ramMbTotal ?? null, cpuPercentTotal ?? null, diskMbTotal ?? null, containersCount ?? null, JSON.stringify(metrics || {}), id);
  return getNodeById(id);
}

export function listStaleNodes(cutoffIso) {
  return db.prepare(`
    SELECT * FROM nodes
    WHERE status = 'ACTIVE' AND (last_heartbeat_at IS NULL OR last_heartbeat_at < ?)
  `).all(cutoffIso);
}

// Atomically reserve resources on a node to prevent two concurrent
// provisioning requests from both scheduling onto the same "free" capacity.
// Returns true if the reservation succeeded (i.e. capacity was available).
export function reserveResources(id, { ramMb, cpuPercent, diskMb }) {
  const result = db.prepare(`
    UPDATE nodes SET
      ram_mb_reserved = ram_mb_reserved + ?,
      cpu_percent_reserved = cpu_percent_reserved + ?,
      disk_mb_reserved = disk_mb_reserved + ?,
      containers_count = containers_count + 1,
      updated_at = datetime('now')
    WHERE id = ?
      AND status = 'ACTIVE'
      AND (ram_mb_reserved + ?) <= ram_mb_total
      AND (cpu_percent_reserved + ?) <= cpu_percent_total
      AND (disk_mb_reserved + ?) <= disk_mb_total
  `).run(ramMb, cpuPercent, diskMb, id, ramMb, cpuPercent, diskMb);
  return result.changes === 1;
}

export function releaseResources(id, { ramMb, cpuPercent, diskMb }) {
  db.prepare(`
    UPDATE nodes SET
      ram_mb_reserved = MAX(0, ram_mb_reserved - ?),
      cpu_percent_reserved = MAX(0, cpu_percent_reserved - ?),
      disk_mb_reserved = MAX(0, disk_mb_reserved - ?),
      containers_count = MAX(0, containers_count - 1),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(ramMb, cpuPercent, diskMb, id);
}
