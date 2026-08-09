import { Router } from "express";
import crypto from "node:crypto";
import express from "express";
import { z } from "zod";
import { config } from "../config.js";
import { getOrderById, transitionOrderStatus, findOrderByPaymentRef } from "../repositories/orders.js";
import { recordAudit } from "../repositories/auditLog.js";
import { AuditEvent, JobType } from "@atlantic/shared";
import { enqueue } from "../queue/queue.js";
import { logger } from "../lib/logger.js";

export const paymentsRouter = Router();

const webhookSchema = z.object({
  orderId: z.string().uuid(),
  provider: z.string().min(1).max(40),
  ref: z.string().min(1).max(200),
  status: z.enum(["approved", "declined"]),
});

function timingSafeEqualHex(a, b) {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Uses express.raw() (not the global json() parser) specifically for this
// route so the signature is verified against the exact bytes the provider
// signed, not a re-serialized copy.
paymentsRouter.post("/webhook", express.raw({ type: "application/json", limit: "256kb" }), (req, res) => {
  const signature = req.headers["x-signature"];
  if (typeof signature !== "string") {
    return res.status(401).json({ error: "unauthorized", message: "Missing signature" });
  }
  const expected = crypto.createHmac("sha256", config.webhookSecret).update(req.body).digest("hex");
  if (!timingSafeEqualHex(signature, expected)) {
    logger.warn({ ip: req.ip }, "payment webhook signature mismatch");
    return res.status(401).json({ error: "unauthorized", message: "Invalid signature" });
  }

  let json;
  try {
    json = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "validation_error", message: "Invalid JSON" });
  }
  const parsed = webhookSchema.safeParse(json);
  if (!parsed.success) {
    return res.status(400).json({ error: "validation_error", issues: parsed.error.issues });
  }
  const { orderId, provider, ref, status } = parsed.data;

  // Idempotency: if this exact (provider, ref) was already processed for a
  // different or the same order, don't reprocess. Duplicate/out-of-order
  // webhook deliveries are expected from real payment providers.
  const dup = findOrderByPaymentRef(provider, ref);
  if (dup && dup.id !== orderId) {
    logger.warn({ provider, ref, orderId }, "payment ref already bound to a different order; ignoring");
    return res.status(200).json({ ok: true, note: "duplicate_ignored" });
  }

  const order = getOrderById(orderId);
  if (!order) return res.status(404).json({ error: "not_found" });

  if (status === "approved") {
    const result = transitionOrderStatus(orderId, "APPROVED", { payment_provider: provider, payment_ref: ref });
    if (!result.ok && result.reason !== "already_terminal") {
      return res.status(409).json({ error: "conflict", message: result.reason });
    }
    if (result.ok && !result.noop) {
      recordAudit({ actorType: "system", event: AuditEvent.PAYMENT_APPROVED, targetType: "order", targetId: orderId, metadata: { provider, ref } });
      const cfg = JSON.parse(order.server_config_json || "{}");
      transitionOrderStatus(orderId, "PROVISIONING");
      enqueue(JobType.PROVISION_SERVER, {
        orderId,
        userId: order.user_id,
        planId: order.plan_id,
        name: cfg.name || "server",
        type: cfg.type || "generic",
        image: cfg.image,
        startCommand: cfg.startCommand,
      }, { idempotencyKey: `provision:${orderId}` });
    }
  } else {
    const result = transitionOrderStatus(orderId, "DECLINED", { payment_provider: provider, payment_ref: ref });
    if (result.ok && !result.noop) {
      recordAudit({ actorType: "system", event: AuditEvent.PAYMENT_DECLINED, targetType: "order", targetId: orderId, metadata: { provider, ref } });
    }
  }

  res.status(200).json({ ok: true });
});
