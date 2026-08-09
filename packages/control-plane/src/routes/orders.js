import { Router } from "express";
import { z } from "zod";
import { getPlanById } from "../repositories/plans.js";
import { createOrder, getOrderById, getOrderOwnedBy, listOrdersByUser, transitionOrderStatus, listAllOrders } from "../repositories/orders.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { heavyOpLimiter } from "../middleware/rateLimit.js";
import { recordAudit } from "../repositories/auditLog.js";
import { AuditEvent } from "@atlantic/shared";
import { enqueue } from "../queue/queue.js";
import { JobType } from "@atlantic/shared";

export const ordersRouter = Router();

const createOrderSchema = z.object({
  planId: z.string().uuid(),
  serverName: z.string().min(2).max(60),
  serverType: z.enum(["generic", "discord-bot", "node-app", "web-app"]).default("generic"),
  image: z.string().max(200).optional(),
  startCommand: z.string().max(500).optional(),
});

ordersRouter.post("/", requireAuth, heavyOpLimiter, validateBody(createOrderSchema), (req, res) => {
  const plan = getPlanById(req.body.planId);
  if (!plan || !plan.active) return res.status(404).json({ error: "not_found", message: "Plan not available" });

  const idempotencyKey = req.headers["idempotency-key"] || undefined;
  const order = createOrder({
    userId: req.user.id,
    planId: plan.id,
    amountCents: plan.price_cents,
    currency: plan.currency,
    idempotencyKey,
    serverConfig: {
      name: req.body.serverName,
      type: req.body.serverType,
      image: req.body.image,
      startCommand: req.body.startCommand,
    },
  });
  recordAudit({ actorUserId: req.user.id, event: AuditEvent.ORDER_CREATED, targetType: "order", targetId: order.id, metadata: { planId: plan.id }, ip: req.ip });
  res.status(201).json({ order });
});

ordersRouter.get("/", requireAuth, (req, res) => {
  res.json({ orders: listOrdersByUser(req.user.id) });
});

ordersRouter.get("/:id", requireAuth, (req, res) => {
  const order = req.user.role === "admin" ? getOrderById(req.params.id) : getOrderOwnedBy(req.params.id, req.user.id);
  if (!order) return res.status(404).json({ error: "not_found" });
  res.json({ order });
});

ordersRouter.get("/admin/all", requireAuth, requireAdmin, (req, res) => {
  const limit = Math.min(100, Number(req.query.limit) || 50);
  const offset = Number(req.query.offset) || 0;
  res.json(listAllOrders({ limit, offset }));
});

// Manual approval path for admins (e.g. bank transfer / offline payment
// confirmed by staff). Automated gateways should use POST /payments/webhook
// instead. Both paths funnel through the same idempotent transitionOrderStatus.
ordersRouter.post("/:id/approve", requireAuth, requireAdmin, (req, res) => {
  const order = getOrderById(req.params.id);
  if (!order) return res.status(404).json({ error: "not_found" });
  const result = transitionOrderStatus(order.id, "APPROVED");
  if (!result.ok) return res.status(409).json({ error: "conflict", message: result.reason });
  recordAudit({ actorUserId: req.user.id, actorType: "admin", event: AuditEvent.PAYMENT_APPROVED, targetType: "order", targetId: order.id, ip: req.ip });

  const config = JSON.parse(order.server_config_json || "{}");
  enqueue(JobType.PROVISION_SERVER, {
    orderId: order.id,
    userId: order.user_id,
    planId: order.plan_id,
    name: config.name || "server",
    type: config.type || "generic",
    image: config.image,
    startCommand: config.startCommand,
  }, { idempotencyKey: `provision:${order.id}` });

  res.json({ order: transitionOrderStatus(order.id, "PROVISIONING").order || result.order });
});
