import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSafePath, UnsafePathError } from "../src/lib/safePath.js";

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "atlantic-agent-test-"));
}

test("resolves normal paths inside the root", () => {
  const root = makeRoot();
  const resolved = resolveSafePath(root, "index.js");
  assert.equal(resolved, path.join(fs.realpathSync(root), "index.js"));
});

test("rejects traversal outside the root", () => {
  const root = makeRoot();
  assert.throws(() => resolveSafePath(root, "../../../etc/passwd"), UnsafePathError);
});

test("rejects a symlink planted inside the volume that points outside it", () => {
  const root = makeRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "atlantic-outside-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "should not be readable");
  fs.symlinkSync(outside, path.join(root, "escape"));

  assert.throws(() => resolveSafePath(root, "escape/secret.txt"), UnsafePathError);
});

test("allows a path whose final component does not exist yet (for writes)", () => {
  const root = makeRoot();
  const resolved = resolveSafePath(root, "new-folder/new-file.txt");
  assert.equal(resolved, path.join(fs.realpathSync(root), "new-folder/new-file.txt"));
});
