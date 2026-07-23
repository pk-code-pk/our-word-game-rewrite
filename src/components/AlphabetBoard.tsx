import type { AlphabetState } from "../../shared/types";

interface AlphabetBoardProps {
  displayedAlphabet: Record<string, AlphabetState>;
  onToggleLetter: (letter: string) => void;
  disabled?: boolean;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const STATE_LABELS: Record<AlphabetState, string> = {
  unknown: "blank",
  present: "green",
  absent: "red",
};

export function AlphabetBoard({ displayedAlphabet, onToggleLetter, disabled = false }: AlphabetBoardProps) {
  const getLetterStyle = (letter: string) => {
    const state = displayedAlphabet[letter] ?? "unknown";
    let base =
      "flex min-h-11 w-full items-center justify-center rounded border-2 text-[11px] font-bold font-mono select-none touch-manipulation transition-[background-color,border-color,transform] duration-75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 lg:h-11 lg:text-base lg:rounded-lg";

    if (disabled) {
      base += " cursor-not-allowed opacity-40";
    } else {
      base += " cursor-pointer hover:-translate-y-px active:translate-y-0";
    }

    switch (state) {
      case "present":
        // Non-color cue (colorblind-safe): underline distinguishes "present"
        // from "absent" without relying on the green/red fill alone.
        return `${base} border-emerald-600 bg-emerald-500 text-white underline decoration-2 underline-offset-2`;
      case "absent":
        // Non-color cue: strikethrough marks the letter as ruled out.
        return `${base} border-rose-600 bg-rose-500 text-white line-through decoration-2`;
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
        {ALPHABET.map((letter) => {
          const state = displayedAlphabet[letter] ?? "unknown";
          return (
            <button
              key={letter}
              type="button"
              onClick={() => onToggleLetter(letter)}
              disabled={disabled}
              className={getLetterStyle(letter)}
              aria-label={`${letter} is ${STATE_LABELS[state]}`}
              aria-pressed={state !== "unknown"}
              title={`${letter}: ${STATE_LABELS[state]}`}
            >
              {letter}
            </button>
          );
        })}
      </div>

      {/* Legend — caption under the letter grid */}
      <div className="flex flex-col gap-2 border-t border-zinc-100 px-3 py-3 text-xs font-medium text-zinc-600 lg:gap-3 lg:px-5 lg:py-4 lg:text-base">
        <span className="flex items-center gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded border-2 border-emerald-600 bg-emerald-500 font-mono text-xs font-bold text-white underline decoration-2 underline-offset-2 lg:h-8 lg:w-8" aria-hidden="true">A</span>
          <span>= letter is in the opponent&apos;s word</span>
        </span>
        <span className="flex items-center gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded border-2 border-rose-600 bg-rose-500 font-mono text-xs font-bold text-white line-through decoration-2 lg:h-8 lg:w-8" aria-hidden="true">A</span>
          <span>= letter is not in the opponent&apos;s word</span>
        </span>
      </div>
    </div>
  );
}
