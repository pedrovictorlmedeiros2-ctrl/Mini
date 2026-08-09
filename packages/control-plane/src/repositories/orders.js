import crypto from "node:crypto";
import { db } from "../db/index.js";

export function createOrder({ userId, planId, amountCents, currency, idempotencyKey, serverConfig }) {
  // Idempotent create: if a client retries the same logical order (same
  // idempotency key), return the existing row instead of creating a duplicate.
  if (idempotencyKey) {
    const existing = db.prepare("SELECT * FROM orders WHERE idempotency_key = ?").get(idempotencyKey);
    if (existing) return existing;
  }
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO orders (id, user_id, plan_id, status, amount_cents, currency, idempotency_key, server_config_json)
    VALUES (?, ?, ?, 'PENDING', ?, ?, ?, ?)
  `).run(id, userId, planId, amountCents, currency || "BRL", idempotencyKey || null, JSON.stringify(serverConfig || {}));
  return getOrderById(id);
}

export function getOrderById(id) {
  return db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
}

export function getOrderOwnedBy(id, userId) {
  return db.prepare("SELECT * FROM orders WHERE id = ? AND user_id = ?").get(id, userId);
}

export function listOrdersByUser(userId) {
  return db.prepare("SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC").all(userId);
}

export function listAllOrders({ limit = 50, offset = 0 } = {}) {
  const rows = db.prepare(`
    SELECT o.*, u.email AS user_email FROM orders o JOIN users u ON u.id = o.user_id
    ORDER BY o.created_at DESC LIMIT ? OFFSET ?
  `).all(limit, offset);
  const total = db.prepare("SELECT COUNT(*) AS c FROM orders").get().c;
  return { rows, total };
}

// Payment webhooks can arrive more than once (retries, duplicates) and can
// arrive out of order. This does a conditional transition so a stale/duplicate
// webhook can never move an order backwards (e.g. DECLINED after APPROVED).
const TERMINAL_STATUSES = new Set(["PROVISIONED", "FAILED", "CANCELLED", "EXPIRED", "DECLINED"]);

export function transitionOrderStatus(id, toStatus, extra = {}) {
  const order = getOrderById(id);
  if (!order) return { ok: false, reason: "not_found" };
  if (order.status === toStatus) return { ok: true, order, noop: true };
  if (TERMINAL_STATUSES.has(order.status)) {
    return { ok: false, reason: "already_terminal", order };
  }
  const fields = ["status = @status", "updated_at = datetime('now')"];
  const params = { id, status: toStatus, ...extra };
  for (const key of Object.keys(extra)) fields.push(`${key} = @${key}`);
  db.prepare(`UPDATE orders SET ${fields.join(", ")} WHERE id = @id`).run(params);
  return { ok: true, order: getOrderById(id) };
}

export function findOrderByPaymentRef(provider, ref) {
  return db.prepare("SELECT * FROM orders WHERE payment_provider = ? AND payment_ref = ?").get(provider, ref);
}
