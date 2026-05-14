import { useEffect, useRef, useState } from "react";
import type { GameStateView } from "../../shared/types";
import { api, getStoredToken } from "./api";

// Delay before falling back to HTTP polling. Lets the WS connection establish
// (typically <500ms) without two transports racing each other on initial mount.
const POLL_FALLBACK_DELAY_MS = 1_500;

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
const POLL_INTERVAL_MS = 3_000;

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
  const connectedRef = useRef(false);

  useEffect(() => {
    dataRef.current = undefined;
    connectedRef.current = false;
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
    let pollTimer: number | null = null;
    let pollFallbackTimer: number | null = null;
    // Monotonic id for state-apply calls so a slow in-flight fetch can't
    // overwrite newer state arriving from another source (WS or a later poll).
    let appliedStateSeq = 0;
    let latestRequestSeq = 0;

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

    const clearPoll = () => {
      if (pollTimer !== null) {
        window.clearInterval(pollTimer);
        pollTimer = null;
      }
      if (pollFallbackTimer !== null) {
        window.clearTimeout(pollFallbackTimer);
        pollFallbackTimer = null;
      }
    };

    const applyState = (state: GameStateView | null, seq?: number) => {
      if (seq !== undefined && seq < appliedStateSeq) {
        // Ignore: a newer state already won the race.
        return;
      }
      if (seq !== undefined) {
        appliedStateSeq = seq;
      } else {
        appliedStateSeq = ++latestRequestSeq;
      }
      const next: GameSocketResponse = { gameState: state };
      dataRef.current = next;
      setData(next);
      setError(null);
      setLoading(false);
    };

    const applyError = (cause: unknown) => {
      const err = cause instanceof Error ? cause : new Error(typeof cause === "string" ? cause : "Connection error.");
      setError(err);
      setLoading(dataRef.current === undefined);
    };

    const fetchState = async () => {
      const seq = ++latestRequestSeq;
      try {
        const response = await api.getGameState(gameId);
        if (cancelled) return;
        applyState(response.gameState ?? null, seq);
      } catch (cause) {
        if (cancelled) return;
        applyError(cause);
      }
    };

    const startPolling = () => {
      clearPoll();
      pollTimer = window.setInterval(() => {
        if (!cancelled && !connectedRef.current) {
          void fetchState();
        }
      }, POLL_INTERVAL_MS);
    };

    const stopPolling = () => {
      clearPoll();
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

      try {
        ws = new WebSocket(buildSocketUrl());
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
        connectedRef.current = true;
        setConnected(true);
        setError(null);
        stopPolling();

        // Re-sync from the source of truth before relying on incremental WS
        // pushes. Without this, the client can drift if changes happened while
        // the socket was reconnecting — including during the brief gap on the
        // initial connect after this hook mounts.
        void fetchState();

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
              // ignore — close handler will trigger reconnect
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
            // Server-pushed state is authoritative and most-recent by definition.
            applyState(parsed.state, ++latestRequestSeq);
            return;
          case "gameEnded":
            applyState(null, ++latestRequestSeq);
            return;
          case "error":
            applyError(new Error(parsed.message));
            return;
          case "pong":
            return;
        }
      };

      ws.onerror = () => {
        // Let onclose handle reconnect
      };

      ws.onclose = (event) => {
        clearPing();
        connectedRef.current = false;
        setConnected(false);
        if (cancelled) return;

        if (event.code === 1000) return;

        if (event.code === 1008 || event.code === 4401 || event.code === 401) {
          applyError(new Error("Not authenticated."));
        }

        // Fall back to polling while reconnecting so updates still arrive
        startPolling();
        scheduleReconnect();
      };
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible" || cancelled) return;
      if (ws && ws.readyState === WebSocket.OPEN) return;
      reconnectAttempt = 0;
      clearReconnect();
      openSocket();
    };

    void fetchState();
    openSocket();
    // Defer polling fallback briefly so it doesn't race with the WS handshake.
    // If the WS opens within the delay, onopen calls stopPolling() and this is
    // a no-op. If it doesn't, polling kicks in as the safety net.
    pollFallbackTimer = window.setTimeout(() => {
      pollFallbackTimer = null;
      if (cancelled || connectedRef.current) return;
      startPolling();
    }, POLL_FALLBACK_DELAY_MS);

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleVisibilityChange);

    return () => {
      cancelled = true;
      clearReconnect();
      clearPing();
      clearPoll();
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
