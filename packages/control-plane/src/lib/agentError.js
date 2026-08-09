import { logger } from "./logger.js";

// Errors bubbling up from a node-agent RPC call (sendCommand rejections)
// routinely contain the agent's own local filesystem paths (e.g. ENOENT on
// /home/.../data/volumes/<serverId>/...). That's useful for debugging but
// is internal infrastructure detail an authenticated tenant has no business
// seeing in a JSON response -- a real info-disclosure finding from a
// security pass (an attacker could map out the node's directory layout
// just by probing file-manager error responses). The real error is always
// logged server-side; the client gets a safe, still-useful classification
// instead of the raw message, regardless of environment -- unlike generic
// unexpected-bug errors, these are routine operational failures that show
// up in normal use, not just during development.
const PATTERNS = [
  [/ENOENT/i, "File or directory not found"],
  [/EACCES|permission denied/i, "Permission denied"],
  [/escapes the server directory/i, null], // already a safe, path-free message -- pass through verbatim
  [/not managed by atlantic-host/i, "Server is not ready yet"],
  [/timed out/i, "The server took too long to respond"],
  [/is not connected/i, "The hosting node is currently offline"],
  [/exceeds the .* byte/i, null], // already safe (size-limit message, no paths)
];

function classify(message) {
  for (const [pattern, replacement] of PATTERNS) {
    if (pattern.test(message)) return replacement === null ? message : replacement;
  }
  return "The operation could not be completed";
}

export function respondAgentError(res, err, context = {}) {
  logger.warn({ ...context, err: err.message }, "node-agent command failed");
  res.status(503).json({ error: "unavailable", message: classify(err.message || "") });
}
