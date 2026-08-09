import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// Must run before any src/ module is imported (config.js reads env at
// import time), so every test file does `import "./setup.js"` as its first
// import. Each test run gets its own throwaway SQLite file so tests never
// share or corrupt state with each other or with a real dev database.
const tmpDb = path.join(os.tmpdir(), `atlantic-test-${crypto.randomUUID()}.db`);
process.env.NODE_ENV = "test";
process.env.DB_PATH = tmpDb;
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "atlantic-storage-"));
process.env.BACKUPS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "atlantic-backups-"));
process.env.JWT_SECRET = "test-jwt-secret";
process.env.ENCRYPTION_KEY = "test-encryption-key";
process.env.NODE_AGENT_SECRET = "test-node-agent-secret";
process.env.PAYMENT_WEBHOOK_SECRET = "test-webhook-secret";
process.env.CORS_ORIGIN = "http://localhost:5173";
process.env.LOG_LEVEL = "silent";

export const testDbPath = tmpDb;
