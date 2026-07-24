import { useState } from "react";
import { SocialOverlay } from "./social/SocialOverlay";

interface HowToPlayProps {
  /** Renders as a full "How to play" button when true (lobby), an icon-only "?" otherwise (in-game header). */
  variant?: "full" | "icon";
  forceOpen?: boolean;
  onForceOpenConsumed?: () => void;
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
          className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-50 active:scale-[0.98]"
        >
          <span aria-hidden="true">❓</span> How to play
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="How to play"
          title="How to play"
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900 text-sm font-bold text-white transition hover:bg-zinc-800 active:scale-95"
        >
          ?
        </button>
      )}

      <SocialOverlay
        open={isOpen}
        onClose={close}
        eyebrow="FourFive"
        title="How to play"
        subtitle="Guess your opponent's secret word before they guess yours."
        size="md"
      >
        <div className="space-y-5 text-sm leading-6 text-zinc-700">
          <section>
            <h3 className="mb-1.5 text-sm font-bold text-zinc-900">1. Pick a secret word</h3>
            <p>
              Choose a real 5-letter word with <span className="font-semibold">no repeated letters</span> (e.g.{" "}
              <span className="font-mono font-semibold">CRANE</span>, not{" "}
              <span className="font-mono font-semibold">SASSY</span>). Your opponent picks one too — neither of you sees
              the other's word until the game ends.
            </p>
          </section>

          <section>
            <h3 className="mb-1.5 text-sm font-bold text-zinc-900">2. Guess two ways</h3>
            <div className="space-y-2">
              <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
                <p className="font-semibold text-zinc-900">4-letter probe</p>
                <p className="mt-0.5">
                  Type any 4-letter word. You'll learn how many of its <span className="font-semibold">distinct
                  letters</span> appear <span className="font-semibold">anywhere</span> in the opponent's word — not
                  which ones, and not their position. Use this to narrow things down.
                </p>
              </div>
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                <p className="font-semibold text-emerald-800">5-letter final answer</p>
                <p className="mt-0.5">
                  Type your full guess for their word. Get it exactly right and you <span className="font-semibold">win
                  instantly</span>. Wrong, and you get no hint back — so save this for when you're confident.
                </p>
              </div>
            </div>
          </section>

          <section>
            <h3 className="mb-1.5 text-sm font-bold text-zinc-900">3. Track your deductions</h3>
            <p>
              Tap letters on the alphabet board to mark them{" "}
              <span className="font-semibold text-emerald-700">green</span> (in the word) or{" "}
              <span className="font-semibold text-rose-700">red</span> (not in the word) — this is just your personal
              notepad, it doesn't affect the game. Once you've marked 2 or more green letters, a rearranger appears so
              you can shuffle them into possible orders.
            </p>
          </section>

          <section>
            <h3 className="mb-1.5 text-sm font-bold text-zinc-900">4. First correct guess wins</h3>
            <p>
              The first player to correctly guess the opponent's full word wins the match. There's no limit on how many
              probes either player can send.
            </p>
          </section>
        </div>
      </SocialOverlay>
    </>
  );
}
