import { getPlanById } from "../repositories/plans.js";
import { createServer, updateServerStatus, slugExists } from "../repositories/servers.js";
import { transitionOrderStatus, getOrderById } from "../repositories/orders.js";
import { scheduleAndReserve, releaseReservation } from "./scheduler.js";
import { sendCommand } from "./agentRegistry.js";
import { recordAudit } from "../repositories/auditLog.js";
import { AuditEvent, ServerStatus } from "@atlantic/shared";
import { logger } from "../lib/logger.js";

function slugify(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40);
  return `${base || "server"}-${Math.random().toString(36).slice(2, 8)}`;
}

export class NoCapacityError extends Error {
  constructor() {
    super("No node currently has capacity for this plan");
    this.retryable = true;
  }
}

// Full provisioning workflow described in mission section 24/49. Runs as a
// queue job (see queue/handlers/provisionServer.js) so it survives a
// control-plane restart mid-flight (the job simply gets picked up again).
export async function provisionServer({ orderId, userId, planId, name, type = "generic", image, startCommand }) {
  const plan = getPlanById(planId);
  if (!plan) throw Object.assign(new Error("plan not found"), { retryable: false });

  const resourceReq = { ramMb: plan.ram_mb, cpuPercent: plan.cpu_percent, diskMb: plan.disk_mb };
  const node = scheduleAndReserve(resourceReq);
  if (!node) {
    // Nothing was created yet, so this is safe to retry as-is (capacity may
    // free up before max_attempts is reached). The caller (queue handler)
    // decides when to give up and mark the order FAILED.
    throw new NoCapacityError();
  }

  let slug = slugify(name);
  while (slugExists(slug)) slug = slugify(name);

  const server = createServer({
    user_id: userId,
    plan_id: planId,
    order_id: orderId || null,
    name,
    slug,
    type,
    image: image || "node:20-alpine",
    start_command: startCommand || null,
    ram_mb: plan.ram_mb,
    cpu_percent: plan.cpu_percent,
    disk_mb: plan.disk_mb,
    pids_limit: plan.pids_limit,
  });
  updateServerStatus(server.id, ServerStatus.CREATING, { node_id: node.id });

  try {
    updateServerStatus(server.id, ServerStatus.INSTALLING);
    const result = await sendCommand(node.id, "CREATE_CONTAINER", {
      serverId: server.id,
      slug: server.slug,
      image: server.image,
      startCommand: server.start_command,
      ramMb: plan.ram_mb,
      cpuPercent: plan.cpu_percent,
      diskMb: plan.disk_mb,
      pidsLimit: plan.pids_limit,
    }, { timeoutMs: 120_000 });

    updateServerStatus(server.id, ServerStatus.STOPPED, {
      container_id: result.containerId,
      volume_path: result.volumePath,
    });

    if (orderId) {
      transitionOrderStatus(orderId, "PROVISIONED", { server_id: server.id });
    }
    recordAudit({ actorUserId: userId, event: AuditEvent.SERVER_CREATED, targetType: "server", targetId: server.id, metadata: { nodeId: node.id, plan: plan.slug } });
    logger.info({ serverId: server.id, nodeId: node.id }, "server provisioned");
    return server;
  } catch (err) {
    // Rollback: release the reserved capacity and mark things failed instead
    // of leaving "server row exists, nothing actually running" (mission
    // section 50: DB and infrastructure must never silently diverge).
    logger.error({ serverId: server.id, err: err.message }, "provisioning failed, rolling back");
    releaseReservation(node.id, resourceReq);
    try {
      await sendCommand(node.id, "DELETE_CONTAINER", { serverId: server.id }, { timeoutMs: 15_000 });
    } catch {
      // best-effort cleanup; reconciler will catch any leftover container
    }
    updateServerStatus(server.id, ServerStatus.ERROR, { last_error: err.message });
    // A server row now exists for this order. Retrying the whole job from
    // scratch would create a *second* server row for the same order, so
    // once we've reached this point the job must not be retried — the user
    // sees the ERROR'd server and can explicitly delete/recreate it.
    err.retryable = false;
    throw err;
  }
}

export function getOrder(orderId) {
  return getOrderById(orderId);
}
