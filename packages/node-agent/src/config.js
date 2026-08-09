import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");

function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`);
  }
  return v;
}

export const config = Object.freeze({
  nodeId: required("NODE_ID"),
  nodeToken: required("NODE_TOKEN"),
  controlPlaneWsUrl: process.env.CONTROL_PLANE_WS_URL || "ws://localhost:4000",
  volumesRoot: process.env.VOLUMES_ROOT || path.join(dataDir, "volumes"),
  backupsRoot: process.env.BACKUPS_ROOT || path.join(dataDir, "backups"),
  heartbeatIntervalMs: Number(process.env.HEARTBEAT_INTERVAL_MS || 10_000),
  containerUser: process.env.CONTAINER_USER || "1000:1000",
  logTailLines: Number(process.env.LOG_TAIL_LINES || 500),
});
