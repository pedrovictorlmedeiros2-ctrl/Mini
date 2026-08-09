import fs from "node:fs";
import path from "node:path";

export class UnsafePathError extends Error {
  constructor(msg) {
    super(msg);
    this.retryable = false;
  }
}

// Authoritative path safety check — this is the module that actually touches
// disk, so it cannot trust the control-plane's pre-check alone. Resolves the
// requested path against the server's volume root and rejects anything that
// escapes it, including via a symlink planted by the (untrusted) contents of
// the volume itself.
export function resolveSafePath(volumeRoot, relPath) {
  if (typeof relPath !== "string" || relPath.includes("\0")) {
    throw new UnsafePathError("invalid path");
  }
  const normalizedRoot = fs.realpathSync(volumeRoot);
  const cleaned = relPath === "." || relPath === "" ? "." : relPath.replace(/\\/g, "/");
  const normalized = path.posix.normalize(cleaned);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new UnsafePathError("path escapes the server directory");
  }
  const target = path.join(normalizedRoot, normalized);
  if (target !== normalizedRoot && !target.startsWith(normalizedRoot + path.sep)) {
    throw new UnsafePathError("path escapes the server directory");
  }

  // Walk up from the target to the nearest existing ancestor and realpath
  // it, so a symlink somewhere in the middle of the tree (e.g. a directory
  // the app itself created pointing at /etc) can't smuggle us outside root.
  let probe = target;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const realProbe = fs.realpathSync(probe);
  if (realProbe !== normalizedRoot && !realProbe.startsWith(normalizedRoot + path.sep)) {
    throw new UnsafePathError("path escapes the server directory via symlink");
  }

  return target;
}
