import { verifyAccessToken } from "../lib/authToken.js";
import { getUserById } from "../repositories/users.js";

// Attaches req.user when a valid bearer token is present. Also enforces
// token_version: bumping a user's token_version (done on block/unblock and
// password change) invalidates every previously-issued token immediately,
// without needing a server-side session/blacklist store.
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ error: "unauthorized", message: "Missing bearer token" });
  }
  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return res.status(401).json({ error: "unauthorized", message: "Invalid or expired token" });
  }
  const user = getUserById(payload.sub);
  if (!user) {
    return res.status(401).json({ error: "unauthorized", message: "User not found" });
  }
  if (user.token_version !== payload.tv) {
    return res.status(401).json({ error: "unauthorized", message: "Token revoked" });
  }
  if (user.status === "blocked") {
    return res.status(403).json({ error: "forbidden", message: "Account blocked" });
  }
  req.user = user;
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "forbidden", message: "Admin access required" });
  }
  next();
}
