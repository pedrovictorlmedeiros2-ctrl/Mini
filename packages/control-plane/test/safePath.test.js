import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { isSafeRelativePath } from "../src/lib/safePath.js";

test("accepts normal relative paths", () => {
  assert.equal(isSafeRelativePath("."), true);
  assert.equal(isSafeRelativePath("index.js"), true);
  assert.equal(isSafeRelativePath("src/commands/ping.js"), true);
});

test("rejects path traversal attempts", () => {
  assert.equal(isSafeRelativePath("../etc/passwd"), false);
  assert.equal(isSafeRelativePath("../../etc/passwd"), false);
  assert.equal(isSafeRelativePath("src/../../etc/passwd"), false);
  assert.equal(isSafeRelativePath("a/b/../../../etc/passwd"), false);
});

test("rejects absolute paths and null bytes", () => {
  assert.equal(isSafeRelativePath("/etc/passwd"), false);
  assert.equal(isSafeRelativePath("index.js\0.txt"), false);
});

test("rejects non-string input", () => {
  assert.equal(isSafeRelativePath(undefined), false);
  assert.equal(isSafeRelativePath(null), false);
  assert.equal(isSafeRelativePath(42), false);
});
