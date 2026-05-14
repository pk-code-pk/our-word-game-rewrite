import http from "node:http";
import { app } from "./app.js";
import { attachWebSocketServer } from "./gameSockets.js";
import { keepDbAlive } from "./db.js";

const PORT = Number(process.env.PORT ?? 3001);

const httpServer = http.createServer(app);
const wss = attachWebSocketServer(httpServer);

httpServer.listen(PORT, () => {
  console.log(`FourFive backend listening on http://localhost:${PORT}`);
  console.log(`WebSocket endpoint on ws://localhost:${PORT}/ws`);

  // Keep Render free tier awake every 10 minutes.
  if (process.env.RENDER_EXTERNAL_URL) {
    const url = `${process.env.RENDER_EXTERNAL_URL}/api/health`;
    setInterval(() => {
      fetch(url).catch(() => {});
    }, 10 * 60 * 1000);
  }

  // Keep Neon DB awake every 4 minutes (Neon pauses after 5 min idle).
  setInterval(() => {
    void keepDbAlive();
  }, 4 * 60 * 1000);
});

let isShuttingDown = false;
function shutdown(signal: NodeJS.Signals) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[server] ${signal} received — closing connections gracefully`);

  // Tell every WebSocket client we're going away (1001) so they reconnect
  // immediately to the new instance instead of waiting for a TCP/ping timeout.
  for (const client of wss.clients) {
    try {
      client.close(1001, "Server shutting down.");
    } catch {
      // ignore
    }
  }

  httpServer.close(() => process.exit(0));
  // Hard cap on graceful shutdown: Render gives ~30s before SIGKILL.
  setTimeout(() => process.exit(0), 20_000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
