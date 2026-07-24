import { useState, type ReactNode } from "react";
import { SocialOverlay } from "./social/SocialOverlay";

interface HowToPlayProps {
  /** "full" renders a quiet text button (lobby); "icon" a compact ? button (in-game header). */
  variant?: "full" | "icon";
  forceOpen?: boolean;
  onForceOpenConsumed?: () => void;
}

// Mini letter tiles, styled exactly like the game's alphabet/rearranger tiles,
// so the rules teach with the same visual vocabulary the board uses.
function Tile({ tone = "neutral", children }: { tone?: "neutral" | "green" | "red"; children: ReactNode }) {
  const tones = {
    neutral: "border-zinc-300 bg-white text-zinc-800",
    green: "border-emerald-600 bg-emerald-500 text-white",
    red: "border-rose-600 bg-rose-500 text-white",
  } as const;
  return (
    <span
      aria-hidden="true"
      className={`inline-flex h-8 w-8 items-center justify-center rounded-md border-2 align-middle font-mono text-sm font-bold ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

function Word({ word, tone = "neutral" }: { word: string; tone?: "neutral" | "green" | "red" }) {
  return (
    <span className="inline-flex gap-1" role="img" aria-label={word}>
      {word.split("").map((letter, i) => (
        <Tile key={i} tone={tone}>
          {letter}
        </Tile>
      ))}
    </span>
  );
}

export function HowToPlay({ variant = "full", forceOpen, onForceOpenConsumed }: HowToPlayProps) {
  const [open, setOpen] = useState(false);
  const isOpen = open || Boolean(forceOpen);

  const close = () => {
    setOpen(false);
    onForceOpenConsumed?.();
  };

  return (
    <>
      {variant === "full" ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-sm font-semibold text-zinc-500 underline decoration-zinc-300 underline-offset-4 transition hover:text-zinc-900 hover:decoration-zinc-500"
        >
          How to play
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="How to play"
          title="How to play"
          className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl border border-zinc-200 bg-white font-mono text-sm font-bold text-zinc-600 transition hover:bg-zinc-50 active:scale-[0.96]"
        >
          ?
        </button>
      )}

      <SocialOverlay
        open={isOpen}
        onClose={close}
        eyebrow="FourFive"
        title="How to play"
        subtitle="Guess your opponent's five-letter word before they guess yours."
        size="md"
      >
        <div className="space-y-6">
          <ul className="list-disc space-y-2 pl-5 text-sm leading-6 text-zinc-700">
            <li>Both players pick a secret 5-letter word. No repeated letters.</li>
            <li>Guess 4-letter words to get clues about their word.</li>
            <li>Guess their full 5-letter word to win.</li>
          </ul>

          <div className="space-y-5">
            <p className="text-sm font-bold text-zinc-900">Examples</p>

            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-3">
                <Word word="PORK" />
                <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-semibold text-zinc-700">1</span>
              </div>
              <p className="text-sm leading-6 text-zinc-700">
                <span className="font-bold text-zinc-900">1</span> of these letters is in their word. It doesn't say
                which one, or where.
              </p>
            </div>

            <div className="space-y-2">
              <Word word="SLATE" tone="green" />
              <p className="text-sm leading-6 text-zinc-700">
                Guess their exact word and you <span className="font-bold text-zinc-900">win instantly</span>. A wrong
                5-letter guess tells you nothing.
              </p>
            </div>

            <div className="space-y-2">
              <span className="inline-flex gap-1">
                <Tile tone="green">A</Tile>
                <Tile tone="red">B</Tile>
              </span>
              <p className="text-sm leading-6 text-zinc-700">
                Tap the alphabet to take notes: green means in their word, red means ruled out. Notes are private and
                don't affect the game.
              </p>
            </div>
          </div>
        </div>
      </SocialOverlay>
    </>
  );
}
