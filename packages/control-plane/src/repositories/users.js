import crypto from "node:crypto";
import { db } from "../db/index.js";

export function createUser({ email, passwordHash, name }) {
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO users (id, email, password_hash, name)
    VALUES (?, ?, ?, ?)
  `).run(id, email.toLowerCase(), passwordHash, name);
  return getUserById(id);
}

export function getUserByEmail(email) {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase());
}

export function getUserById(id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}

export function listUsers({ limit = 50, offset = 0, q = "" } = {}) {
  const like = `%${q}%`;
  const rows = db.prepare(`
    SELECT id, email, name, role, status, created_at FROM users
    WHERE email LIKE ? OR name LIKE ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(like, like, limit, offset);
  const total = db.prepare(`
    SELECT COUNT(*) AS c FROM users WHERE email LIKE ? OR name LIKE ?
  `).get(like, like).c;
  return { rows, total };
}

export function setUserStatus(id, status) {
  db.prepare("UPDATE users SET status = ?, token_version = token_version + 1, updated_at = datetime('now') WHERE id = ?")
    .run(status, id);
  return getUserById(id);
}

export function setUserRole(id, role) {
  db.prepare("UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?").run(role, id);
  return getUserById(id);
}

export function bumpTokenVersion(id) {
  db.prepare("UPDATE users SET token_version = token_version + 1 WHERE id = ?").run(id);
}
