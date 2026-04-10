import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { getNextAlphabetState } from "../../shared/gameLogic";
import type { AlphabetState } from "../../shared/types";

interface AlphabetBoardProps {
  gameId: string;
  alphabet: Record<string, "present" | "absent" | "unknown">;
  disabled?: boolean;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const STATE_LABELS: Record<AlphabetState, string> = {
  unknown: "blank",
  present: "green",
  absent: "red",
};

export function AlphabetBoard({ gameId, alphabet, disabled = false }: AlphabetBoardProps) {
  const [optimisticAlphabet, setOptimisticAlphabet] = useState<Partial<Record<string, AlphabetState>>>({});
  const pendingStateRef = useRef(new Map<string, AlphabetState>());
  const inFlightLettersRef = useRef(new Set<string>());

  useEffect(() => {
    setOptimisticAlphabet((current) => {
      let changed = false;
      const next = { ...current };

      for (const letter of ALPHABET) {
        if (pendingStateRef.current.has(letter) || inFlightLettersRef.current.has(letter)) {
          continue;
        }

        if (letter in next) {
          delete next[letter];
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [alphabet]);

  useEffect(() => {
    pendingStateRef.current.clear();
    inFlightLettersRef.current.clear();
    setOptimisticAlphabet({});
  }, [gameId]);

  const setOptimisticLetter = (letter: string, state: AlphabetState | undefined) => {
    setOptimisticAlphabet((current) => {
      if (state === undefined) {
        if (!(letter in current)) {
          return current;
        }

        const next = { ...current };
        delete next[letter];
        return next;
      }

      if (current[letter] === state) {
        return current;
      }

      return {
        ...current,
        [letter]: state,
      };
    });
  };

  const getDisplayedState = (letter: string) => optimisticAlphabet[letter] ?? alphabet[letter] ?? "unknown";

  const persistLetterState = async (letter: string) => {
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
      await api.updateAlphabet(gameId, {
        letter,
        state: desiredState,
      });
    } catch (error) {
      if (!pendingStateRef.current.has(letter)) {
        setOptimisticLetter(letter, undefined);
      }

      toast.error(error instanceof Error ? error.message : "Failed to update alphabet");
    } finally {
      inFlightLettersRef.current.delete(letter);

      if (pendingStateRef.current.has(letter)) {
        void persistLetterState(letter);
      }
    }
  };

  const handleLetterClick = (letter: string) => {
    if (disabled) {
      return;
    }

    const currentState = getDisplayedState(letter);
    const newState = getNextAlphabetState(currentState);
    setOptimisticLetter(letter, newState);
    pendingStateRef.current.set(letter, newState);
    void persistLetterState(letter);
  };

  const getLetterStyle = (letter: string) => {
    const state = getDisplayedState(letter);
    let base = "flex h-9 w-full items-center justify-center rounded border-2 text-xs font-bold font-mono select-none touch-manipulation transition-[background-color,border-color,transform] duration-75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400";

    if (disabled) {
      base += " cursor-not-allowed opacity-40";
    } else {
      base += " cursor-pointer hover:-translate-y-px active:translate-y-0";
    }

    switch (state) {
      case "present":
        return `${base} border-emerald-600 bg-emerald-500 text-white`;
      case "absent":
        return `${base} border-rose-600 bg-rose-500 text-white`;
      default:
        return `${base} border-zinc-300 bg-white text-zinc-700 hover:border-zinc-400`;
    }
  };

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
      {/* Compact header */}
      <div className="border-b border-zinc-100 px-4 py-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-900">Alphabet</h3>
          <span className="text-[11px] font-medium text-zinc-400">tap to mark</span>
        </div>
      </div>

      {/* Letter grid — tile-like feel */}
      <div className="grid grid-cols-7 gap-1.5 p-3">
        {ALPHABET.map((letter) => (
          <button
            key={letter}
            type="button"
            onClick={() => handleLetterClick(letter)}
            disabled={disabled}
            className={getLetterStyle(letter)}
            aria-label={`${letter} is ${STATE_LABELS[getDisplayedState(letter)]}`}
            aria-pressed={getDisplayedState(letter) !== "unknown"}
            title={`${letter}: ${STATE_LABELS[getDisplayedState(letter)]}`}
          >
            {letter}
          </button>
        ))}
      </div>
    </div>
  );
}
