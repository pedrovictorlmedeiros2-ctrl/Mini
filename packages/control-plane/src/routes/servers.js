import { Router } from "express";
import { z } from "zod";
import { getServerById, getServerOwnedBy, listServersByUser, listAllServers } from "../repositories/servers.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { heavyOpLimiter } from "../middleware/rateLimit.js";
import { validateBody } from "../middleware/validate.js";
import { enqueue } from "../queue/queue.js";
import { JobType } from "@atlantic/shared";
import { getUserQuota } from "../services/quota.js";
import { sendCommand } from "../services/agentRegistry.js";
import { recordAudit } from "../repositories/auditLog.js";
import { AuditEvent } from "@atlantic/shared";
import { upsertEnvVar, deleteEnvVar, listEnvVarsMasked } from "../repositories/envVars.js";
import { createDomain, listDomainsByServer, getDomainById, deleteDomain, getDomainByHostname } from "../repositories/domains.js";
import { createBackup, listBackupsByServer, getBackupById } from "../repositories/backups.js";

export const serversRouter = Router();

// Every route below operates on a specific server. This middleware is the
// single ownership/authorization chokepoint (mission section 34): admins can
// reach any server, regular users only their own. A server that exists but
// belongs to someone else returns 404, never 403 + leaked existence.
function loadServer(req, res, next) {
  const server = req.user.role === "admin" ? getServerById(req.params.id) : getServerOwnedBy(req.params.id, req.user.id);
  if (!server) return res.status(404).json({ error: "not_found" });
  req.server = server;
  next();
}

serversRouter.get("/", requireAuth, (req, res) => {
  if (req.user.role === "admin" && req.query.all === "true") {
    const limit = Math.min(100, Number(req.query.limit) || 50);
    const offset = Number(req.query.offset) || 0;
    return res.json(listAllServers({ limit, offset }));
  }
  res.json({ servers: listServersByUser(req.user.id), quota: getUserQuota(req.user.id) });
});

serversRouter.get("/:id", requireAuth, loadServer, (req, res) => {
  res.json({ server: req.server });
});

serversRouter.get("/:id/stats", requireAuth, loadServer, async (req, res) => {
  if (!req.server.node_id || !req.server.container_id) return res.json({ stats: null });
  try {
    const stats = await sendCommand(req.server.node_id, "GET_STATS", { containerId: req.server.container_id }, { timeoutMs: 10_000 });
    res.json({ stats });
  } catch (err) {
    res.status(503).json({ error: "unavailable", message: err.message });
  }
});

function actionRoute(action, jobType) {
  return async (req, res) => {
    const job = enqueue(jobType, { serverId: req.server.id, actorUserId: req.user.id }, { idempotencyKey: `${action}:${req.server.id}:${req.server.updated_at}` });
    res.status(202).json({ job: { id: job.id, status: job.status }, message: `${action} queued` });
  };
}

serversRouter.post("/:id/start", requireAuth, heavyOpLimiter, loadServer, actionRoute("start", JobType.START_SERVER));
serversRouter.post("/:id/stop", requireAuth, heavyOpLimiter, loadServer, actionRoute("stop", JobType.STOP_SERVER));
serversRouter.post("/:id/restart", requireAuth, heavyOpLimiter, loadServer, actionRoute("restart", JobType.RESTART_SERVER));

serversRouter.delete("/:id", requireAuth, heavyOpLimiter, loadServer, async (req, res) => {
  const job = enqueue(JobType.DELETE_SERVER, { serverId: req.server.id, actorUserId: req.user.id }, { idempotencyKey: `delete:${req.server.id}` });
  res.status(202).json({ job: { id: job.id, status: job.status }, message: "delete queued" });
});

// --- Environment variables -------------------------------------------------

const envSchema = z.object({
  key: z.string().min(1).max(100).regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be a valid env var name"),
  value: z.string().max(8192),
});

serversRouter.get("/:id/env", requireAuth, loadServer, (req, res) => {
  res.json({ env: listEnvVarsMasked(req.server.id) });
});

serversRouter.put("/:id/env", requireAuth, loadServer, validateBody(envSchema), (req, res) => {
  upsertEnvVar(req.server.id, req.body.key, req.body.value);
  recordAudit({ actorUserId: req.user.id, event: AuditEvent.ENV_VAR_UPDATED, targetType: "server", targetId: req.server.id, metadata: { key: req.body.key } });
  res.json({ env: listEnvVarsMasked(req.server.id) });
});

serversRouter.delete("/:id/env/:key", requireAuth, loadServer, (req, res) => {
  deleteEnvVar(req.server.id, req.params.key);
  recordAudit({ actorUserId: req.user.id, event: AuditEvent.ENV_VAR_UPDATED, targetType: "server", targetId: req.server.id, metadata: { key: req.params.key, deleted: true } });
  res.json({ env: listEnvVarsMasked(req.server.id) });
});

// --- Backups ----------------------------------------------------------------

serversRouter.get("/:id/backups", requireAuth, loadServer, (req, res) => {
  res.json({ backups: listBackupsByServer(req.server.id) });
});

serversRouter.post("/:id/backups", requireAuth, heavyOpLimiter, loadServer, (req, res) => {
  const quota = getUserQuota(req.server.user_id);
  if (quota.backups.limit && quota.backups.used >= quota.backups.limit) {
    return res.status(403).json({ error: "quota_exceeded", message: "Backup retention limit reached" });
  }
  const backup = createBackup(req.server.id);
  enqueue(JobType.BACKUP_SERVER, { serverId: req.server.id, backupId: backup.id }, { idempotencyKey: `backup:${backup.id}` });
  res.status(202).json({ backup });
});

serversRouter.post("/:id/backups/:backupId/restore", requireAuth, heavyOpLimiter, loadServer, (req, res) => {
  const backup = getBackupById(req.params.backupId);
  if (!backup || backup.server_id !== req.server.id) return res.status(404).json({ error: "not_found" });
  const job = enqueue(JobType.RESTORE_BACKUP, { serverId: req.server.id, backupId: backup.id, actorUserId: req.user.id });
  res.status(202).json({ job: { id: job.id } });
});

// --- Domains -----------------------------------------------------------------

const domainSchema = z.object({
  hostname: z.string().min(3).max(253).regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, "invalid hostname"),
});

serversRouter.get("/:id/domains", requireAuth, loadServer, (req, res) => {
  res.json({ domains: listDomainsByServer(req.server.id) });
});

serversRouter.post("/:id/domains", requireAuth, loadServer, validateBody(domainSchema), (req, res) => {
  if (getDomainByHostname(req.body.hostname)) {
    return res.status(409).json({ error: "conflict", message: "Domain already in use" });
  }
  const domain = createDomain(req.server.id, req.body.hostname);
  recordAudit({ actorUserId: req.user.id, event: AuditEvent.DOMAIN_ADDED, targetType: "server", targetId: req.server.id, metadata: { hostname: domain.hostname } });
  res.status(201).json({ domain });
});

serversRouter.delete("/:id/domains/:domainId", requireAuth, loadServer, (req, res) => {
  const domain = getDomainById(req.params.domainId);
  // Explicit cross-check: the domain must belong to *this* server, not just
  // exist. Without this a user could delete another tenant's domain by id.
  if (!domain || domain.server_id !== req.server.id) return res.status(404).json({ error: "not_found" });
  deleteDomain(domain.id);
  recordAudit({ actorUserId: req.user.id, event: AuditEvent.DOMAIN_REMOVED, targetType: "server", targetId: req.server.id, metadata: { hostname: domain.hostname } });
  res.json({ ok: true });
});

export { loadServer };
