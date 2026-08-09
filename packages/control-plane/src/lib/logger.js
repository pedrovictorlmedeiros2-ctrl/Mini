// Minimal structured JSON logger. No external dependency needed for this:
// every line is a single JSON object with ts/level/msg + context fields,
// which is enough to be greppable and safe to ship to any log aggregator.
// IMPORTANT: never pass secrets (tokens, passwords, env var values) as
// context fields — callers are responsible for redacting before logging.

const REDACT_KEYS = new Set([
  "password",
  "password_hash",
  "token",
  "secret",
  "authorization",
  "jwt",
  "agent_token",
]);

function redact(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (REDACT_KEYS.has(k.toLowerCase())) {
      out[k] = "[REDACTED]";
    } else if (v && typeof v === "object") {
      out[k] = redact(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function emit(level, ctxOrMsg, maybeMsg) {
  const hasCtx = typeof ctxOrMsg === "object" && ctxOrMsg !== null;
  const ctx = hasCtx ? redact(ctxOrMsg) : undefined;
  const msg = hasCtx ? maybeMsg : ctxOrMsg;
  const line = { ts: new Date().toISOString(), level, msg, ...(ctx || {}) };
  const out = level === "error" ? console.error : console.log;
  out(JSON.stringify(line));
}

export const logger = {
  info: (ctxOrMsg, maybeMsg) => emit("info", ctxOrMsg, maybeMsg),
  warn: (ctxOrMsg, maybeMsg) => emit("warn", ctxOrMsg, maybeMsg),
  error: (ctxOrMsg, maybeMsg) => emit("error", ctxOrMsg, maybeMsg),
  debug: (ctxOrMsg, maybeMsg) => {
    if (process.env.LOG_LEVEL === "debug") emit("debug", ctxOrMsg, maybeMsg);
  },
};
