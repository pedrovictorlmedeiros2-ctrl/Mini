import crypto from "node:crypto";
import { db } from "../db/index.js";

export function enqueueJob({ type, payload = {}, priority = 5, maxAttempts = 5, idempotencyKey = null, runAfter = null }) {
  if (idempotencyKey) {
    const existing = db.prepare("SELECT * FROM jobs WHERE idempotency_key = ?").get(idempotencyKey);
    if (existing) {
      // Only dedup against a job that's still meaningfully "in effect".
      // A job that already finished FAILED/CANCELLED is over — returning it
      // forever would make every future retry of the same action a silent
      // no-op (this bit a real DELETE_SERVER retry during testing). Free
      // the key so a fresh attempt can be inserted below.
      if (["QUEUED", "RUNNING", "SUCCEEDED"].includes(existing.status)) {
        return existing;
      }
      db.prepare("UPDATE jobs SET idempotency_key = NULL WHERE id = ?").run(existing.id);
    }
  }
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO jobs (id, type, payload_json, status, priority, max_attempts, idempotency_key, run_after)
    VALUES (?, ?, ?, 'QUEUED', ?, ?, ?, COALESCE(?, datetime('now')))
  `).run(id, type, JSON.stringify(payload), priority, maxAttempts, idempotencyKey, runAfter);
  return getJobById(id);
}

export function getJobById(id) {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
}

// Atomically claim up to `limit` queued jobs whose run_after has passed,
// ordered by priority. The UPDATE+RETURNING-via-select-then-CAS pattern
// below avoids two worker loops (or a worker + a retried request) both
// picking up the same job, since better-sqlite3 executes each prepared
// statement to completion before the next runs (single-writer semantics).
export function claimNextJobs(workerId, limit = 1) {
  const candidates = db.prepare(`
    SELECT id FROM jobs
    WHERE status = 'QUEUED' AND run_after <= datetime('now')
    ORDER BY priority ASC, created_at ASC
    LIMIT ?
  `).all(limit);

  const claimed = [];
  const claimStmt = db.prepare(`
    UPDATE jobs SET status = 'RUNNING', locked_by = ?, locked_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ? AND status = 'QUEUED'
  `);
  for (const c of candidates) {
    const res = claimStmt.run(workerId, c.id);
    if (res.changes === 1) claimed.push(getJobById(c.id));
  }
  return claimed;
}

export function completeJob(id) {
  db.prepare("UPDATE jobs SET status = 'SUCCEEDED', updated_at = datetime('now') WHERE id = ?").run(id);
}

export function failJob(id, error, { retry, backoffMs }) {
  const job = getJobById(id);
  if (!job) return;
  const attempts = job.attempts + 1;
  if (retry && attempts < job.max_attempts) {
    db.prepare(`
      UPDATE jobs SET status = 'QUEUED', attempts = ?, error = ?, locked_by = NULL, locked_at = NULL,
        run_after = datetime('now', '+' || ? || ' seconds'), updated_at = datetime('now')
      WHERE id = ?
    `).run(attempts, String(error).slice(0, 2000), Math.ceil(backoffMs / 1000), id);
  } else {
    db.prepare(`
      UPDATE jobs SET status = 'FAILED', attempts = ?, error = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(attempts, String(error).slice(0, 2000), id);
  }
}

// Jobs left RUNNING by a worker that crashed / was killed without finishing.
// Called at startup so no job is stuck forever.
export function requeueOrphanedJobs(olderThanMinutes = 5) {
  return db.prepare(`
    UPDATE jobs SET status = 'QUEUED', locked_by = NULL, locked_at = NULL, updated_at = datetime('now')
    WHERE status = 'RUNNING' AND locked_at < datetime('now', '-' || ? || ' minutes')
  `).run(olderThanMinutes).changes;
}

export function listJobs({ status = null, limit = 50, offset = 0 } = {}) {
  if (status) {
    return db.prepare("SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?").all(status, limit, offset);
  }
  return db.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset);
}

export function queueDepth() {
  return db.prepare("SELECT COUNT(*) AS c FROM jobs WHERE status IN ('QUEUED','RUNNING')").get().c;
}
