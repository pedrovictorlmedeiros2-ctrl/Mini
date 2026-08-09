import { docker } from "./docker.js";

// serverId -> { stream, destroy }
const active = new Map();

export async function watchLogs(serverId, containerId, onLine) {
  // Always (re)attach fresh rather than no-op'ing when an entry already
  // exists: Docker's log-follow stream on a stopped container ends on its
  // own once there's nothing left to read, so a stale bookkeeping entry
  // must not block a legitimate re-watch after the container starts again.
  unwatchLogs(serverId);
  const container = docker.getContainer(containerId);
  const stream = await container.logs({ follow: true, stdout: true, stderr: true, tail: 100 });

  // Docker multiplexes stdout/stderr with an 8-byte frame header per chunk
  // when the container wasn't created with a TTY; demux it into plain lines.
  let buffer = Buffer.alloc(0);
  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 8) {
      const size = buffer.readUInt32BE(4);
      if (buffer.length < 8 + size) break;
      const payload = buffer.subarray(8, 8 + size).toString("utf8");
      buffer = buffer.subarray(8 + size);
      for (const line of payload.split("\n")) {
        if (line.length > 0) onLine(line);
      }
    }
  };
  stream.on("data", onData);
  stream.on("error", () => active.delete(serverId));
  stream.on("end", () => active.delete(serverId));
  active.set(serverId, { stream });
}

export function unwatchLogs(serverId) {
  const entry = active.get(serverId);
  if (!entry) return;
  try {
    entry.stream.destroy();
  } catch {
    // stream may already be closed
  }
  active.delete(serverId);
}

export function unwatchAll() {
  for (const serverId of [...active.keys()]) unwatchLogs(serverId);
}
