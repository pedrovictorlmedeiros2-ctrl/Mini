import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { canTransition, ServerStatus } from "@atlantic/shared";

test("valid lifecycle transitions are allowed", () => {
  assert.equal(canTransition(ServerStatus.STOPPED, ServerStatus.STARTING), true);
  assert.equal(canTransition(ServerStatus.STARTING, ServerStatus.RUNNING), true);
  assert.equal(canTransition(ServerStatus.RUNNING, ServerStatus.STOPPING), true);
  assert.equal(canTransition(ServerStatus.STOPPING, ServerStatus.STOPPED), true);
});

test("impossible transitions are rejected", () => {
  assert.equal(canTransition(ServerStatus.STOPPED, ServerStatus.RUNNING), false, "cannot skip STARTING");
  assert.equal(canTransition(ServerStatus.DELETED, ServerStatus.RUNNING), false, "DELETED is terminal");
  assert.equal(canTransition(ServerStatus.CREATING, ServerStatus.RUNNING), false, "must install first");
});

test("force-delete from an active state is allowed (agent force-stops the container)", () => {
  assert.equal(canTransition(ServerStatus.RUNNING, ServerStatus.DELETING), true);
  assert.equal(canTransition(ServerStatus.STARTING, ServerStatus.DELETING), true);
});

test("unknown source state has no allowed transitions", () => {
  assert.equal(canTransition("NOT_A_REAL_STATE", ServerStatus.RUNNING), false);
});
