import http from "node:http";
import { app } from "./app.js";
import { keepDbAlive } from "./db.js";

const PORT = Number(process.env.PORT ?? 3001);

// Plain HTTP server for local dev. Realtime updates are delivered via Supabase
// Realtime broadcasts (see server/realtime.ts), so there is no WebSocket
// server to attach — this keeps the app serverless-safe on Vercel.
const httpServer = http.createServer(app);

httpServer.listen(PORT, () => {
  console.log(`FourFive backend listening on http://localhost:${PORT}`);

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

  httpServer.close(() => process.exit(0));
  // Hard cap on graceful shutdown.
  setTimeout(() => process.exit(0), 20_000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
