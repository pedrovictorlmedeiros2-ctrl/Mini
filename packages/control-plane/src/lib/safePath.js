import path from "node:path";

// Defense-in-depth check before we even send a file-manager request to a
// node-agent: reject anything that isn't a clean relative path inside the
// server's own volume root. The node-agent re-validates authoritatively
// (it's the one that actually touches the filesystem), but rejecting
// obviously-malicious paths here means bad input never leaves the API layer.
export function isSafeRelativePath(input) {
  if (typeof input !== "string" || input.length === 0) return false;
  if (input.includes("\0")) return false;
  const normalized = path.posix.normalize(input.replace(/\\/g, "/"));
  if (normalized.startsWith("..") || normalized.startsWith("/")) return false;
  if (normalized.split("/").includes("..")) return false;
  return true;
}
