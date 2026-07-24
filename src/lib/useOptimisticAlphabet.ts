import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "./api";
import { getNextAlphabetState } from "../../shared/gameLogic";
import type { AlphabetState } from "../../shared/types";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

export interface UseOptimisticAlphabetResult {
  /** Per-letter state merged from server + local optimistic intent. */
  displayedAlphabet: Record<string, AlphabetState>;
  /**
   * Toggle the letter through its next state. Updates optimistic state
   * synchronously (the caller sees the change on the next render) and
   * sequences persistence so rapid taps don't race the network.
   */
  toggleLetter: (letter: string) => void;
}

/**
 * Owns the optimistic alphabet state for a game. Previously this lived inside
 * AlphabetBoard, which meant any component that wanted to read the player's
 * current marks (like the green-letters bar above the alphabet) had to wait
 * for a server WS round-trip before seeing the click reflected. Lifting state
 * here lets one hook instance drive multiple consumers off the same source.
 */
export function useOptimisticAlphabet(
  gameId: string,
  serverAlphabet: Record<string, AlphabetState> | undefined,
  disabled = false
): UseOptimisticAlphabetResult {
  const [optimisticAlphabet, setOptimisticAlphabet] = useState<Partial<Record<string, AlphabetState>>>({});
  const pendingStateRef = useRef(new Map<string, AlphabetState>());
  const inFlightLettersRef = useRef(new Set<string>());
  // Synchronous, render-independent record of the user's latest intent for
  // each letter. Rapid taps can fire before React has rendered the previous
  // setState, so reading optimisticAlphabet from closure gives a stale value
  // and the cycle (unknown → present → absent → unknown) gets stuck. This
  // ref is updated synchronously on every click so the next click always
  // advances.
  const latestIntentRef = useRef(new Map<string, AlphabetState>());
  const serverAlphabetRef = useRef(serverAlphabet);
  serverAlphabetRef.current = serverAlphabet;
  const gameIdRef = useRef(gameId);
  gameIdRef.current = gameId;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  // Clear optimistic state once the server confirms it. If the server still
  // has the old value (stale WS push), keep showing our optimistic state so
  // the letter doesn't flicker back.
  useEffect(() => {
    if (!serverAlphabet) {
      return;
    }
    setOptimisticAlphabet((current) => {
      let changed = false;
      const next = { ...current };
      for (const letter of ALPHABET) {
        if (pendingStateRef.current.has(letter) || inFlightLettersRef.current.has(letter)) {
          continue;
        }
        if (letter in next) {
          const serverValue = serverAlphabet[letter] ?? "unknown";
          if (serverValue === next[letter]) {
            delete next[letter];
            latestIntentRef.current.delete(letter);
            changed = true;
          }
        }
      }
      return changed ? next : current;
    });
  }, [serverAlphabet]);

  // Reset everything on game change.
  useEffect(() => {
    pendingStateRef.current.clear();
    inFlightLettersRef.current.clear();
    latestIntentRef.current.clear();
    setOptimisticAlphabet({});
  }, [gameId]);

  const persistLetterState = useCallback(async (letter: string) => {
    if (inFlightLettersRef.current.has(letter)) {
      return;
    }
    const desiredState = pendingStateRef.current.get(letter);
    if (desiredState === undefined) {
      return;
    }

    pendingStateRef.current.delete(letter);
    inFlightLettersRef.current.add(letter);

    try {
      await api.updateAlphabet(gameIdRef.current, {
        letter,
        state: desiredState,
      });
    } catch (error) {
      // Do NOT re-queue the failed state — that used to make this retry
      // forever (toast spam + unbounded requests) when the server kept
      // rejecting, e.g. a mark landing just as the game completed. Revert the
      // letter to the server's truth instead; if the user tapped again during
      // the flight, that newer intent is in pendingStateRef and still goes
      // out below.
      if (!pendingStateRef.current.has(letter)) {
        latestIntentRef.current.delete(letter);
        setOptimisticAlphabet((current) => {
          if (!(letter in current)) return current;
          const next = { ...current };
          delete next[letter];
          return next;
        });
      }
      toast.error(error instanceof Error ? error.message : "Failed to update alphabet");
    } finally {
      inFlightLettersRef.current.delete(letter);
      if (pendingStateRef.current.has(letter)) {
        void persistLetterState(letter);
      }
    }
  }, []);

  const toggleLetter = useCallback(
    (letter: string) => {
      if (disabledRef.current) {
        return;
      }

      const server = serverAlphabetRef.current;
      const currentState =
        latestIntentRef.current.get(letter) ?? server?.[letter] ?? "unknown";
      let newState = getNextAlphabetState(currentState);

      // Secret words always have 5 distinct letters, so don't let users land
      // a sixth green by accident — but still let them rule out the letter
      // (route to "absent") so the click isn't a dead end.
      if (newState === "present") {
        const greenCount = ALPHABET.reduce(
          (count, l) =>
            count +
            ((latestIntentRef.current.get(l) ?? server?.[l]) === "present" ? 1 : 0),
          0
        );
        if (greenCount >= 5) {
          newState = "absent";
        }
      }

      latestIntentRef.current.set(letter, newState);
      setOptimisticAlphabet((current) => {
        if (current[letter] === newState) return current;
        return { ...current, [letter]: newState };
      });
      pendingStateRef.current.set(letter, newState);
      void persistLetterState(letter);
    },
    [persistLetterState]
  );

  const displayedAlphabet = useMemo(() => {
    const result: Record<string, AlphabetState> = {};
    for (const letter of ALPHABET) {
      result[letter] = optimisticAlphabet[letter] ?? serverAlphabet?.[letter] ?? "unknown";
    }
    return result;
  }, [optimisticAlphabet, serverAlphabet]);

  return { displayedAlphabet, toggleLetter };
}
