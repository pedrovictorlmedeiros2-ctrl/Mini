import { Router } from "express";
import { z } from "zod";
import { listPlans, createPlan, updatePlan, getPlanById } from "../repositories/plans.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { recordAudit } from "../repositories/auditLog.js";
import { AuditEvent } from "@atlantic/shared";
import { RESOURCE_HARD_CAPS } from "@atlantic/shared";

export const plansRouter = Router();

plansRouter.get("/", (req, res) => {
  res.json({ plans: listPlans({ activeOnly: true }) });
});

const planSchema = z.object({
  slug: z.string().min(2).max(40).regex(/^[a-z0-9-]+$/),
  name: z.string().min(2).max(60),
  ram_mb: z.number().int().min(64).max(RESOURCE_HARD_CAPS.maxRamMb),
  cpu_percent: z.number().int().min(10).max(RESOURCE_HARD_CAPS.maxCpuPercent),
  disk_mb: z.number().int().min(256).max(RESOURCE_HARD_CAPS.maxDiskMb),
  pids_limit: z.number().int().min(16).max(RESOURCE_HARD_CAPS.maxPidsLimit).default(256),
  max_servers: z.number().int().min(1).max(1000).default(1),
  max_backups: z.number().int().min(0).max(100).default(3),
  price_cents: z.number().int().min(0).default(0),
  currency: z.string().length(3).default("BRL"),
  active: z.union([z.literal(0), z.literal(1)]).default(1),
});

plansRouter.get("/admin/all", requireAuth, requireAdmin, (req, res) => {
  res.json({ plans: listPlans({ activeOnly: false }) });
});

plansRouter.post("/admin", requireAuth, requireAdmin, validateBody(planSchema), (req, res) => {
  const plan = createPlan(req.body);
  recordAudit({ actorUserId: req.user.id, actorType: "admin", event: AuditEvent.ADMIN_ACTION, targetType: "plan", targetId: plan.id, metadata: { action: "plan_created" }, ip: req.ip });
  res.status(201).json({ plan });
});

plansRouter.patch("/admin/:id", requireAuth, requireAdmin, validateBody(planSchema.partial()), (req, res) => {
  const existing = getPlanById(req.params.id);
  if (!existing) return res.status(404).json({ error: "not_found" });
  const plan = updatePlan(req.params.id, req.body);
  recordAudit({ actorUserId: req.user.id, actorType: "admin", event: AuditEvent.ADMIN_ACTION, targetType: "plan", targetId: plan.id, metadata: { action: "plan_updated" }, ip: req.ip });
  res.json({ plan });
});
