import type { Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { getUserFromSessionId, parseSessionIdFromCookieHeader } from "./auth.js";
import { getGameState } from "./gameService.js";
import { onGameEvent } from "./gameEvents.js";
import type { AuthUser } from "./types.js";

const WS_PATH = "/ws";
const HEARTBEAT_INTERVAL_MS = 30_000;

type SubscribeMessage = { type: "subscribe"; gameId: string };
type UnsubscribeMessage = { type: "unsubscribe" };
type PingMessage = { type: "ping" };
type ClientMessage = SubscribeMessage | UnsubscribeMessage | PingMessage;

type ClientSocket = WebSocket & {
  isAlive: boolean;
  user: AuthUser | null;
  gameId: string | null;
};

const gameSubscribers = new Map<string, Set<ClientSocket>>();

function removeSubscriber(socket: ClientSocket) {
  if (!socket.gameId) {
    return;
  }
  const subs = gameSubscribers.get(socket.gameId);
  if (!subs) {
    socket.gameId = null;
    return;
  }
  subs.delete(socket);
  if (subs.size === 0) {
    gameSubscribers.delete(socket.gameId);
  }
  socket.gameId = null;
}

function addSubscriber(socket: ClientSocket, gameId: string) {
  removeSubscriber(socket);
  let subs = gameSubscribers.get(gameId);
  if (!subs) {
    subs = new Set();
    gameSubscribers.set(gameId, subs);
  }
  subs.add(socket);
  socket.gameId = gameId;
}

function safeSend(socket: ClientSocket, payload: unknown) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  try {
    socket.send(JSON.stringify(payload));
  } catch (error) {
    console.error("[ws] send failed", error);
  }
}

async function handleSubscribe(socket: ClientSocket, gameId: string) {
  if (!socket.user) {
    safeSend(socket, { type: "error", message: "Not authenticated." });
    return;
  }
  if (typeof gameId !== "string" || gameId.length === 0) {
    safeSend(socket, { type: "error", message: "Invalid gameId." });
    return;
  }

  // Verify the caller has access to this game before adding them to the broadcast set.
  try {
    const state = await getGameState(socket.user, gameId);
    if (!state) {
      safeSend(socket, { type: "gameEnded", gameId });
      return;
    }
    addSubscriber(socket, gameId);
    safeSend(socket, { type: "gameState", state });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to subscribe to game.";
    safeSend(socket, { type: "error", message });
  }
}

function handleClientMessage(socket: ClientSocket, raw: string) {
  let parsed: ClientMessage;
  try {
    parsed = JSON.parse(raw) as ClientMessage;
  } catch {
    safeSend(socket, { type: "error", message: "Invalid message." });
    return;
  }

  switch (parsed.type) {
    case "subscribe":
      void handleSubscribe(socket, parsed.gameId);
      return;
    case "unsubscribe":
      removeSubscriber(socket);
      return;
    case "ping":
      safeSend(socket, { type: "pong" });
      return;
    default:
      safeSend(socket, { type: "error", message: "Unknown message type." });
  }
}

export async function broadcastGameUpdate(gameId: string): Promise<void> {
  const subs = gameSubscribers.get(gameId);
  if (!subs || subs.size === 0) {
    return;
  }

  // Per-subscriber state: getGameState is viewer-specific (me vs opponent differ).
  // Snapshot the set so mutations during iteration don't break us.
  const snapshot = Array.from(subs);
  await Promise.all(
    snapshot.map(async (socket) => {
      if (!socket.user || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      try {
        const state = await getGameState(socket.user, gameId);
        if (!state) {
          safeSend(socket, { type: "gameEnded", gameId });
          return;
        }
        safeSend(socket, { type: "gameState", state });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to load game state.";
        safeSend(socket, { type: "error", message });
      }
    })
  );
}

export function broadcastGameEnded(gameId: string): void {
  const subs = gameSubscribers.get(gameId);
  if (!subs) {
    return;
  }
  for (const socket of subs) {
    safeSend(socket, { type: "gameEnded", gameId });
  }
  gameSubscribers.delete(gameId);
}

export function attachWebSocketServer(httpServer: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  const unsubscribeEvents = onGameEvent((event) => {
    if (event.type === "updated") {
      return broadcastGameUpdate(event.gameId);
    }
    broadcastGameEnded(event.gameId);
  });

  httpServer.on("upgrade", async (request, socket, head) => {
    if (request.url !== WS_PATH && !request.url?.startsWith(`${WS_PATH}?`)) {
      // Not our path — let other upgrade handlers (if any) handle it.
      return;
    }

    try {
      const queryToken = request.url?.includes("?")
        ? new URLSearchParams(request.url.split("?")[1]).get("token")
        : null;
      const sessionId = queryToken ?? parseSessionIdFromCookieHeader(request.headers.cookie);
      const user = await getUserFromSessionId(sessionId);

      if (!user) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        const client = ws as ClientSocket;
        client.isAlive = true;
        client.user = user;
        client.gameId = null;
        wss.emit("connection", client, request);
      });
    } catch (error) {
      console.error("[ws] upgrade failed", error);
      socket.destroy();
    }
  });

  wss.on("connection", (rawSocket) => {
    const socket = rawSocket as ClientSocket;

    socket.on("message", (data) => {
      handleClientMessage(socket, data.toString());
    });

    socket.on("pong", () => {
      socket.isAlive = true;
    });

    socket.on("close", () => {
      removeSubscriber(socket);
    });

    socket.on("error", (error) => {
      console.error("[ws] socket error", error);
      removeSubscriber(socket);
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      const socket = client as ClientSocket;
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  wss.on("close", () => {
    clearInterval(heartbeat);
    unsubscribeEvents();
  });

  return wss;
}
