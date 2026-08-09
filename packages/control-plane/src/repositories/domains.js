import crypto from "node:crypto";
import { db } from "../db/index.js";

export function createDomain(serverId, hostname) {
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(16).toString("hex");
  db.prepare(`
    INSERT INTO domains (id, server_id, hostname, ssl_status, verified, verification_token)
    VALUES (?, ?, ?, 'PENDING', 0, ?)
  `).run(id, serverId, hostname.toLowerCase(), token);
  return getDomainById(id);
}

export function getDomainById(id) {
  return db.prepare("SELECT * FROM domains WHERE id = ?").get(id);
}

export function getDomainByHostname(hostname) {
  return db.prepare("SELECT * FROM domains WHERE hostname = ?").get(hostname.toLowerCase());
}

export function listDomainsByServer(serverId) {
  return db.prepare("SELECT * FROM domains WHERE server_id = ?").all(serverId);
}

export function deleteDomain(id) {
  db.prepare("DELETE FROM domains WHERE id = ?").run(id);
}

export function markVerified(id) {
  db.prepare("UPDATE domains SET verified = 1 WHERE id = ?").run(id);
  return getDomainById(id);
}
