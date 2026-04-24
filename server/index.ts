import http from "node:http";
import { app } from "./app.js";
import { attachWebSocketServer } from "./gameSockets.js";
import { keepDbAlive } from "./db.js";

const PORT = Number(process.env.PORT ?? 3001);

const httpServer = http.createServer(app);
attachWebSocketServer(httpServer);

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
