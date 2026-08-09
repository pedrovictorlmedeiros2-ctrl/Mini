import crypto from "node:crypto";
import { db } from "../db/index.js";
import { encryptSecret, decryptSecret, maskSecret } from "../lib/crypto.js";

const SECRET_KEY_HINTS = ["token", "secret", "password", "key", "credential"];

function looksSecret(key) {
  const lower = key.toLowerCase();
  return SECRET_KEY_HINTS.some((hint) => lower.includes(hint));
}

export function upsertEnvVar(serverId, key, value) {
  const isSecret = looksSecret(key) ? 1 : 0;
  const encrypted = encryptSecret(value);
  const existing = db.prepare("SELECT id FROM env_vars WHERE server_id = ? AND key = ?").get(serverId, key);
  if (existing) {
    db.prepare("UPDATE env_vars SET value_encrypted = ?, is_secret = ?, updated_at = datetime('now') WHERE id = ?")
      .run(encrypted, isSecret, existing.id);
    return existing.id;
  }
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO env_vars (id, server_id, key, value_encrypted, is_secret) VALUES (?, ?, ?, ?, ?)")
    .run(id, serverId, key, encrypted, isSecret);
  return id;
}

export function deleteEnvVar(serverId, key) {
  db.prepare("DELETE FROM env_vars WHERE server_id = ? AND key = ?").run(serverId, key);
}

// For the panel: never return raw secret values, only masked previews.
export function listEnvVarsMasked(serverId) {
  const rows = db.prepare("SELECT key, value_encrypted, is_secret FROM env_vars WHERE server_id = ? ORDER BY key").all(serverId);
  return rows.map((r) => {
    const plain = decryptSecret(r.value_encrypted);
    return { key: r.key, isSecret: !!r.is_secret, value: r.is_secret ? maskSecret(plain) : plain };
  });
}

// For the node-agent / container runtime only: real values to inject into
// the container's environment. Never expose this over an HTTP route that a
// browser client can reach directly.
export function listEnvVarsPlain(serverId) {
  const rows = db.prepare("SELECT key, value_encrypted FROM env_vars WHERE server_id = ?").all(serverId);
  const out = {};
  for (const r of rows) out[r.key] = decryptSecret(r.value_encrypted);
  return out;
}
