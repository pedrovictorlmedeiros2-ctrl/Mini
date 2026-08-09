import rateLimit from "express-rate-limit";

// Keyed by IP + (when authenticated) user id, so one abusive account can't
// hide behind NAT and starve other tenants sharing the same IP.
function keyGenerator(req) {
  return req.user?.id ? `u:${req.user.id}` : req.ip;
}

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  message: { error: "rate_limited", message: "Too many attempts, try again later" },
});

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  message: { error: "rate_limited", message: "Too many requests" },
});

export const heavyOpLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  message: { error: "rate_limited", message: "Too many operations, slow down" },
});

export const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  message: { error: "rate_limited", message: "Too many uploads" },
});
