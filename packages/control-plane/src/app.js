import express from "express";
import cors from "cors";
import helmet from "helmet";
import { config } from "./config.js";
import { authRouter } from "./routes/auth.js";
import { plansRouter } from "./routes/plans.js";
import { ordersRouter } from "./routes/orders.js";
import { paymentsRouter } from "./routes/payments.js";
import { serversRouter } from "./routes/servers.js";
import { filesRouter } from "./routes/files.js";
import { nodesRouter } from "./routes/nodes.js";
import { adminRouter } from "./routes/admin.js";
import { requireAuth } from "./middleware/auth.js";
import { apiLimiter } from "./middleware/rateLimit.js";
import { logger } from "./lib/logger.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: config.corsOrigin, credentials: true }));

  // Payments webhook needs the raw body for signature verification, so it
  // is mounted BEFORE the global json() body parser.
  app.use("/api/payments", paymentsRouter);

  app.use(express.json({ limit: "1mb" }));
  app.use(apiLimiter);

  app.get("/health", (req, res) => res.json({ ok: true, env: config.env }));

  app.use("/api/auth", authRouter);
  app.use("/api/plans", plansRouter);
  app.use("/api/orders", ordersRouter);
  app.use("/api/servers", serversRouter);
  app.use("/api/servers/:id/files", requireAuth, filesRouter);
  app.use("/api/admin/nodes", nodesRouter);
  app.use("/api/admin", adminRouter);

  app.use((req, res) => {
    res.status(404).json({ error: "not_found", message: "Unknown route" });
  });

  // Centralized error handler: never leak stack traces / internals to the
  // client, but log the full error server-side.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logger.error({ err: err.message, stack: err.stack, path: req.path }, "unhandled request error");
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ error: "internal_error", message: config.env === "production" ? "Something went wrong" : err.message });
  });

  return app;
}
