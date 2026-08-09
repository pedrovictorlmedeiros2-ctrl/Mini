import os from "node:os";
import crypto from "node:crypto";
import { enqueueJob, claimNextJobs, completeJob, failJob, requeueOrphanedJobs, queueDepth } from "../repositories/jobs.js";
import { logger } from "../lib/logger.js";
import { config } from "../config.js";

const handlers = new Map();
const workerId = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;

export function registerHandler(type, handler) {
  handlers.set(type, handler);
}

export function enqueue(type, payload, opts = {}) {
  if (!handlers.has(type)) {
    throw new Error(`no handler registered for job type ${type}`);
  }
  return enqueueJob({ type, payload, ...opts });
}

let running = false;
let inFlight = 0;
let loopTimer = null;
let shuttingDown = false;

function backoffForAttempt(attempt) {
  // Exponential backoff with a cap, so a job failing repeatedly doesn't hot
  // loop the worker or hammer a struggling downstream (e.g. an offline node).
  return Math.min(60_000, 1000 * 2 ** attempt);
}

async function runOne(job) {
  inFlight++;
  const handler = handlers.get(job.type);
  try {
    let payload;
    try {
      payload = JSON.parse(job.payload_json);
    } catch {
      payload = {};
    }
    await handler(payload, job);
    completeJob(job.id);
  } catch (err) {
    logger.error({ jobId: job.id, type: job.type, err: err.message }, "job failed");
    const retry = err.retryable !== false;
    failJob(job.id, err.message || String(err), { retry, backoffMs: backoffForAttempt(job.attempts) });
  } finally {
    inFlight--;
  }
}

async function tick() {
  if (shuttingDown) return;
  const capacity = config.queueConcurrency - inFlight;
  if (capacity > 0) {
    const jobs = claimNextJobs(workerId, capacity);
    for (const job of jobs) {
      // fire and forget; each call tracks its own inFlight slot
      runOne(job);
    }
  }
  loopTimer = setTimeout(tick, 500);
}

export function startQueueWorker() {
  if (running) return;
  running = true;
  const requeued = requeueOrphanedJobs(5);
  if (requeued > 0) logger.warn({ requeued }, "requeued orphaned jobs from a previous process");
  tick();
  logger.info({ workerId, concurrency: config.queueConcurrency }, "queue worker started");
}

export async function stopQueueWorker() {
  shuttingDown = true;
  if (loopTimer) clearTimeout(loopTimer);
  const deadline = Date.now() + 15_000;
  while (inFlight > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  logger.info({ remainingInFlight: inFlight }, "queue worker stopped");
}

export function getQueueStats() {
  return { depth: queueDepth(), inFlight, workerId };
}
