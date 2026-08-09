import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { uploadLimiter, apiLimiter } from "../middleware/rateLimit.js";
import { validateBody } from "../middleware/validate.js";
import { loadServer } from "./servers.js";
import { sendCommand } from "../services/agentRegistry.js";
import { isSafeRelativePath } from "../lib/safePath.js";
import { recordAudit } from "../repositories/auditLog.js";
import { AuditEvent } from "@atlantic/shared";
import { config } from "../config.js";
import { respondAgentError } from "../lib/agentError.js";

export const filesRouter = Router({ mergeParams: true });

function requireProvisioned(req, res, next) {
  if (!req.server.node_id || !req.server.container_id) {
    return res.status(409).json({ error: "not_ready", message: "Server has no filesystem yet" });
  }
  next();
}

function safePathMiddleware(req, res, next) {
  const p = req.body?.path ?? req.query?.path ?? "";
  if (!isSafeRelativePath(p === "" ? "." : p)) {
    return res.status(400).json({ error: "validation_error", message: "Invalid or unsafe path" });
  }
  next();
}

filesRouter.get("/", requireAuth, loadServer, requireProvisioned, apiLimiter, safePathMiddleware, async (req, res) => {
  try {
    const listing = await sendCommand(req.server.node_id, "LIST_FILES", {
      serverId: req.server.id,
      path: req.query.path || ".",
    }, { timeoutMs: 15_000 });
    res.json(listing);
  } catch (err) {
    respondAgentError(res, err, { serverId: req.server.id });
  }
});

const MAX_INLINE_FILE_BYTES = 2 * 1024 * 1024; // 2MB cap for edit-in-browser; larger files need a future direct-download path

filesRouter.get("/content", requireAuth, loadServer, requireProvisioned, apiLimiter, safePathMiddleware, async (req, res) => {
  try {
    const result = await sendCommand(req.server.node_id, "READ_FILE", {
      serverId: req.server.id,
      path: req.query.path,
      maxBytes: MAX_INLINE_FILE_BYTES,
    }, { timeoutMs: 15_000 });
    res.json(result);
  } catch (err) {
    respondAgentError(res, err, { serverId: req.server.id });
  }
});

const writeSchema = z.object({
  path: z.string().min(1),
  content: z.string().max(MAX_INLINE_FILE_BYTES),
});

filesRouter.put("/content", requireAuth, loadServer, requireProvisioned, uploadLimiter, validateBody(writeSchema), async (req, res) => {
  if (!isSafeRelativePath(req.body.path)) {
    return res.status(400).json({ error: "validation_error", message: "Invalid or unsafe path" });
  }
  try {
    await sendCommand(req.server.node_id, "WRITE_FILE", {
      serverId: req.server.id,
      path: req.body.path,
      content: req.body.content,
    }, { timeoutMs: 20_000 });
    recordAudit({ actorUserId: req.user.id, event: AuditEvent.FILE_UPLOADED, targetType: "server", targetId: req.server.id, metadata: { path: req.body.path } });
    res.json({ ok: true });
  } catch (err) {
    respondAgentError(res, err, { serverId: req.server.id });
  }
});

const mkdirSchema = z.object({ path: z.string().min(1) });

filesRouter.post("/mkdir", requireAuth, loadServer, requireProvisioned, apiLimiter, validateBody(mkdirSchema), async (req, res) => {
  if (!isSafeRelativePath(req.body.path)) return res.status(400).json({ error: "validation_error" });
  try {
    await sendCommand(req.server.node_id, "MKDIR", { serverId: req.server.id, path: req.body.path }, { timeoutMs: 10_000 });
    res.json({ ok: true });
  } catch (err) {
    respondAgentError(res, err, { serverId: req.server.id });
  }
});

const renameSchema = z.object({ from: z.string().min(1), to: z.string().min(1) });

filesRouter.post("/rename", requireAuth, loadServer, requireProvisioned, apiLimiter, validateBody(renameSchema), async (req, res) => {
  if (!isSafeRelativePath(req.body.from) || !isSafeRelativePath(req.body.to)) {
    return res.status(400).json({ error: "validation_error" });
  }
  try {
    await sendCommand(req.server.node_id, "RENAME_FILE", { serverId: req.server.id, from: req.body.from, to: req.body.to }, { timeoutMs: 10_000 });
    res.json({ ok: true });
  } catch (err) {
    respondAgentError(res, err, { serverId: req.server.id });
  }
});

filesRouter.delete("/", requireAuth, loadServer, requireProvisioned, apiLimiter, safePathMiddleware, async (req, res) => {
  try {
    await sendCommand(req.server.node_id, "DELETE_FILE", { serverId: req.server.id, path: req.body.path }, { timeoutMs: 15_000 });
    recordAudit({ actorUserId: req.user.id, event: AuditEvent.FILE_DELETED, targetType: "server", targetId: req.server.id, metadata: { path: req.body.path } });
    res.json({ ok: true });
  } catch (err) {
    respondAgentError(res, err, { serverId: req.server.id });
  }
});

// Config caps referenced by the panel for client-side validation hints.
filesRouter.get("/limits", requireAuth, (req, res) => {
  res.json({ maxInlineFileBytes: MAX_INLINE_FILE_BYTES, maxUploadMb: config.maxUploadMb });
});
