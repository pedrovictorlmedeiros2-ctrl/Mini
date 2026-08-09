import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { volumePathFor } from "./docker.js";
import { resolveSafePath } from "./lib/safePath.js";

function ensureRoot(serverId) {
  const root = volumePathFor(serverId);
  fsSync.mkdirSync(root, { recursive: true });
  return root;
}

export async function listFiles(serverId, relPath) {
  const root = ensureRoot(serverId);
  const target = resolveSafePath(root, relPath || ".");
  const stat = await fs.stat(target);
  if (!stat.isDirectory()) {
    throw new Error("path is not a directory");
  }
  const entries = await fs.readdir(target, { withFileTypes: true });
  const items = await Promise.all(
    entries.map(async (e) => {
      const full = path.join(target, e.name);
      let size = 0;
      let isDir = e.isDirectory();
      try {
        const s = await fs.lstat(full);
        // Report symlinks as their own type rather than following them —
        // following would need another safety check and isn't needed for a
        // directory listing.
        isDir = s.isDirectory();
        size = s.size;
      } catch {
        // race: entry removed between readdir and lstat; skip size/type
      }
      return { name: e.name, isDirectory: isDir, isSymlink: e.isSymbolicLink(), size };
    })
  );
  items.sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));
  return { path: relPath || ".", entries: items };
}

export async function readFile(serverId, relPath, maxBytes) {
  const root = ensureRoot(serverId);
  const target = resolveSafePath(root, relPath);
  const stat = await fs.stat(target);
  if (stat.isDirectory()) throw new Error("cannot read a directory as a file");
  if (stat.size > maxBytes) {
    throw new Error(`file is ${stat.size} bytes, exceeds the ${maxBytes} byte inline-read limit`);
  }
  const content = await fs.readFile(target, "utf8");
  return { path: relPath, content, size: stat.size };
}

export async function writeFile(serverId, relPath, content) {
  const root = ensureRoot(serverId);
  const target = resolveSafePath(root, relPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
  return { path: relPath, size: Buffer.byteLength(content, "utf8") };
}

export async function deleteFile(serverId, relPath) {
  const root = ensureRoot(serverId);
  const target = resolveSafePath(root, relPath);
  if (target === root) throw new Error("cannot delete the server's root directory");
  await fs.rm(target, { recursive: true, force: true });
  return { path: relPath };
}

export async function renameFile(serverId, fromRel, toRel) {
  const root = ensureRoot(serverId);
  const from = resolveSafePath(root, fromRel);
  // The destination need not exist yet, but its parent must already be
  // inside the root — resolveSafePath's ancestor-walk handles that even
  // when `to` itself is new.
  const to = resolveSafePath(root, toRel);
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.rename(from, to);
  return { from: fromRel, to: toRel };
}

export async function mkdir(serverId, relPath) {
  const root = ensureRoot(serverId);
  const target = resolveSafePath(root, relPath);
  await fs.mkdir(target, { recursive: true });
  return { path: relPath };
}
