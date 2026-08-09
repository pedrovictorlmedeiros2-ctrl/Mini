import { verifyAccessToken } from "../lib/authToken.js";
import { getUserById } from "../repositories/users.js";
import { getServerById } from "../repositories/servers.js";
import { subscribe, unsubscribe, unsubscribeAll, getSubscribers } from "./consoleSubscriptions.js";
import { bus, Events } from "../lib/bus.js";
import { logger } from "../lib/logger.js";

const clients = new Set(); // { ws, userId, role }

export function authenticatePanelClient(token) {
  try {
    const payload = verifyAccessToken(token);
    const user = getUserById(payload.sub);
    if (!user || user.token_version !== payload.tv || user.status === "blocked") return null;
    return user;
  } catch {
    return null;
  }
}

function canAccessServer(user, server) {
  return !!server && (user.role === "admin" || server.user_id === user.id);
}

export function handlePanelConnection(ws, user) {
  const entry = { ws, userId: user.id, role: user.role };
  clients.add(entry);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "subscribe_console") {
      const server = getServerById(msg.serverId);
      if (!canAccessServer(user, server)) {
        ws.send(JSON.stringify({ type: "error", message: "not found or access denied" }));
        return;
      }
      subscribe(server.id, ws, server.node_id, server.container_id);
    } else if (msg.type === "unsubscribe_console") {
      const server = getServerById(msg.serverId);
      unsubscribe(msg.serverId, ws, server?.node_id);
    }
  });

  ws.on("close", () => {
    clients.delete(entry);
    unsubscribeAll(ws, (serverId) => getServerById(serverId)?.node_id);
  });

  ws.on("error", (err) => {
    logger.debug({ err: err.message }, "panel websocket error");
  });
}

bus.on(Events.SERVER_CHANGED, (server) => {
  const payload = JSON.stringify({ type: "server_update", server });
  for (const { ws, userId, role } of clients) {
    if (role === "admin" || userId === server.user_id) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }
});

bus.on(Events.CONSOLE_LOG, ({ serverId, line, ts }) => {
  const subs = getSubscribers(serverId);
  if (subs.size === 0) return;
  const payload = JSON.stringify({ type: "console_log", serverId, line, ts });
  for (const ws of subs) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
});
