import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { respondAgentError } from "../src/lib/agentError.js";

function fakeRes() {
  const res = {
    statusCode: null,
    jsonBody: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.jsonBody = body; return this; },
  };
  return res;
}

// Regression test for a real info-disclosure finding from a security pass:
// a file-manager request that legitimately failed on the node-agent side
// (ENOENT) returned the agent's raw absolute filesystem path
// (".../node-agent/data/volumes/<serverId>/...") straight to the client.
test("node-agent filesystem paths never reach the HTTP response", () => {
  const res = fakeRes();
  const err = new Error("ENOENT: no such file or directory, stat '/home/user/Mini/packages/node-agent/data/volumes/abc-123/secret-internal-path'");
  respondAgentError(res, err);
  assert.equal(res.statusCode, 503);
  assert.ok(!res.jsonBody.message.includes("/home/"), "response must not contain the internal filesystem path");
  assert.ok(!res.jsonBody.message.includes("volumes"), "response must not leak internal directory naming");
  assert.equal(res.jsonBody.message, "File or directory not found");
});

test("already-safe messages (no paths) are passed through unchanged", () => {
  const res = fakeRes();
  respondAgentError(res, new Error("path escapes the server directory"));
  assert.equal(res.jsonBody.message, "path escapes the server directory");
});

test("unrecognized errors fall back to a generic message, never the raw text", () => {
  const res = fakeRes();
  respondAgentError(res, new Error("some unexpected internal detail nobody should see"));
  assert.equal(res.jsonBody.message, "The operation could not be completed");
});
