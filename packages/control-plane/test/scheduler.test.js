import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runMigrations } from "../src/db/index.js";
import { createNode, reserveResources, getNodeById, setNodeStatus } from "../src/repositories/nodes.js";
import { scheduleAndReserve } from "../src/services/scheduler.js";
import { registerConnection } from "../src/services/agentRegistry.js";

runMigrations();

test("reserveResources refuses to overcommit a node's declared capacity", () => {
  const node = createNode({ name: "n1", hostname: "h1", agentTokenHash: "hash1", ramMbTotal: 1024, cpuPercentTotal: 100, diskMbTotal: 1024 });
  setNodeStatus(node.id, "ACTIVE");

  const first = reserveResources(node.id, { ramMb: 700, cpuPercent: 50, diskMb: 100 });
  assert.equal(first, true, "first reservation fits and should succeed");

  const second = reserveResources(node.id, { ramMb: 700, cpuPercent: 50, diskMb: 100 });
  assert.equal(second, false, "second reservation would exceed total RAM and must be rejected");

  const updated = getNodeById(node.id);
  assert.equal(updated.ram_mb_reserved, 700, "reserved amount must reflect only the successful reservation");
});

test("scheduleAndReserve only considers ACTIVE nodes with a live agent connection", () => {
  const offline = createNode({ name: "offline", hostname: "h2", agentTokenHash: "hash2", ramMbTotal: 4096, cpuPercentTotal: 400, diskMbTotal: 4096 });
  setNodeStatus(offline.id, "ACTIVE");
  // Never registered a connection for `offline`, so it must be skipped even
  // though it's ACTIVE and has plenty of capacity.

  const online = createNode({ name: "online", hostname: "h3", agentTokenHash: "hash3", ramMbTotal: 2048, cpuPercentTotal: 200, diskMbTotal: 2048 });
  setNodeStatus(online.id, "ACTIVE");
  registerConnection(online.id, { readyState: 1, OPEN: 1, send: () => {} });

  const picked = scheduleAndReserve({ ramMb: 512, cpuPercent: 50, diskMb: 512 });
  assert.equal(picked.id, online.id, "must pick the connected node, not the disconnected one");
});

test("scheduleAndReserve returns null when no node has capacity", () => {
  const tiny = createNode({ name: "tiny", hostname: "h4", agentTokenHash: "hash4", ramMbTotal: 100, cpuPercentTotal: 10, diskMbTotal: 100 });
  setNodeStatus(tiny.id, "ACTIVE");
  registerConnection(tiny.id, { readyState: 1, OPEN: 1, send: () => {} });

  const picked = scheduleAndReserve({ ramMb: 99999, cpuPercent: 50, diskMb: 100 });
  assert.equal(picked, null);
});
