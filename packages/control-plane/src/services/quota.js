import { db } from "../db/index.js";

// Account-wide usage vs. limits, aggregated from purchases (each provisioned
// order grants exactly one server, sized by its plan) and current live
// servers. Deleting a server frees resource *usage* but does not refund the
// purchase slot — matches how real hosting purchases work.
export function getUserQuota(userId) {
  const limits = db.prepare(`
    SELECT
      COUNT(*) AS servers_limit,
      COALESCE(SUM(p.ram_mb), 0) AS ram_limit_mb,
      COALESCE(SUM(p.cpu_percent), 0) AS cpu_limit_percent,
      COALESCE(SUM(p.disk_mb), 0) AS disk_limit_mb,
      COALESCE(SUM(p.max_backups), 0) AS backups_limit
    FROM orders o JOIN plans p ON p.id = o.plan_id
    WHERE o.user_id = ? AND o.status = 'PROVISIONED'
  `).get(userId);

  const used = db.prepare(`
    SELECT
      COUNT(*) AS servers_used,
      COALESCE(SUM(ram_mb), 0) AS ram_used_mb,
      COALESCE(SUM(cpu_percent), 0) AS cpu_used_percent,
      COALESCE(SUM(disk_mb), 0) AS disk_used_mb
    FROM servers WHERE user_id = ? AND status != 'DELETED'
  `).get(userId);

  const backupsUsed = db.prepare(`
    SELECT COUNT(*) AS c FROM backups b
    JOIN servers s ON s.id = b.server_id
    WHERE s.user_id = ? AND b.status = 'COMPLETED'
  `).get(userId).c;

  return {
    servers: { used: used.servers_used, limit: limits.servers_limit },
    ramMb: { used: used.ram_used_mb, limit: limits.ram_limit_mb },
    cpuPercent: { used: used.cpu_used_percent, limit: limits.cpu_limit_percent },
    diskMb: { used: used.disk_used_mb, limit: limits.disk_limit_mb },
    backups: { used: backupsUsed, limit: limits.backups_limit },
  };
}
