import { useCallback, useEffect, useRef, useState } from "react";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { GameStateView } from "../../shared/types";
import { api } from "./api";

// Safety poll interval. Supabase Realtime broadcasts are the primary update
// path; this slow poll is a backstop for missed/dropped signals. It is
// deliberately slow (20s) — the old 3s poll was a cost problem, and with
// broadcast-driven refetches we no longer need aggressive polling.
const SAFETY_POLL_INTERVAL_MS = 20_000;

export interface SubmitGuessResult {
  matchCount: number;
  isCorrect: boolean;
  guessNumber: number;
  gameStatus: "active" | "completed";
}

export interface SubmitGuessPayload {
  type: "fourLetter" | "fullWord";
  text: string;
}

export interface GameSocketResponse {
  gameState: GameStateView | null;
}

export interface GameSocketResult {
  data: GameSocketResponse | undefined;
  error: Error | null;
  loading: boolean;
  connected: boolean;
  submitGuess: (payload: SubmitGuessPayload) => Promise<SubmitGuessResult>;
}

// Lazily-created singleton Supabase client. Created on first use so a missing
// env var (e.g. during tests or misconfigured builds) degrades to poll-only
// updates instead of throwing at module load.
let supabaseClient: SupabaseClient | null | undefined;
function getSupabaseClient(): SupabaseClient | null {
  if (supabaseClient !== undefined) {
    return supabaseClient;
  }
  const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim();
  const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim();
  if (!url || !anonKey) {
    supabaseClient = null;
    return null;
  }
  try {
    supabaseClient = createClient(url, anonKey, {
      // No Supabase Auth session in play — we only use anonymous Realtime.
      auth: { persistSession: false, autoRefreshToken: false },
    });
  } catch {
    supabaseClient = null;
  }
  return supabaseClient;
}

export function useGameSocket(gameId: string | null): GameSocketResult {
  const [data, setData] = useState<GameSocketResponse | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);

  const dataRef = useRef<GameSocketResponse | undefined>(undefined);
  const gameIdRef = useRef<string | null>(gameId);
  gameIdRef.current = gameId;

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
    let pollTimer: number | null = null;
    // Monotonic id for state-apply calls so a slow in-flight fetch can't
    // overwrite newer state arriving from another refetch.
    let appliedStateSeq = 0;
    let latestRequestSeq = 0;

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

    // A broadcast signal carries no game data — it just tells us to refetch the
    // viewer-specific state from the authoritative HTTP endpoint.
    const refetchState = () => {
      if (cancelled) return;
      void fetchState();
    };

    // The game ended (e.g. lobby cancelled). Refetch so the server can report
    // the terminal/absent state for this viewer.
    const handleEnded = () => {
      if (cancelled) return;
      void fetchState();
    };

    // Initial load from the source of truth.
    void fetchState();

    const client = getSupabaseClient();
    const channel = client
      ? client
          .channel(`game:${gameId}`)
          .on("broadcast", { event: "updated" }, () => refetchState())
          .on("broadcast", { event: "ended" }, () => handleEnded())
          .subscribe((status) => {
            if (cancelled) return;
            setConnected(status === "SUBSCRIBED");
          })
      : null;

    // Slow safety poll: catches any signal we missed while (re)subscribing or
    // if the Realtime connection is degraded. Also the sole update path when
    // Supabase env is unconfigured (client === null).
    pollTimer = window.setInterval(() => {
      if (!cancelled) {
        void fetchState();
      }
    }, SAFETY_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (pollTimer !== null) {
        window.clearInterval(pollTimer);
        pollTimer = null;
      }
      if (channel && client) {
        // Unsubscribe and drop the channel so we don't leak subscriptions
        // across gameId changes / unmounts.
        void client.removeChannel(channel);
      }
    };
  }, [gameId]);

  const submitGuess = useCallback(async (payload: SubmitGuessPayload): Promise<SubmitGuessResult> => {
    const currentGameId = gameIdRef.current;
    if (!currentGameId) {
      throw new Error("No active game.");
    }
    // Guesses always POST to the HTTP endpoint; the resulting mutation triggers
    // a server-side broadcast that refetches state for both players.
    return api.submitGuess(currentGameId, payload);
  }, []);

  return { data, error, loading, connected, submitGuess };
}
