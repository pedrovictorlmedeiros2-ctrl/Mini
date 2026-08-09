import { listActiveNodes, reserveResources, releaseResources } from "../repositories/nodes.js";
import { isNodeConnected } from "./agentRegistry.js";

// Score = weighted free-capacity ratio across RAM/CPU/disk, biased by node
// weight (an admin dial for "prefer this node") and lightly penalized by
// current container count (spreads small workloads instead of packing one
// node with hundreds of tiny bots before touching the next node).
function score(node) {
  const freeRamRatio = 1 - node.ram_mb_reserved / Math.max(1, node.ram_mb_total);
  const freeCpuRatio = 1 - node.cpu_percent_reserved / Math.max(1, node.cpu_percent_total);
  const freeDiskRatio = 1 - node.disk_mb_reserved / Math.max(1, node.disk_mb_total);
  const base = freeRamRatio * 0.45 + freeCpuRatio * 0.35 + freeDiskRatio * 0.2;
  const weightFactor = (node.weight || 100) / 100;
  const densityPenalty = Math.min(0.2, node.containers_count * 0.002);
  return base * weightFactor - densityPenalty;
}

function fits(node, req) {
  return (
    node.ram_mb_reserved + req.ramMb <= node.ram_mb_total &&
    node.cpu_percent_reserved + req.cpuPercent <= node.cpu_percent_total &&
    node.disk_mb_reserved + req.diskMb <= node.disk_mb_total
  );
}

// Selects and atomically reserves a node for the given resource requirement.
// Returns the reserved node, or null if no node currently has capacity.
// The DB-level UPDATE...WHERE guard in reserveResources() is what actually
// prevents two concurrent provisioning requests from double-booking the
// same free capacity; the in-memory scoring here only picks which node to
// *try* first.
export function scheduleAndReserve(req) {
  const candidates = listActiveNodes()
    .filter((n) => isNodeConnected(n.id))
    .filter((n) => fits(n, req))
    .sort((a, b) => score(b) - score(a));

  for (const node of candidates) {
    if (reserveResources(node.id, req)) {
      return node;
    }
    // Lost the race to another request between listing and reserving; try
    // the next best candidate instead of failing outright.
  }
  return null;
}

export function releaseReservation(nodeId, req) {
  releaseResources(nodeId, req);
}
