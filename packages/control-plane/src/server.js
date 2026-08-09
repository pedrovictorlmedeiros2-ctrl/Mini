import http from "node:http";
import fs from "node:fs";
import { config } from "./config.js";
import { logger } from "./lib/logger.js";
import { runMigrations, db } from "./db/index.js";
import { seed } from "./db/seed.js";
import { createApp } from "./app.js";
import { attachWebSocketServer } from "./ws/index.js";
import { registerJobHandlers } from "./queue/handlers.js";
import { startQueueWorker, stopQueueWorker } from "./queue/queue.js";
import { runReconciliation } from "./services/reconciler.js";

async function main() {
  logger.info({ env: config.env }, "starting Atlantic Host control-plane");

  fs.mkdirSync(config.storageDir, { recursive: true });
  fs.mkdirSync(config.backupsDir, { recursive: true });

  runMigrations();
  seed();
  logger.info("database ready");

  registerJobHandlers();
  startQueueWorker();

  const app = createApp();
  const server = http.createServer(app);
  attachWebSocketServer(server);

  // Reconciliation loop: also enqueued as a job so it benefits from the same
  // single-flight/retry machinery, but scheduled directly here to guarantee
  // it runs even if the queue is backed up with other work.
  const reconcileTimer = setInterval(() => {
    runReconciliation().catch((err) => logger.error({ err: err.message }, "reconciliation loop failed"));
  }, config.reconcileIntervalMs);

  await new Promise((resolve) => server.listen(config.port, resolve));
  logger.info({ port: config.port }, "READY - control-plane listening");

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down gracefully");
    clearInterval(reconcileTimer);
    server.close();
    await stopQueueWorker();
    db.close();
    logger.info("shutdown complete");
    process.exit(0);
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (err) => {
    logger.error({ err: err?.message || err }, "unhandled promise rejection");
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("FATAL: control-plane failed to start:", err);
  process.exit(1);
});
