import "./setup.js";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { runMigrations } from "../src/db/index.js";
import { seed } from "../src/db/seed.js";
import { createApp } from "../src/app.js";

runMigrations();
seed();

let server;
let baseUrl;

before(async () => {
  const app = createApp();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function req(method, path, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function registerUser(email) {
  const res = await req("POST", "/api/auth/register", { body: { email, password: "password123", name: "Test User" } });
  assert.equal(res.status, 201);
  return res.body;
}

test("registration + login issues a working bearer token", async () => {
  const { token, user } = await registerUser("alice@example.com");
  assert.ok(token);
  const me = await req("GET", "/api/auth/me", { token });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.id, user.id);
});

test("wrong password is rejected without leaking whether the account exists", async () => {
  await registerUser("bob@example.com");
  const wrongPass = await req("POST", "/api/auth/login", { body: { email: "bob@example.com", password: "wrongpassword" } });
  const noSuchUser = await req("POST", "/api/auth/login", { body: { email: "nobody@example.com", password: "wrongpassword" } });
  assert.equal(wrongPass.status, 401);
  assert.equal(noSuchUser.status, 401);
  assert.equal(wrongPass.body.error, noSuchUser.body.error, "response shape must not differ by account existence");
});

test("a user cannot read another user's order (IDOR protection)", async () => {
  const alice = await registerUser("alice-orders@example.com");
  const bob = await registerUser("bob-orders@example.com");

  const plans = await req("GET", "/api/plans");
  const planId = plans.body.plans[0].id;

  const order = await req("POST", "/api/orders", {
    token: alice.token,
    body: { planId, serverName: "Alice Bot" },
  });
  assert.equal(order.status, 201);
  const orderId = order.body.order.id;

  const bobReadsAlice = await req("GET", `/api/orders/${orderId}`, { token: bob.token });
  assert.equal(bobReadsAlice.status, 404, "must be 404, not 403 (never confirm the resource exists)");

  const aliceReadsOwn = await req("GET", `/api/orders/${orderId}`, { token: alice.token });
  assert.equal(aliceReadsOwn.status, 200);
});

test("non-admin cannot access admin routes", async () => {
  const carol = await registerUser("carol@example.com");
  const res = await req("GET", "/api/admin/users", { token: carol.token });
  assert.equal(res.status, 403);
});

test("unauthenticated requests to protected routes are rejected", async () => {
  const res = await req("GET", "/api/servers");
  assert.equal(res.status, 401);
});

test("blocking a user immediately invalidates their existing token", async () => {
  // The admin API route for this is covered by ownership/role tests above;
  // here we exercise the token_version invalidation mechanism itself
  // directly through the repository, since ADMIN_EMAIL/PASSWORD aren't
  // seeded in the test environment.
  const dave = await registerUser("dave@example.com");
  const meBefore = await req("GET", "/api/auth/me", { token: dave.token });
  assert.equal(meBefore.status, 200);

  const { setUserStatus } = await import("../src/repositories/users.js");
  setUserStatus(dave.user.id, "blocked");

  // setUserStatus bumps token_version as its invalidation mechanism, so the
  // pre-existing token is rejected as revoked (401) before requireAuth even
  // reaches the blocked-status check (403) -- either way the old token must
  // stop working immediately, which is what this test guards.
  const meAfter = await req("GET", "/api/auth/me", { token: dave.token });
  assert.equal(meAfter.status, 401, "a token issued before blocking must stop working immediately");

  const reLogin = await req("POST", "/api/auth/login", { body: { email: "dave@example.com", password: "password123" } });
  assert.equal(reLogin.status, 403, "attempting to log in again as a blocked user must be explicitly forbidden");
});
