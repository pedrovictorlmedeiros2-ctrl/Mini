import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runMigrations } from "../src/db/index.js";
import { enqueueJob, claimNextJobs, failJob, completeJob, getJobById } from "../src/repositories/jobs.js";

runMigrations();

test("enqueueJob dedups an in-flight job by idempotency key", () => {
  const a = enqueueJob({ type: "START_SERVER", payload: { serverId: "s1" }, idempotencyKey: "start:s1" });
  const b = enqueueJob({ type: "START_SERVER", payload: { serverId: "s1" }, idempotencyKey: "start:s1" });
  assert.equal(a.id, b.id, "second call should return the same still-queued job");
});

test("a terminally FAILED job frees its idempotency key so a fresh retry can be enqueued", () => {
  // priority 0 (most urgent) so this job is claimed first regardless of any
  // leftover never-claimed QUEUED job from an earlier test in this file.
  const first = enqueueJob({ type: "DELETE_SERVER", payload: { serverId: "s2" }, idempotencyKey: "delete:s2", maxAttempts: 1, priority: 0 });
  const [claimed] = claimNextJobs("test-worker", 1);
  assert.equal(claimed.id, first.id);
  // maxAttempts=1 means this single failure is terminal (attempts becomes 1, 1 < 1 is false).
  failJob(claimed.id, "boom", { retry: true, backoffMs: 0 });
  const afterFail = getJobById(first.id);
  assert.equal(afterFail.status, "FAILED");

  // A regression here previously made this return the dead FAILED job
  // forever, silently no-op'ing every future retry of the same action.
  const retry = enqueueJob({ type: "DELETE_SERVER", payload: { serverId: "s2" }, idempotencyKey: "delete:s2" });
  assert.notEqual(retry.id, first.id, "retry after terminal failure must create a NEW job");
  assert.equal(retry.status, "QUEUED");
});

test("enqueueJob dedups against a SUCCEEDED job (still returns the completed one, no duplicate work)", () => {
  const job = enqueueJob({ type: "BACKUP_SERVER", payload: {}, idempotencyKey: "backup:once" });
  completeJob(job.id);
  const again = enqueueJob({ type: "BACKUP_SERVER", payload: {}, idempotencyKey: "backup:once" });
  assert.equal(again.id, job.id);
  assert.equal(again.status, "SUCCEEDED");
});

test("claimNextJobs only claims QUEUED jobs whose run_after has passed, ordered by priority", () => {
  enqueueJob({ type: "RECONCILE", payload: {}, priority: 9 });
  const urgent = enqueueJob({ type: "RECONCILE", payload: {}, priority: 1 });
  const future = enqueueJob({ type: "RECONCILE", payload: {}, runAfter: "2999-01-01 00:00:00" });

  const claimed = claimNextJobs("test-worker-2", 10);
  const claimedIds = claimed.map((j) => j.id);
  assert.ok(claimedIds.includes(urgent.id));
  assert.ok(!claimedIds.includes(future.id), "future-scheduled job must not be claimed yet");
  assert.equal(claimed[0].id, urgent.id, "highest priority (lowest number) claimed first");
});
