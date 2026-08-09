const API_BASE = "/api";

let token = localStorage.getItem("atlantic_token") || null;

export function setToken(t) {
  token = t;
  if (t) localStorage.setItem("atlantic_token", t);
  else localStorage.removeItem("atlantic_token");
}

export function getToken() {
  return token;
}

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || body?.error || `Request failed with ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function request(method, path, body, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    if (res.status === 401 && token) {
      setToken(null);
      window.location.href = "/login";
    }
    throw new ApiError(res.status, data);
  }
  return data;
}

export const api = {
  get: (path) => request("GET", path),
  post: (path, body) => request("POST", path, body ?? {}),
  put: (path, body) => request("PUT", path, body ?? {}),
  patch: (path, body) => request("PATCH", path, body ?? {}),
  delete: (path, body) => request("DELETE", path, body),
};

export function wsUrl(path) {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = import.meta.env.DEV ? "localhost:4000" : window.location.host;
  return `${proto}//${host}${path}?token=${encodeURIComponent(token || "")}`;
}
