import crypto from "node:crypto";
import { db } from "../db/index.js";

export function listPlans({ activeOnly = true } = {}) {
  if (activeOnly) {
    return db.prepare("SELECT * FROM plans WHERE active = 1 ORDER BY price_cents ASC").all();
  }
  return db.prepare("SELECT * FROM plans ORDER BY price_cents ASC").all();
}

export function getPlanById(id) {
  return db.prepare("SELECT * FROM plans WHERE id = ?").get(id);
}

export function getPlanBySlug(slug) {
  return db.prepare("SELECT * FROM plans WHERE slug = ?").get(slug);
}

export function createPlan(data) {
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO plans (id, slug, name, ram_mb, cpu_percent, disk_mb, pids_limit, max_servers, max_backups, price_cents, currency, active)
    VALUES (@id, @slug, @name, @ram_mb, @cpu_percent, @disk_mb, @pids_limit, @max_servers, @max_backups, @price_cents, @currency, @active)
  `).run({ id, active: 1, currency: "BRL", pids_limit: 256, max_backups: 3, ...data });
  return getPlanById(id);
}

export function updatePlan(id, data) {
  const current = getPlanById(id);
  if (!current) return null;
  const merged = { ...current, ...data };
  db.prepare(`
    UPDATE plans SET name=@name, ram_mb=@ram_mb, cpu_percent=@cpu_percent, disk_mb=@disk_mb,
      pids_limit=@pids_limit, max_servers=@max_servers, max_backups=@max_backups,
      price_cents=@price_cents, currency=@currency, active=@active, updated_at=datetime('now')
    WHERE id=@id
  `).run(merged);
  return getPlanById(id);
}
