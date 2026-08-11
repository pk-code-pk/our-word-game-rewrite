import http from "node:http";
import { app } from "./app.js";

const PORT = Number(process.env.PORT ?? 3001);

// Plain HTTP server for local dev. Realtime updates are delivered via Supabase
// Realtime broadcasts (see server/realtime.ts), so there is no WebSocket
// server to attach — this keeps the app serverless-safe on Vercel.
const httpServer = http.createServer(app);

// The database is Supabase Postgres, which pauses after 7 days of inactivity,
// not 5 minutes. The /api/keepalive Vercel Cron in vercel.json already covers
// that; the 4-minute keep-warm loop that used to live here was written for Neon
// and only added a query every 4 minutes forever.
httpServer.listen(PORT, () => {
  console.log(`FourFive backend listening on http://localhost:${PORT}`);
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
