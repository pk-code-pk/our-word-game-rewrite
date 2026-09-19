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
          // Only clear the optimistic value once the server confirms it —
          // if the server still has the old value (stale WS push), keep showing
          // our optimistic state so the letter doesn't flicker back.
          const serverValue = alphabet[letter] ?? "unknown";
          if (serverValue === next[letter]) {
            delete next[letter];
            changed = true;
          }
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
    let newState = getNextAlphabetState(currentState);

    if (newState === "present") {
      const greenCount = ALPHABET.filter((l) => getDisplayedState(l) === "present").length;
      if (greenCount >= 5) {
        newState = "absent";
        toast("Five letters are already marked green, so this one went red instead.", {
          id: "alphabet-green-limit",
        });
      }
    }

    setOptimisticLetter(letter, newState);
    pendingStateRef.current.set(letter, newState);
    void persistLetterState(letter);
  };

  const getLetterStyle = (letter: string) => {
    const state = getDisplayedState(letter);
    let base =
      "flex h-7 w-full items-center justify-center rounded border-2 text-[11px] font-bold font-mono select-none touch-manipulation transition-[background-color,border-color,transform] duration-75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 lg:h-11 lg:text-base lg:rounded-lg";

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
      {/* Header — desktop only */}
      <div className="hidden border-b border-zinc-100 px-4 py-3 lg:flex lg:items-center">
        <h3 className="text-sm font-semibold text-zinc-900">Alphabet</h3>
      </div>

      <div className="grid grid-cols-7 gap-1 p-2 lg:gap-2 lg:p-4">
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

      {/* Legend — caption under the letter grid */}
      <div className="flex flex-col gap-2 border-t border-zinc-100 px-3 py-3 text-xs font-medium text-zinc-600 lg:gap-3 lg:px-5 lg:py-4 lg:text-base">
        <span className="flex items-center gap-2">
          <span className="flex h-6 w-6 shrink-0 rounded border-2 border-emerald-600 bg-emerald-500 lg:h-8 lg:w-8" />
          <span>= letter is in the opponent&apos;s word</span>
        </span>
        <span className="flex items-center gap-2">
          <span className="flex h-6 w-6 shrink-0 rounded border-2 border-rose-600 bg-rose-500 lg:h-8 lg:w-8" />
          <span>= letter is not in the opponent&apos;s word</span>
        </span>
      </div>
    </div>
  );
}
