import Docker from "dockerode";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export const docker = new Docker({ socketPath: "/var/run/docker.sock" });

const MANAGED_LABEL = "atlantic.managed";
const SERVER_LABEL = "atlantic.serverId";

function containerName(slug) {
  return `atlantic-${slug}`;
}

export function volumePathFor(serverId) {
  return path.join(config.volumesRoot, serverId);
}

function ensureVolume(serverId) {
  const volPath = volumePathFor(serverId);
  fs.mkdirSync(volPath, { recursive: true });
  try {
    const [uid, gid] = config.containerUser.split(":").map(Number);
    fs.chownSync(volPath, uid, gid);
  } catch {
    // Not fatal (e.g. running as non-root on the host, or on a platform
    // without POSIX chown) — the container may still work depending on the
    // image's default user; logged upstream by the caller if it matters.
  }
  return volPath;
}

// Every container we create carries these labels so LIST_CONTAINERS /
// reconciliation and any destructive operation can be scoped to *only*
// containers Atlantic Host created — this agent must never touch unrelated
// containers that happen to run on the same Docker host.
export async function createContainer({ serverId, slug, image, startCommand, ramMb, cpuPercent, pidsLimit }) {
  const volPath = ensureVolume(serverId);

  await pullImageIfNeeded(image);

  const cmd = startCommand && startCommand.trim()
    ? ["sh", "-c", startCommand]
    : ["sh", "-c", "echo 'No start command configured yet. Upload your files and set one in the panel.' && sleep infinity"];

  const container = await docker.createContainer({
    name: containerName(slug),
    Image: image,
    Cmd: cmd,
    WorkingDir: "/home/container",
    User: config.containerUser,
    Env: ["HOME=/home/container"],
    Labels: { [MANAGED_LABEL]: "true", [SERVER_LABEL]: serverId },
    HostConfig: {
      Binds: [`${volPath}:/home/container`],
      Memory: ramMb * 1024 * 1024,
      MemorySwap: ramMb * 1024 * 1024, // = Memory -> disables swap usage beyond the RAM limit
      NanoCpus: Math.round((cpuPercent / 100) * 1e9),
      PidsLimit: pidsLimit,
      SecurityOpt: ["no-new-privileges"],
      CapDrop: ["ALL"],
      RestartPolicy: { Name: "no" }, // control-plane owns restart decisions, not Docker
      LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
    },
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });

  return { containerId: container.id, volumePath: volPath };
}

async function pullImageIfNeeded(image) {
  const images = await docker.listImages({ filters: { reference: [image] } });
  if (images.length > 0) return;
  await new Promise((resolve, reject) => {
    docker.pull(image, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (err2) => (err2 ? reject(err2) : resolve()));
    });
  });
}

async function getManagedContainer(containerId) {
  const container = docker.getContainer(containerId);
  const info = await container.inspect();
  if (info.Config?.Labels?.[MANAGED_LABEL] !== "true") {
    throw new Error(`refusing to operate on container ${containerId}: not managed by atlantic-host`);
  }
  return container;
}

export async function startContainer(containerId) {
  const container = await getManagedContainer(containerId);
  await container.start();
}

export async function stopContainer(containerId) {
  const container = await getManagedContainer(containerId);
  try {
    await container.stop({ t: 15 });
  } catch (err) {
    if (err.statusCode !== 304) throw err; // 304 = already stopped
  }
}

export async function restartContainer(containerId) {
  const container = await getManagedContainer(containerId);
  await container.restart({ t: 15 });
}

export async function deleteContainer(containerId) {
  let container;
  try {
    container = await getManagedContainer(containerId);
  } catch {
    return; // already gone / never existed — deletion is idempotent
  }
  try {
    await container.remove({ force: true, v: true });
  } catch (err) {
    if (err.statusCode !== 404) throw err;
  }
}

export async function listManagedContainers() {
  const list = await docker.listContainers({ all: true, filters: { label: [MANAGED_LABEL] } });
  return list.map((c) => ({
    containerId: c.Id,
    serverId: c.Labels?.[SERVER_LABEL] || null,
    running: c.State === "running",
    status: c.Status,
  }));
}

export async function getContainerStats(containerId) {
  const container = await getManagedContainer(containerId);
  const info = await container.inspect();
  if (!info.State.Running) {
    return { running: false };
  }
  const stats = await container.stats({ stream: false });
  const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
  const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
  const cpuCount = stats.cpu_stats.online_cpus || (stats.cpu_stats.cpu_usage.percpu_usage || []).length || 1;
  const cpuPercent = systemDelta > 0 && cpuDelta > 0 ? (cpuDelta / systemDelta) * cpuCount * 100 : 0;
  const memUsage = stats.memory_stats.usage || 0;
  const memLimit = stats.memory_stats.limit || 1;
  return {
    running: true,
    cpuPercent: Math.round(cpuPercent * 10) / 10,
    memoryUsedMb: Math.round(memUsage / 1024 / 1024),
    memoryLimitMb: Math.round(memLimit / 1024 / 1024),
    pids: stats.pids_stats?.current || 0,
  };
}
