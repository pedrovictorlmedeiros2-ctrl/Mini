import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { createUser, getUserByEmail, bumpTokenVersion } from "../repositories/users.js";
import { signAccessToken } from "../lib/authToken.js";
import { requireAuth } from "../middleware/auth.js";
import { authLimiter } from "../middleware/rateLimit.js";
import { validateBody } from "../middleware/validate.js";
import { recordAudit } from "../repositories/auditLog.js";
import { AuditEvent } from "@atlantic/shared";

export const authRouter = Router();

const registerSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
  name: z.string().min(2).max(100),
});

const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(128),
});

function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name, role: user.role, status: user.status };
}

authRouter.post("/register", authLimiter, validateBody(registerSchema), (req, res) => {
  const { email, password, name } = req.body;
  if (getUserByEmail(email)) {
    return res.status(409).json({ error: "conflict", message: "Email already registered" });
  }
  const passwordHash = bcrypt.hashSync(password, 12);
  const user = createUser({ email, passwordHash, name });
  recordAudit({ actorUserId: user.id, event: AuditEvent.USER_CREATED, targetType: "user", targetId: user.id, ip: req.ip });
  const token = signAccessToken(user);
  res.status(201).json({ token, user: publicUser(user) });
});

authRouter.post("/login", authLimiter, validateBody(loginSchema), (req, res) => {
  const { email, password } = req.body;
  const user = getUserByEmail(email);
  // Constant-shape response whether the user exists or not, to avoid
  // account enumeration via timing/response differences.
  const hash = user?.password_hash || "$2a$12$invalidsaltinvalidsaltinvalidsal.invalidhashabcdefghijk";
  const valid = bcrypt.compareSync(password, hash) && !!user;
  if (!valid) {
    recordAudit({ event: AuditEvent.USER_LOGIN_FAILED, targetType: "user", targetId: user?.id || null, metadata: { email }, ip: req.ip });
    return res.status(401).json({ error: "unauthorized", message: "Invalid credentials" });
  }
  if (user.status === "blocked") {
    return res.status(403).json({ error: "forbidden", message: "Account blocked" });
  }
  const token = signAccessToken(user);
  recordAudit({ actorUserId: user.id, event: user.role === "admin" ? AuditEvent.ADMIN_LOGIN : AuditEvent.USER_LOGIN, targetType: "user", targetId: user.id, ip: req.ip });
  res.json({ token, user: publicUser(user) });
});

authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

authRouter.post("/logout-all", requireAuth, (req, res) => {
  // Bumping token_version invalidates every JWT issued so far for this user.
  bumpTokenVersion(req.user.id);
  res.json({ ok: true });
});
