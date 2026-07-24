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

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-[11px] font-semibold uppercase tracking-[0.24em] text-zinc-400">{children}</h3>
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
        <div className="space-y-7">
          <section className="space-y-2.5">
            <SectionLabel>The setup</SectionLabel>
            <p className="text-sm leading-6 text-zinc-600">
              Both players lock in a real five-letter word — five{" "}
              <span className="font-semibold text-zinc-900">different</span> letters, no repeats. Words stay hidden
              until the match ends.
            </p>
            <Word word="CRANE" />
          </section>

          <section className="space-y-2.5">
            <SectionLabel>Probe with four letters</SectionLabel>
            <p className="text-sm leading-6 text-zinc-600">
              A four-letter word is a question. The answer is a single number: how many of its letters appear{" "}
              <span className="font-semibold text-zinc-900">anywhere</span> in their word. Never which ones, never
              where.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Word word="PORK" />
              <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-semibold text-zinc-700">
                1 letter matches
              </span>
            </div>
            <p className="text-sm leading-6 text-zinc-500">
              One of P, O, R, K is in their word — narrowing it down is the whole game.
            </p>
          </section>

          <section className="space-y-2.5">
            <SectionLabel>Solve with five</SectionLabel>
            <p className="text-sm leading-6 text-zinc-600">
              A five-letter guess goes for the win. Exactly right ends the match on the spot. A miss tells you{" "}
              <span className="font-semibold text-zinc-900">nothing</span> — solve when you're sure, not when you're
              curious.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Word word="SLATE" tone="green" />
              <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800">
                Correct — you win
              </span>
            </div>
          </section>

          <section className="space-y-2.5">
            <SectionLabel>Mark your board</SectionLabel>
            <p className="text-sm leading-6 text-zinc-600">
              Tap the alphabet to keep notes: <Tile tone="green">A</Tile> means you believe it's in their word,{" "}
              <Tile tone="red">B</Tile> means ruled out. It's a private notepad — it doesn't affect the game. Mark two
              or more letters green and a shuffle bar appears to help you rearrange them into candidate words.
            </p>
          </section>

          <section className="space-y-2.5">
            <SectionLabel>Winning</SectionLabel>
            <p className="text-sm leading-6 text-zinc-600">
              First correct solve takes the match. Probes are unlimited — the best players just need fewer of them.
            </p>
          </section>
        </div>
      </SocialOverlay>
    </>
  );
}
