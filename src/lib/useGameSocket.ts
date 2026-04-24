import { useEffect, useRef, useState } from "react";
import type { GameStateView } from "../../shared/types";
import { api, getStoredToken } from "./api";

export interface GameSocketResponse {
  gameState: GameStateView | null;
}

export interface GameSocketResult {
  data: GameSocketResponse | undefined;
  error: Error | null;
  loading: boolean;
  connected: boolean;
}

type ServerMessage =
  | { type: "gameState"; state: GameStateView }
  | { type: "gameEnded"; gameId: string }
  | { type: "error"; message: string }
  | { type: "pong" };

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const PING_INTERVAL_MS = 20_000;

function buildSocketUrl(): string {
  if (typeof window === "undefined") {
    return "";
  }
  const base = (import.meta.env.VITE_WS_URL as string | undefined)?.trim();
  const origin = base ? base.replace(/\/$/, "") : `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;
  const token = getStoredToken();
  return token ? `${origin}/ws?token=${encodeURIComponent(token)}` : `${origin}/ws`;
}

export function useGameSocket(gameId: string | null): GameSocketResult {
  const [data, setData] = useState<GameSocketResponse | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);

  const dataRef = useRef<GameSocketResponse | undefined>(undefined);

  useEffect(() => {
    dataRef.current = undefined;
    setData(undefined);
    setError(null);
    setLoading(true);
    setConnected(false);

    if (!gameId) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    let ws: WebSocket | null = null;
    let reconnectAttempt = 0;
    let reconnectTimer: number | null = null;
    let pingTimer: number | null = null;
    let currentUrl = buildSocketUrl();

    const clearReconnect = () => {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const clearPing = () => {
      if (pingTimer !== null) {
        window.clearInterval(pingTimer);
        pingTimer = null;
      }
    };

    const applyState = (state: GameStateView | null) => {
      const next: GameSocketResponse = { gameState: state };
      dataRef.current = next;
      setData(next);
      setError(null);
      setLoading(false);
    };

    const applyError = (cause: unknown) => {
      const err = cause instanceof Error ? cause : new Error(typeof cause === "string" ? cause : "Connection error.");
      setError(err);
      // Keep last-known data so UI doesn't flash empty
      setLoading(dataRef.current === undefined);
    };

    const fetchInitialState = async () => {
      try {
        const response = await api.getGameState(gameId);
        if (cancelled) return;
        applyState(response.gameState ?? null);
      } catch (cause) {
        if (cancelled) return;
        applyError(cause);
      }
    };

    const scheduleReconnect = () => {
      if (cancelled) return;
      const delay = Math.min(
        INITIAL_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempt),
        MAX_RECONNECT_DELAY_MS
      );
      reconnectAttempt += 1;
      clearReconnect();
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        if (!cancelled) {
          openSocket();
        }
      }, delay);
    };

    const openSocket = () => {
      if (cancelled) return;
      clearReconnect();

      currentUrl = buildSocketUrl();
      try {
        ws = new WebSocket(currentUrl);
      } catch (cause) {
        applyError(cause);
        scheduleReconnect();
        return;
      }

      ws.onopen = () => {
        if (cancelled) {
          ws?.close();
          return;
        }
        reconnectAttempt = 0;
        setConnected(true);
        setError(null);
        try {
          ws?.send(JSON.stringify({ type: "subscribe", gameId }));
        } catch (cause) {
          applyError(cause);
        }

        clearPing();
        pingTimer = window.setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) {
            try {
              ws.send(JSON.stringify({ type: "ping" }));
            } catch {
              // Ignore — close handler will trigger reconnect
            }
          }
        }, PING_INTERVAL_MS);
      };

      ws.onmessage = (event) => {
        if (cancelled) return;
        let parsed: ServerMessage;
        try {
          parsed = JSON.parse(String(event.data)) as ServerMessage;
        } catch {
          return;
        }

        switch (parsed.type) {
          case "gameState":
            applyState(parsed.state);
            return;
          case "gameEnded":
            applyState(null);
            return;
          case "error":
            applyError(new Error(parsed.message));
            return;
          case "pong":
            return;
        }
      };

      ws.onerror = () => {
        if (cancelled) return;
        // Don't clobber last-known data. Let onclose handle reconnect.
      };

      ws.onclose = (event) => {
        clearPing();
        setConnected(false);
        if (cancelled) return;

        if (event.code === 1000) {
          // Normal closure; don't reconnect
          return;
        }

        if (event.code === 1008 || event.code === 4401 || event.code === 401) {
          // Auth failure — no point retrying the same way, but try once after a delay
          applyError(new Error("Not authenticated."));
        }

        scheduleReconnect();
      };
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible" || cancelled) {
        return;
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        return;
      }
      reconnectAttempt = 0;
      clearReconnect();
      openSocket();
    };

    void fetchInitialState();
    openSocket();

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleVisibilityChange);

    return () => {
      cancelled = true;
      clearReconnect();
      clearPing();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleVisibilityChange);
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        try {
          ws.close(1000);
        } catch {
          // ignore
        }
        ws = null;
      }
    };
  }, [gameId]);

  return { data, error, loading, connected };
}
