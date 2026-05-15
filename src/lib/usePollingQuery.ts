import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api";
import { isDocumentVisible, stabilizeJsonValue } from "./pollingUtils";

export interface PollingQueryOptions {
  intervalMs?: number;
  enabled?: boolean;
  pauseWhenHidden?: boolean;
  refreshIndicatorDelayMs?: number;
}

const MAX_ERROR_BACKOFF_MS = 30_000;

export interface PollingQueryResult<T> {
  data: T | undefined;
  error: Error | null;
  loading: boolean;
  refreshing: boolean;
  lastUpdatedAt: number | null;
  isPaused: boolean;
  /**
   * Trigger an immediate refetch for the current effect generation without
   * tearing down the polling loop. Safe to call from event handlers and
   * effects; callers do not need to await this.
   */
  refetch: () => void;
}

export function usePollingQuery<T>(
  loader: () => Promise<T>,
  deps: ReadonlyArray<unknown>,
  options?: PollingQueryOptions
): PollingQueryResult<T> {
  const intervalMs = options?.intervalMs ?? 2000;
  const enabled = options?.enabled ?? true;
  const pauseWhenHidden = options?.pauseWhenHidden ?? true;
  const refreshIndicatorDelayMs = options?.refreshIndicatorDelayMs ?? 120;

  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [isPaused, setIsPaused] = useState(!enabled || (pauseWhenHidden && !isDocumentVisible()));

  const loaderRef = useRef(loader);
  const dataRef = useRef<T | undefined>(undefined);
  const effectGenerationRef = useRef(0);
  const latestRequestRef = useRef(0);
  const timeoutRef = useRef<number | undefined>(undefined);
  const refreshTimerRef = useRef<number | undefined>(undefined);
  const inFlightRef = useRef(false);
  const visibleRef = useRef(isDocumentVisible());
  const consecutiveErrorsRef = useRef(0);
  const authBlockedRef = useRef(false);
  // Holds the latest run() bound to the current effect generation so the
  // public refetch callback can be a stable reference but still kick the
  // active poll loop, not a stale closure.
  const refetchImplRef = useRef<(() => void) | null>(null);

  loaderRef.current = loader;

  const clearTimeouts = () => {
    if (timeoutRef.current !== undefined) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = undefined;
    }
    if (refreshTimerRef.current !== undefined) {
      window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = undefined;
    }
  };

  const scheduleNextRun = (effectGeneration: number, delayMs: number) => {
    clearTimeouts();

    if (!enabled || (pauseWhenHidden && !visibleRef.current)) {
      return;
    }

    timeoutRef.current = window.setTimeout(() => {
      void run(effectGeneration);
    }, Math.max(0, delayMs));
  };

  const setStableData = (next: T) => {
    const previousData = dataRef.current;
    const stableNext = stabilizeJsonValue(previousData, next);
    const didChange = stableNext !== previousData;
    dataRef.current = stableNext;

    if (!didChange && error === null && !refreshing) {
      return;
    }

    startTransition(() => {
      if (didChange) {
        setData(stableNext);
        setLastUpdatedAt(Date.now());
      }
      setError(null);
      setLoading(false);
      setRefreshing(false);
    });
  };

  const run = async (effectGeneration: number) => {
    if (inFlightRef.current || effectGenerationRef.current !== effectGeneration || !enabled) {
      return;
    }

    if (pauseWhenHidden && !visibleRef.current) {
      setIsPaused(true);
      return;
    }

    inFlightRef.current = true;

    if (dataRef.current !== undefined) {
      setRefreshing(false);
      refreshTimerRef.current = window.setTimeout(() => {
        if (effectGenerationRef.current === effectGeneration && inFlightRef.current) {
          startTransition(() => {
            setRefreshing(true);
          });
        }
      }, refreshIndicatorDelayMs);
    } else {
      startTransition(() => {
        setLoading(true);
      });
    }

    const requestId = latestRequestRef.current + 1;
    latestRequestRef.current = requestId;

    try {
      const next = await loaderRef.current();
      if (effectGenerationRef.current === effectGeneration && latestRequestRef.current === requestId) {
        consecutiveErrorsRef.current = 0;
        setStableData(next);
      }
    } catch (cause) {
      if (effectGenerationRef.current === effectGeneration && latestRequestRef.current === requestId) {
        const nextError = cause instanceof Error ? cause : new Error("Request failed.");
        // Stop polling on auth failure — repeating with a dead token just keeps
        // showing stale data. ApiError dispatches AUTH_ERROR_EVENT which the app
        // already handles to surface a sign-in prompt.
        if (nextError instanceof ApiError && nextError.status === 401) {
          authBlockedRef.current = true;
        } else {
          consecutiveErrorsRef.current += 1;
        }
        startTransition(() => {
          setError(nextError);
          setLoading(false);
          setRefreshing(false);
        });
      }
    } finally {
      if (refreshTimerRef.current !== undefined) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = undefined;
      }

      inFlightRef.current = false;

      if (effectGenerationRef.current !== effectGeneration || !enabled) {
        return;
      }

      if (authBlockedRef.current) {
        setIsPaused(true);
        return;
      }

      if (pauseWhenHidden && !visibleRef.current) {
        setIsPaused(true);
        return;
      }

      setIsPaused(false);
      const errors = consecutiveErrorsRef.current;
      const delay = errors === 0
        ? intervalMs
        : Math.min(intervalMs * 2 ** Math.min(errors, 5), MAX_ERROR_BACKOFF_MS);
      scheduleNextRun(effectGeneration, delay);
    }
  };

  useEffect(() => {
    if (!enabled) {
      effectGenerationRef.current += 1;
      clearTimeouts();
      setIsPaused(true);
      setRefreshing(false);
      setLoading(false);
      return;
    }

    const effectGeneration = ++effectGenerationRef.current;
    // A new effect run (deps change → new token / new user / re-mount) should
    // retry from scratch, regardless of prior auth/error state.
    consecutiveErrorsRef.current = 0;
    authBlockedRef.current = false;
    let cancelled = false;

    const syncVisibility = () => {
      visibleRef.current = isDocumentVisible();
      setIsPaused(pauseWhenHidden && !visibleRef.current);

      if (!visibleRef.current) {
        clearTimeouts();
        return;
      }

      if (cancelled || effectGenerationRef.current !== effectGeneration || inFlightRef.current) {
        return;
      }

      clearTimeouts();

      if (visibleRef.current) {
        void run(effectGeneration);
      }
    };

    const onPageShow = () => {
      visibleRef.current = true;
      setIsPaused(false);

      if (!cancelled && effectGenerationRef.current === effectGeneration && !inFlightRef.current) {
        clearTimeouts();
        void run(effectGeneration);
      }
    };

    clearTimeouts();
    setError(null);

    if (dataRef.current === undefined) {
      setLoading(true);
      setRefreshing(false);
    } else {
      setLoading(false);
      setRefreshing(false);
    }

    // Bind refetch to this effect generation. If a refetch fires while a
    // request is already in flight we skip — the in-flight response will
    // arrive shortly and call setStableData, which is what refetch wants
    // anyway. Otherwise we cancel the scheduled next poll and run now.
    refetchImplRef.current = () => {
      if (effectGenerationRef.current !== effectGeneration || !enabled) {
        return;
      }
      if (inFlightRef.current) {
        return;
      }
      clearTimeouts();
      void run(effectGeneration);
    };

    void run(effectGeneration);

    if (typeof document !== "undefined" && pauseWhenHidden) {
      document.addEventListener("visibilitychange", syncVisibility);
    }
    if (typeof window !== "undefined" && pauseWhenHidden) {
      window.addEventListener("pageshow", onPageShow);
      window.addEventListener("focus", onPageShow);
    }

    return () => {
      cancelled = true;
      effectGenerationRef.current += 1;
      clearTimeouts();
      refetchImplRef.current = null;

      if (typeof document !== "undefined" && pauseWhenHidden) {
        document.removeEventListener("visibilitychange", syncVisibility);
      }
      if (typeof window !== "undefined" && pauseWhenHidden) {
        window.removeEventListener("pageshow", onPageShow);
        window.removeEventListener("focus", onPageShow);
      }
    };
  }, [enabled, intervalMs, pauseWhenHidden, refreshIndicatorDelayMs, ...deps]);

  const refetch = useCallback(() => {
    refetchImplRef.current?.();
  }, []);

  return { data, error, loading, refreshing, lastUpdatedAt, isPaused, refetch };
}
