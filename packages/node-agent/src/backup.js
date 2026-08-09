import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { config } from "./config.js";
import { volumePathFor } from "./docker.js";

const execFileAsync = promisify(execFile);

function backupPathFor(serverId, backupId) {
  return path.join(config.backupsRoot, serverId, `${backupId}.tar.gz`);
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

// Shells out to the system `tar` binary rather than pulling in a JS tar
// library: it's already present on every Linux host that can run Docker,
// streams well for large volumes, and its behavior (symlinks, sparse files,
// permissions) is battle-tested. Backup id is a server-generated UUID, never
// user input, so there is no argument-injection surface here.
export async function createBackup(serverId, backupId) {
  const volumePath = volumePathFor(serverId);
  const dest = backupPathFor(serverId, backupId);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.mkdir(volumePath, { recursive: true });

  await execFileAsync("tar", ["-czf", dest, "-C", volumePath, "."]);
  const stat = await fsp.stat(dest);
  const checksum = await sha256File(dest);
  return { storagePath: dest, sizeBytes: stat.size, checksum };
}

export async function restoreBackup(serverId, storagePath, expectedChecksum) {
  if (!fs.existsSync(storagePath)) {
    throw new Error(`backup file not found at ${storagePath}`);
  }
  if (expectedChecksum) {
    const actual = await sha256File(storagePath);
    if (actual !== expectedChecksum) {
      throw new Error("backup checksum mismatch — refusing to restore a possibly corrupted archive");
    }
  }
  const volumePath = volumePathFor(serverId);
  await fsp.mkdir(volumePath, { recursive: true });
  // Wipe the volume before restoring so a restore is a clean point-in-time
  // replace, not a merge that could leave stale files behind.
  const entries = await fsp.readdir(volumePath);
  await Promise.all(entries.map((e) => fsp.rm(path.join(volumePath, e), { recursive: true, force: true })));
  await execFileAsync("tar", ["-xzf", storagePath, "-C", volumePath]);
  return { restored: true };
}

export async function deleteBackupFile(storagePath) {
  await fsp.rm(storagePath, { force: true });
  return { deleted: true };
}
