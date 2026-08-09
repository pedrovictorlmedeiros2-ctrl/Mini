import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";

const execFileAsync = promisify(execFile);

export function totalRamMb() {
  return Math.floor(os.totalmem() / 1024 / 1024);
}

export function totalCpuPercent() {
  // 1 core = 100%, matching the plan.cpu_percent convention used everywhere
  // else in the system (see @atlantic/shared plans.js).
  return os.cpus().length * 100;
}

export async function totalDiskMb() {
  try {
    const { stdout } = await execFileAsync("df", ["-Pk", config.volumesRoot]);
    const lines = stdout.trim().split("\n");
    const cols = lines[lines.length - 1].split(/\s+/);
    const totalKb = Number(cols[1]);
    return Math.floor(totalKb / 1024);
  } catch {
    return 0;
  }
}
