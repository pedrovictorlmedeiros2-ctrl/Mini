import crypto from "node:crypto";
import { config } from "../config.js";

// AES-256-GCM at rest for environment variable values (they routinely hold
// bot tokens / API keys). The key is derived from ENCRYPTION_KEY via SHA-256
// so operators can supply any passphrase length.
const key = crypto.createHash("sha256").update(config.encryptionKey).digest();

export function encryptSecret(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

export function decryptSecret(payload) {
  const raw = Buffer.from(payload, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function maskSecret(value) {
  if (!value) return "";
  if (value.length <= 4) return "****";
  return `${value.slice(0, 2)}${"*".repeat(Math.min(value.length - 4, 20))}${value.slice(-2)}`;
}

export function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
