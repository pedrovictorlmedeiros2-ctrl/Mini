// Single source of truth for default plan definitions. These are seeded into
// the `plans` table on first boot; after that the DATABASE is authoritative
// (admins can edit plans at runtime). Nothing in the codebase should hardcode
// resource numbers outside of this seed + the plans table.
//
// ram_mb: hard memory limit applied to the container (Docker --memory)
// cpu_percent: 100 = 1 full vCPU (converted to Docker --cpus = cpu_percent/100)
// disk_mb: soft quota enforced by the node-agent disk-usage checker
// max_servers: how many hostings this plan allows per purchase
// max_backups: retention count for automatic backup cleanup

export const DEFAULT_PLANS = [
  {
    slug: "starter",
    name: "Starter",
    ram_mb: 512,
    cpu_percent: 50,
    disk_mb: 2048,
    pids_limit: 128,
    max_servers: 1,
    max_backups: 3,
    price_cents: 990,
    currency: "BRL",
    active: 1,
  },
  {
    slug: "basic",
    name: "Basic",
    ram_mb: 1024,
    cpu_percent: 100,
    disk_mb: 5120,
    pids_limit: 256,
    max_servers: 2,
    max_backups: 5,
    price_cents: 1990,
    currency: "BRL",
    active: 1,
  },
  {
    slug: "pro",
    name: "Pro",
    ram_mb: 4096,
    cpu_percent: 200,
    disk_mb: 20480,
    pids_limit: 512,
    max_servers: 5,
    max_backups: 10,
    price_cents: 4990,
    currency: "BRL",
    active: 1,
  },
  {
    slug: "business",
    name: "Business",
    ram_mb: 8192,
    cpu_percent: 400,
    disk_mb: 51200,
    pids_limit: 1024,
    max_servers: 10,
    max_backups: 20,
    price_cents: 9990,
    currency: "BRL",
    active: 1,
  },
];

// Global safety ceilings, independent of any single plan. No container may
// ever exceed these even if a plan is misconfigured by an admin.
export const RESOURCE_HARD_CAPS = Object.freeze({
  maxRamMb: 16384,
  maxCpuPercent: 800,
  maxDiskMb: 102400,
  maxPidsLimit: 2048,
});
