import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { DEFAULT_PLANS } from "@atlantic/shared";
import { db } from "./index.js";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";

export function seed() {
  const planCount = db.prepare("SELECT COUNT(*) AS c FROM plans").get().c;
  if (planCount === 0) {
    const insert = db.prepare(`
      INSERT INTO plans (id, slug, name, ram_mb, cpu_percent, disk_mb, pids_limit, max_servers, max_backups, price_cents, currency, active)
      VALUES (@id, @slug, @name, @ram_mb, @cpu_percent, @disk_mb, @pids_limit, @max_servers, @max_backups, @price_cents, @currency, @active)
    `);
    const tx = db.transaction((plans) => {
      for (const p of plans) insert.run({ id: crypto.randomUUID(), ...p });
    });
    tx(DEFAULT_PLANS);
    logger.info({ count: DEFAULT_PLANS.length }, "seeded default plans");
  }

  if (config.adminEmail && config.adminPassword) {
    const existing = db
      .prepare("SELECT id FROM users WHERE email = ?")
      .get(config.adminEmail.toLowerCase());
    if (!existing) {
      const hash = bcrypt.hashSync(config.adminPassword, 12);
      db.prepare(`
        INSERT INTO users (id, email, password_hash, name, role, status)
        VALUES (?, ?, ?, ?, 'admin', 'active')
      `).run(crypto.randomUUID(), config.adminEmail.toLowerCase(), hash, "Administrator");
      logger.info({ email: config.adminEmail }, "seeded initial admin user");
    }
  }
}
