import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { listUsers, getUserById, setUserStatus, setUserRole } from "../repositories/users.js";
import { listServersByUser } from "../repositories/servers.js";
import { listOrdersByUser } from "../repositories/orders.js";
import { listAuditLog } from "../repositories/auditLog.js";
import { getQueueStats } from "../queue/queue.js";
import { recordAudit } from "../repositories/auditLog.js";
import { AuditEvent } from "@atlantic/shared";
import { db } from "../db/index.js";

export const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

adminRouter.get("/users", (req, res) => {
  const limit = Math.min(100, Number(req.query.limit) || 50);
  const offset = Number(req.query.offset) || 0;
  res.json(listUsers({ limit, offset, q: req.query.q || "" }));
});

adminRouter.get("/users/:id", (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: "not_found" });
  const { password_hash, ...safe } = user;
  res.json({
    user: safe,
    servers: listServersByUser(user.id),
    orders: listOrdersByUser(user.id),
  });
});

const statusSchema = z.object({ status: z.enum(["active", "blocked"]) });

adminRouter.patch("/users/:id/status", validateBody(statusSchema), (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: "not_found" });
  const updated = setUserStatus(user.id, req.body.status);
  recordAudit({
    actorUserId: req.user.id,
    actorType: "admin",
    event: req.body.status === "blocked" ? AuditEvent.USER_BLOCKED : AuditEvent.USER_UNBLOCKED,
    targetType: "user",
    targetId: user.id,
    ip: req.ip,
  });
  const { password_hash, ...safe } = updated;
  res.json({ user: safe });
});

const roleSchema = z.object({ role: z.enum(["user", "admin"]) });

adminRouter.patch("/users/:id/role", validateBody(roleSchema), (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: "invalid_action", message: "Cannot change your own role" });
  }
  const user = getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: "not_found" });
  const updated = setUserRole(user.id, req.body.role);
  recordAudit({ actorUserId: req.user.id, actorType: "admin", event: AuditEvent.ADMIN_ACTION, targetType: "user", targetId: user.id, metadata: { action: "role_changed", role: req.body.role }, ip: req.ip });
  const { password_hash, ...safe } = updated;
  res.json({ user: safe });
});

adminRouter.get("/audit-log", (req, res) => {
  const limit = Math.min(200, Number(req.query.limit) || 50);
  const offset = Number(req.query.offset) || 0;
  res.json(listAuditLog({ limit, offset, event: req.query.event || null, targetType: req.query.targetType || null }));
});

adminRouter.get("/overview", (req, res) => {
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users) AS users,
      (SELECT COUNT(*) FROM servers WHERE status != 'DELETED') AS servers,
      (SELECT COUNT(*) FROM servers WHERE status = 'RUNNING') AS servers_running,
      (SELECT COUNT(*) FROM nodes) AS nodes,
      (SELECT COUNT(*) FROM nodes WHERE status = 'ACTIVE') AS nodes_active,
      (SELECT COUNT(*) FROM orders WHERE status = 'PROVISIONED') AS orders_provisioned,
      (SELECT COALESCE(SUM(amount_cents),0) FROM orders WHERE status = 'PROVISIONED') AS revenue_cents
  `).get();
  res.json({ counts, queue: getQueueStats() });
});
