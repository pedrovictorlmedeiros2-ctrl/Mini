import { WebSocketServer } from "ws";
import { URL } from "node:url";
import { authenticateAgent, handleAgentConnection } from "./agentServer.js";
import { authenticatePanelClient, handlePanelConnection } from "./panelServer.js";
import { logger } from "../lib/logger.js";

export function attachWebSocketServer(httpServer) {
  const agentWss = new WebSocketServer({ noServer: true });
  const panelWss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, "http://internal");
    } catch {
      socket.destroy();
      return;
    }

    if (url.pathname === "/ws/agent") {
      const nodeId = url.searchParams.get("nodeId");
      const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "") || url.searchParams.get("token");
      const node = authenticateAgent(nodeId, token);
      if (!node) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      agentWss.handleUpgrade(req, socket, head, (ws) => handleAgentConnection(ws, node));
      return;
    }

    if (url.pathname === "/ws/panel") {
      const token = url.searchParams.get("token");
      const user = authenticatePanelClient(token);
      if (!user) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      panelWss.handleUpgrade(req, socket, head, (ws) => handlePanelConnection(ws, user));
      return;
    }

    socket.destroy();
  });

  logger.info("websocket server attached (/ws/agent, /ws/panel)");
}
