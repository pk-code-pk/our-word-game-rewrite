import http from "node:http";
import { app } from "./app.js";
import { attachWebSocketServer } from "./gameSockets.js";

const PORT = Number(process.env.PORT ?? 3001);

const httpServer = http.createServer(app);
attachWebSocketServer(httpServer);

httpServer.listen(PORT, () => {
  console.log(`FourFive backend listening on http://localhost:${PORT}`);
  console.log(`WebSocket endpoint on ws://localhost:${PORT}/ws`);
});
