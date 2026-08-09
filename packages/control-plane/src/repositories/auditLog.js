import crypto from "node:crypto";
import { db } from "../db/index.js";
import { logger } from "../lib/logger.js";

const SENSITIVE_KEYS = new Set(["password", "token", "secret", "value", "authorization"]);

function sanitize(metadata) {
  if (!metadata) return {};
  const out = {};
  for (const [k, v] of Object.entries(metadata)) {
    out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? "[REDACTED]" : v;
  }
  return out;
}

export function recordAudit({ actorUserId = null, actorType = "user", event, targetType = null, targetId = null, metadata = {}, ip = null }) {
  try {
    db.prepare(`
      INSERT INTO audit_log (id, actor_user_id, actor_type, event, target_type, target_id, metadata_json, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), actorUserId, actorType, event, targetType, targetId, JSON.stringify(sanitize(metadata)), ip);
  } catch (err) {
    // Audit logging must never take down the request path it's observing.
    logger.error({ err: err.message, event }, "failed to record audit log entry");
  }
}

export function listAuditLog({ limit = 50, offset = 0, event = null, targetType = null } = {}) {
  const clauses = [];
  const params = [];
  if (event) { clauses.push("event = ?"); params.push(event); }
  if (targetType) { clauses.push("target_type = ?"); params.push(targetType); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`
    SELECT a.*, u.email AS actor_email FROM audit_log a
    LEFT JOIN users u ON u.id = a.actor_user_id
    ${where}
    ORDER BY a.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) AS c FROM audit_log ${where}`).get(...params).c;
  return { rows, total };
}
