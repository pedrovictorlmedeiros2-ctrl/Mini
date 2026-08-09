import WebSocket from "ws";
import fs from "node:fs";
import { config } from "./config.js";
import {
  createContainer,
  startContainer,
  stopContainer,
  restartContainer,
  deleteContainer,
  listManagedContainers,
  getContainerStats,
  docker,
} from "./docker.js";
import { listFiles, readFile, writeFile, deleteFile, renameFile, mkdir } from "./files.js";
import { createBackup, restoreBackup, deleteBackupFile } from "./backup.js";
import { watchLogs, unwatchLogs, unwatchAll } from "./logStreams.js";
import { totalRamMb, totalCpuPercent, totalDiskMb } from "./lib/systemStats.js";

fs.mkdirSync(config.volumesRoot, { recursive: true });
fs.mkdirSync(config.backupsRoot, { recursive: true });

function log(level, msg, extra = {}) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }));
}

const handlers = {
  CREATE_CONTAINER: (p) => createContainer(p),
  START_CONTAINER: (p) => startContainer(p.containerId),
  STOP_CONTAINER: (p) => stopContainer(p.containerId),
  RESTART_CONTAINER: (p) => restartContainer(p.containerId),
  DELETE_CONTAINER: (p) => (p.containerId ? deleteContainer(p.containerId) : Promise.resolve()),
  LIST_CONTAINERS: async () => ({ containers: await listManagedContainers() }),
  GET_STATS: (p) => getContainerStats(p.containerId),
  LIST_FILES: (p) => listFiles(p.serverId, p.path),
  READ_FILE: (p) => readFile(p.serverId, p.path, p.maxBytes || 2 * 1024 * 1024),
  WRITE_FILE: (p) => writeFile(p.serverId, p.path, p.content),
  DELETE_FILE: (p) => deleteFile(p.serverId, p.path),
  RENAME_FILE: (p) => renameFile(p.serverId, p.from, p.to),
  MKDIR: (p) => mkdir(p.serverId, p.path),
  // The control-plane tracks backups by its own DB-generated backup id and
  // just records whatever storagePath we return, so the on-disk filename
  // here only needs to be unique locally, not match anything upstream.
  CREATE_BACKUP: (p) => createBackup(p.serverId, `${p.serverId}-${Date.now()}`),
  RESTORE_BACKUP: (p) => restoreBackup(p.serverId, p.storagePath, p.expectedChecksum),
  DELETE_BACKUP: (p) => deleteBackupFile(p.storagePath),
};

let ws = null;
let heartbeatTimer = null;
let reconnectAttempt = 0;
let closedByUs = false;

function send(message) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

async function handleMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }

  if (msg.type === "command") {
    const handler = handlers[msg.action];
    if (!handler) {
      send({ type: "result", id: msg.id, ok: false, error: `unknown action ${msg.action}` });
      return;
    }
    try {
      const data = await handler(msg.payload || {});
      send({ type: "result", id: msg.id, ok: true, data: data ?? {} });
    } catch (err) {
      log("error", "command failed", { action: msg.action, err: err.message });
      send({ type: "result", id: msg.id, ok: false, error: err.message });
    }
    return;
  }

  if (msg.type === "WATCH_LOGS") {
    try {
      await watchLogs(msg.serverId, msg.containerId, (line) => {
        send({ type: "log", serverId: msg.serverId, line, ts: Date.now() });
      });
    } catch (err) {
      log("warn", "failed to start log watch", { serverId: msg.serverId, err: err.message });
    }
    return;
  }

  if (msg.type === "UNWATCH_LOGS") {
    unwatchLogs(msg.serverId);
  }
}

function startHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(async () => {
    try {
      const containers = await listManagedContainers();
      const [ramMbTotal, diskMbTotal] = await Promise.all([totalRamMb(), totalDiskMb()]);
      send({
        type: "heartbeat",
        metrics: {
          ramMbTotal,
          cpuPercentTotal: totalCpuPercent(),
          diskMbTotal,
          containersCount: containers.length,
        },
      });
    } catch (err) {
      log("error", "heartbeat collection failed", { err: err.message });
    }
  }, config.heartbeatIntervalMs);
}

// Docker-level crash detection independent of anyone watching logs: any
// managed container that dies while we didn't just ask it to stop should be
// reported so the control-plane can decide (it cross-checks its own DB
// status before treating this as an unexpected crash).
async function watchDockerEvents() {
  const stream = await docker.getEvents({ filters: { label: ["atlantic.managed=true"], event: ["die"] } });
  stream.on("data", (chunk) => {
    try {
      const evt = JSON.parse(chunk.toString());
      const serverId = evt.Actor?.Attributes?.["atlantic.serverId"];
      if (serverId) {
        send({ type: "exited", serverId, exitCode: evt.Actor?.Attributes?.exitCode });
      }
    } catch {
      // ignore malformed event frames
    }
  });
  stream.on("error", (err) => log("error", "docker event stream error", { err: err.message }));
}

function connect() {
  const url = `${config.controlPlaneWsUrl.replace(/\/$/, "")}/ws/agent?nodeId=${encodeURIComponent(config.nodeId)}`;
  ws = new WebSocket(url, { headers: { Authorization: `Bearer ${config.nodeToken}` } });

  ws.on("open", () => {
    reconnectAttempt = 0;
    log("info", "connected to control-plane", { nodeId: config.nodeId });
    startHeartbeat();
  });

  ws.on("message", handleMessage);

  ws.on("close", () => {
    clearInterval(heartbeatTimer);
    unwatchAll();
    if (closedByUs) return;
    reconnectAttempt++;
    const delay = Math.min(30_000, 1000 * 2 ** reconnectAttempt);
    log("warn", "disconnected from control-plane, reconnecting", { delayMs: delay });
    setTimeout(connect, delay);
  });

  ws.on("error", (err) => {
    log("error", "websocket error", { err: err.message });
  });
}

connect();
watchDockerEvents().catch((err) => log("error", "could not start docker event watcher", { err: err.message }));

function shutdown(signal) {
  log("info", "shutting down", { signal });
  closedByUs = true;
  clearInterval(heartbeatTimer);
  unwatchAll();
  if (ws) ws.close();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
