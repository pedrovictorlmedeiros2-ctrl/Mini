import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");

function required(name, devFallback) {
  const value = process.env[name];
  if (value && value.trim()) return value;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      `Missing required environment variable ${name}. Refusing to start in production without it.`
    );
  }
  // In dev/test we generate a random ephemeral value so the app still boots,
  // but we log loudly so nobody mistakes this for a real secret.
  // eslint-disable-next-line no-console
  console.warn(
    `[config] ${name} not set — using an ephemeral dev-only value. Set it in .env for real deployments.`
  );
  return devFallback ?? crypto.randomBytes(32).toString("hex");
}

export const config = Object.freeze({
  env: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 4000),
  dbPath: process.env.DB_PATH || path.join(dataDir, "atlantic.db"),
  storageDir: process.env.STORAGE_DIR || path.join(dataDir, "storage"),
  backupsDir: process.env.BACKUPS_DIR || path.join(dataDir, "backups"),
  jwtSecret: required("JWT_SECRET"),
  encryptionKey: required("ENCRYPTION_KEY"),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "12h",
  nodeAgentSecret: required("NODE_AGENT_SECRET"),
  webhookSecret: required("PAYMENT_WEBHOOK_SECRET"),
  corsOrigin: process.env.CORS_ORIGIN || "http://localhost:5173",
  adminEmail: process.env.ADMIN_EMAIL || "",
  adminPassword: process.env.ADMIN_PASSWORD || "",
  reconcileIntervalMs: Number(process.env.RECONCILE_INTERVAL_MS || 60_000),
  heartbeatTimeoutMs: Number(process.env.NODE_HEARTBEAT_TIMEOUT_MS || 45_000),
  queueConcurrency: Number(process.env.QUEUE_CONCURRENCY || 5),
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 100),
});
