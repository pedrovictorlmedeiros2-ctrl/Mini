import { Router } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { createNode, listNodes, getNodeById, setNodeStatus } from "../repositories/nodes.js";
import { isNodeConnected } from "../services/agentRegistry.js";
import { hashToken } from "../lib/crypto.js";
import { recordAudit } from "../repositories/auditLog.js";
import { AuditEvent, NodeStatus } from "@atlantic/shared";
import { RESOURCE_HARD_CAPS } from "@atlantic/shared";

export const nodesRouter = Router();

nodesRouter.use(requireAuth, requireAdmin);

const createNodeSchema = z.object({
  name: z.string().min(2).max(60),
  hostname: z.string().min(2).max(253),
  region: z.string().min(2).max(40).default("default"),
  ramMbTotal: z.number().int().min(0).max(RESOURCE_HARD_CAPS.maxRamMb * 50),
  cpuPercentTotal: z.number().int().min(0).max(RESOURCE_HARD_CAPS.maxCpuPercent * 50),
  diskMbTotal: z.number().int().min(0).max(RESOURCE_HARD_CAPS.maxDiskMb * 50),
  weight: z.number().int().min(1).max(1000).default(100),
});

nodesRouter.get("/", (req, res) => {
  const nodes = listNodes().map((n) => ({ ...n, connected: isNodeConnected(n.id) }));
  res.json({ nodes });
});

nodesRouter.post("/", validateBody(createNodeSchema), (req, res) => {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const node = createNode({ ...req.body, agentTokenHash: hashToken(rawToken) });
  recordAudit({ actorUserId: req.user.id, actorType: "admin", event: AuditEvent.NODE_REGISTERED, targetType: "node", targetId: node.id, ip: req.ip });
  // The raw token is returned exactly once. It must be copied into the
  // node-agent's environment (NODE_ID / NODE_TOKEN) immediately.
  res.status(201).json({ node, agentToken: rawToken, warning: "Save this token now — it will not be shown again." });
});

const statusSchema = z.object({ status: z.enum([NodeStatus.ACTIVE, NodeStatus.MAINTENANCE, NodeStatus.DRAINING]) });

nodesRouter.patch("/:id/status", validateBody(statusSchema), (req, res) => {
  const node = getNodeById(req.params.id);
  if (!node) return res.status(404).json({ error: "not_found" });
  const updated = setNodeStatus(node.id, req.body.status);
  recordAudit({
    actorUserId: req.user.id,
    actorType: "admin",
    event: req.body.status === NodeStatus.MAINTENANCE ? AuditEvent.NODE_MAINTENANCE : AuditEvent.ADMIN_ACTION,
    targetType: "node",
    targetId: node.id,
    metadata: { status: req.body.status },
    ip: req.ip,
  });
  res.json({ node: updated });
});
