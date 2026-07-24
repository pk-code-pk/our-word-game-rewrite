import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import confetti from "canvas-confetti";
import { toast } from "sonner";
import { AlphabetBoard } from "./AlphabetBoard";
import { HowToPlay } from "./HowToPlay";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useGameSocket } from "../lib/useGameSocket";
import { useOptimisticAlphabet } from "../lib/useOptimisticAlphabet";

// Lazy-loaded so the ~130 KB word list doesn't enter the initial bundle.
// First guess submission pays the import cost; subsequent ones hit the cache.
let cachedWordValidator: ((word: string, len: 4 | 5) => boolean) | null = null;
async function loadWordValidator() {
  if (!cachedWordValidator) {
    const mod = await import("../../shared/wordBank");
    cachedWordValidator = mod.isAllowedGameWord;
  }
  return cachedWordValidator;
}

interface GameBoardProps {
  gameId: string;
  onExitToMenu: () => void;
}

type OptimisticGuessRow = {
  id: string;
  text: string;
  type: "fourLetter" | "fullWord";
  /** Until submitGuess returns — same moment as the toast gets its numbers */
  pending: boolean;
  matchCount?: number;
  isCorrect?: boolean;
};

export function GameBoard({ gameId, onExitToMenu }: GameBoardProps) {
  const { user } = useAuth();
  const gameStateQuery = useGameSocket(gameId);
  const gameState = gameStateQuery.data?.gameState;
  const [guessText, setGuessText] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [optimisticGuess, setOptimisticGuess] = useState<OptimisticGuessRow | null>(null);
  const [isLeavingWaitingLobby, setIsLeavingWaitingLobby] = useState(false);
  const [guessType, setGuessType] = useState<"fourLetter" | "fullWord">("fourLetter");
  const guessMaxLength = guessType === "fourLetter" ? 4 : 5;

  // Switching modes re-caps the input: picking "4" trims a longer draft so the
  // box always holds at most the mode's length.
  const selectGuessType = (type: "fourLetter" | "fullWord") => {
    setGuessType(type);
    if (type === "fourLetter") {
      setGuessText((prev) => prev.slice(0, 4));
    }
  };
  // Word rearranger: green (confirmed) letters shown as tiles you can shuffle
  // into anagram candidates. Compact + only rendered when it's useful (2+
  // letters), so it costs no vertical space early game.
  const [greenLetterOrder, setGreenLetterOrder] = useState<string[] | null>(null);
  const [committedGreens, setCommittedGreens] = useState<Set<string>>(new Set());
  const greenTileRefs = useRef<Map<number, HTMLSpanElement>>(new Map());
  const flipSnapshotRef = useRef<Map<number, DOMRect> | null>(null);

  const capturePositions = useCallback(() => {
    const snap = new Map<number, DOMRect>();
    greenTileRefs.current.forEach((el, charCode) => {
      snap.set(charCode, el.getBoundingClientRect());
    });
    flipSnapshotRef.current = snap;
  }, []);

  useLayoutEffect(() => {
    const snapshot = flipSnapshotRef.current;
    if (!snapshot || snapshot.size === 0) return;
    flipSnapshotRef.current = null;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    greenTileRefs.current.forEach((el, charCode) => {
      const first = snapshot.get(charCode);
      if (!first) return;
      const last = el.getBoundingClientRect();
      const dx = first.left - last.left;
      const dy = first.top - last.top;
      if (dx === 0 && dy === 0) return;

      el.animate(
        [
          { transform: `translate(${dx}px, ${dy - 12}px) scale(1.08)`, offset: 0 },
          { transform: "translate(0, 0) scale(1)", offset: 1 },
        ],
        { duration: 450, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "none" }
      );
    });
  }, [greenLetterOrder]);

  // Debounce additions: the alphabet cycle is unknown → present → absent, so
  // marking a letter red passes through green; without the delay it would
  // flash into the rearranger. Removals are immediate.
  const pendingGreenTimersRef = useRef<Map<string, number>>(new Map());
  const announcedCompletionRef = useRef<string | null>(null);
  const guessFormRef = useRef<HTMLFormElement | null>(null);
  const guessInputRef = useRef<HTMLInputElement | null>(null);
  const myGuessesRef = useRef<HTMLDivElement | null>(null);
  const keepMyGuessesPinnedRef = useRef(true);
  const latestGameStatusRef = useRef(gameState?.game.status);

  const currentPlayer = gameState?.me;
  const opponent = gameState?.opponent;
  const myGuesses = gameState?.myGuesses ?? [];
  const opponentFoundLetterCount = gameState?.opponentFoundLetterCount ?? null;

  // Shared optimistic alphabet — both AlphabetBoard instances read from the
  // same displayedAlphabet so a click updates everything in the same render.
  const alphabetDisabled = gameState?.game.status !== "active";
  const { displayedAlphabet, toggleLetter } = useOptimisticAlphabet(
    gameId,
    currentPlayer?.alphabet,
    alphabetDisabled
  );

  useEffect(() => {
    const GREEN_COMMIT_DELAY_MS = 600;
    const timers = pendingGreenTimersRef.current;

    setCommittedGreens((prev) => {
      let next: Set<string> | null = null;

      // Drop committed letters that are no longer present.
      for (const letter of prev) {
        if (displayedAlphabet[letter] !== "present") {
          if (!next) next = new Set(prev);
          next.delete(letter);
        }
      }

      for (const letter of Object.keys(displayedAlphabet)) {
        const isPresent = displayedAlphabet[letter] === "present";
        const isCommitted = (next ?? prev).has(letter);
        const hasTimer = timers.has(letter);

        if (isPresent && !isCommitted && !hasTimer) {
          const timer = window.setTimeout(() => {
            timers.delete(letter);
            setCommittedGreens((current) => {
              if (current.has(letter)) return current;
              const updated = new Set(current);
              updated.add(letter);
              return updated;
            });
          }, GREEN_COMMIT_DELAY_MS);
          timers.set(letter, timer);
        } else if (!isPresent && hasTimer) {
          window.clearTimeout(timers.get(letter)!);
          timers.delete(letter);
        }
      }

      return next ?? prev;
    });
  }, [displayedAlphabet]);

  // Clear any in-flight commit timers when the board unmounts.
  useEffect(() => {
    const timers = pendingGreenTimersRef.current;
    return () => {
      for (const timer of timers.values()) {
        window.clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);

  // Clear optimistic guess once the real state catches up. A safety timeout
  // also clears it if the server quietly drops/rejects the guess (e.g. invalid
  // word) and no matching entry ever lands in myGuesses.
  useEffect(() => {
    if (!optimisticGuess) {
      return;
    }
    if (myGuesses.some((g) => g.text === optimisticGuess.text && g.type === optimisticGuess.type)) {
      setOptimisticGuess(null);
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setOptimisticGuess((current) => (current?.id === optimisticGuess.id ? null : current));
    }, 5_000);
    return () => window.clearTimeout(timeoutId);
  }, [myGuesses, optimisticGuess]);

  useEffect(() => {
    latestGameStatusRef.current = gameState?.game.status;
  }, [gameState?.game.status]);

  // Warm the ~130KB word-list chunk as soon as the board mounts so the first
  // submit isn’t blocked on dynamic import (dictionary checks are local Sets).
  useEffect(() => {
    void loadWordValidator();
  }, []);

  useEffect(() => {
    if (gameState?.game.status === "completed") {
      if (announcedCompletionRef.current === gameState.game.id) {
        return;
      }
      announcedCompletionRef.current = gameState.game.id;

      const winner =
        gameState.game.winnerId === currentPlayer?.id
          ? currentPlayer
          : gameState.game.winnerId === opponent?.id
          ? opponent
          : null;
      if (winner) {
        toast.success(`Game Over! ${winner.username} wins!`);
        if (winner.id === currentPlayer?.id) {
          confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } });
        } else if (currentPlayer?.id) {
          setTimeout(() => {
            toast("So close!", {
              description: "Better luck next time!",
              duration: 4000,
            });
          }, 1000);
        }
      }
    }
  }, [currentPlayer, gameState?.game.id, gameState?.game.status, gameState?.game.winnerId, opponent]);

  useLayoutEffect(() => {
    if (gameState?.game.status !== "active") {
      return;
    }

    const effectiveCount = myGuesses.length + (optimisticGuess ? 1 : 0);
    if (shouldPinGuessPane(effectiveCount, keepMyGuessesPinnedRef.current)) {
      scrollGuessPaneToBottom(myGuessesRef.current);
    }
  }, [gameState?.game.status, myGuesses.length, optimisticGuess]);

  useEffect(() => {
    if (!currentPlayer) {
      return;
    }

    const markOffline = () => {
      if (latestGameStatusRef.current === "completed") {
        return;
      }

      void api.markGamePresenceOffline(gameId, { keepalive: true }).catch(() => {});
    };

    window.addEventListener("pagehide", markOffline);

    return () => {
      window.removeEventListener("pagehide", markOffline);
      markOffline();
    };
  }, [currentPlayer?.id, gameId]);

  // Mobile keyboard: intentionally hands-off. iOS natively pans the page so
  // the focused input sits above the keyboard, and every scripted "assist" we
  // tried (scrollIntoView nudges, viewport listeners) fought that pan and read
  // as a bounce. Native behavior wins.

  const handleSubmitGuess = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentPlayer || !guessText.trim() || isSubmitting) return;

    const word = guessText.trim().toUpperCase();
    const expectedLength = guessType === "fourLetter" ? 4 : 5;
    if (word.length !== expectedLength) {
      toast.error(`${guessType === "fourLetter" ? "Four-letter" : "Full word"} guesses must be exactly ${expectedLength} letters`);
      return;
    }

    // Short-circuit obvious junk before the server roundtrip. The server still
    // has its own dictionary check; this just avoids a flicker on misspells.
    const validate = await loadWordValidator();
    if (!validate(word, expectedLength)) {
      toast.error("Not a valid word");
      return;
    }

    // Show the word in the list immediately; fill matchCount/isCorrect from the same
    // API response as the toast (no need to wait for WebSocket gameState).
    setOptimisticGuess({ id: `opt-${Date.now()}`, text: word, type: guessType, pending: true });
    setGuessText("");
    keepMyGuessesPinnedRef.current = true;
    window.requestAnimationFrame(() => {
      guessInputRef.current?.focus({ preventScroll: true });
    });

    setIsSubmitting(true);
    try {
      const result = await gameStateQuery.submitGuess({ type: guessType, text: word });
      setOptimisticGuess((row) =>
        row && row.text === word && row.type === guessType
          ? { ...row, pending: false, matchCount: result.matchCount, isCorrect: result.isCorrect }
          : row
      );
      if (result.isCorrect) {
        toast.success("You guessed it!");
      } else if (guessType === "fullWord") {
        toast("Not the word.");
      } else {
        toast(
          `${result.matchCount} letter${result.matchCount !== 1 ? "s" : ""} match${result.matchCount === 1 ? "es" : ""}`
        );
      }
    } catch (error) {
      setOptimisticGuess(null);
      setGuessText(word);
      toast.error(error instanceof Error ? error.message : "Failed to submit guess");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleExit = async () => {
    if (!isWaitingForOpponent) {
      onExitToMenu();
      return;
    }

    if (isLeavingWaitingLobby) {
      return;
    }

    setIsLeavingWaitingLobby(true);
    try {
      await api.leaveWaitingGame(gameId);
      toast.success("Waiting lobby cancelled.");
      setIsLeavingWaitingLobby(false);
      onExitToMenu();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to cancel the waiting lobby.";
      if (/only waiting lobbies can be cancelled|game already started or completed|game is not active/i.test(message)) {
        toast(message, {
          description: "This lobby may have filled while you were leaving. We'll keep you in the match.",
        });
      } else {
        toast.error(message);
      }
      setIsLeavingWaitingLobby(false);
    }
  };

  if (gameStateQuery.loading && !gameState) {
    return (
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 space-y-4 rounded-xl border border-zinc-200 bg-white p-6">
          <div className="h-6 w-40 animate-pulse rounded-full bg-zinc-100" />
          <div className="h-4 w-64 animate-pulse rounded-full bg-zinc-100" />
          <div className="grid gap-4 md:grid-cols-2">
            <div className="h-40 animate-pulse rounded-xl bg-zinc-100" />
            <div className="h-40 animate-pulse rounded-xl bg-zinc-100" />
          </div>
          <div className="h-24 animate-pulse rounded-xl bg-zinc-100" />
        </div>
        <div className="min-w-0 lg:sticky lg:top-16 lg:self-start">
          <div className="h-64 animate-pulse rounded-xl border border-zinc-200 bg-white" />
        </div>
      </div>
    );
  }

  if (!gameState || !currentPlayer) {
    return (
      <div className="mx-auto max-w-md rounded-xl border border-zinc-200 bg-white p-8 text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-rose-100 text-2xl">
          !
        </div>
        <h2 className="text-2xl font-black tracking-tight text-zinc-900">Game not available</h2>
        <button
          onClick={onExitToMenu}
          className="mt-6 inline-flex items-center justify-center rounded-lg bg-zinc-900 px-6 py-3 font-semibold text-white shadow-sm transition hover:bg-zinc-800"
        >
          Back to lobby
        </button>
      </div>
    );
  }

  const isGameActive = gameState.game.status === "active";
  const isWaitingForOpponent = gameState.game.status === "waiting";
  const queryError = gameStateQuery.error;

  return (
    <div className="flex flex-1 flex-col lg:grid lg:flex-none lg:grid-cols-[minmax(0,1fr)_400px] lg:gap-5">
      <div className="flex min-w-0 flex-1 flex-col gap-3 rounded-xl border border-zinc-200 bg-white px-3 pb-3 pt-2 sm:px-4 sm:pb-4 sm:pt-2 lg:block lg:flex-none lg:space-y-5 lg:px-6 lg:pb-6 lg:pt-4">
        {queryError && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
            Connection issue. Retrying...
          </div>
        )}

        {isWaitingForOpponent && (
          <div className="rounded-lg border border-zinc-200 bg-white p-5 text-center shadow-sm">
            <div className="animate-pulse text-base font-medium text-zinc-600">Matching you with an opponent...</div>
            <div className="mt-1 text-sm text-zinc-500">
              We'll pair you with the next player online. Share this code to invite someone directly:
            </div>
            <div className="mt-2 font-mono text-sm font-semibold tracking-widest text-zinc-500">{gameState.game.code}</div>
            <button
              onClick={() => void handleExit()}
              disabled={isLeavingWaitingLobby}
              className="mt-4 inline-flex min-h-11 items-center justify-center rounded-lg border border-zinc-200 bg-white px-4 text-sm font-medium text-zinc-600 transition hover:bg-zinc-50 active:scale-[0.98]"
            >
              {isLeavingWaitingLobby ? "Cancelling..." : "Cancel waiting lobby"}
            </button>
          </div>
        )}

        {opponent && gameState.game.status === "completed" && (
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 shadow-sm">
              <h3 className="text-center text-sm font-semibold text-zinc-700">
                Your secret word {currentPlayer.id === gameState.game.winnerId && "🎉"}
              </h3>
              <p className="mt-4 text-center font-mono text-3xl font-black tracking-widest text-zinc-900">
                {currentPlayer.secretWord}
              </p>
            </div>
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 shadow-sm">
              <h3 className="text-center text-sm font-semibold text-zinc-700">
                {opponent.username}'s secret word {opponent.id === gameState.game.winnerId && "🎉"}
              </h3>
              <p className="mt-4 text-center font-mono text-3xl font-black tracking-widest text-zinc-900">
                {opponent.secretWord}
              </p>
            </div>
          </div>
        )}

        {opponent && (
          <div className="flex flex-1 flex-col gap-3 lg:block lg:space-y-5">
            {/* Status row doubles as the nav row: back button lives inline so it
                doesn't cost a whole row of vertical space on mobile. */}
            <div className="flex shrink-0 items-center gap-2">
              <button
                onClick={() => void handleExit()}
                className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl border border-zinc-200 bg-white text-zinc-600 transition hover:bg-zinc-50 active:scale-[0.96]"
                aria-label="Back to menu"
                title="Back to menu"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
                  <path d="m15 18-6-6 6-6" />
                </svg>
              </button>
              <section className="min-w-0 flex-1 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-2 lg:px-6 lg:py-4">
                <p className="truncate text-center text-sm font-medium text-zinc-700 lg:text-base">
                  <span className="font-semibold">{opponent.username}</span> found{" "}
                  <span className="font-black text-emerald-700">{opponentFoundLetterCount ?? 0}</span> of your letters
                </p>
              </section>
              <HowToPlay variant="icon" />
            </div>

            {(() => {
              const sorted = Array.from(committedGreens)
                .map((letter) => letter.toUpperCase())
                .sort();
              // Not useful below 2 letters — render nothing and give the space
              // back to the guess history.
              if (sorted.length < 2) return null;
              const displayed =
                greenLetterOrder &&
                greenLetterOrder.length === sorted.length &&
                [...greenLetterOrder].sort().join("") === sorted.join("")
                  ? greenLetterOrder
                  : sorted;
              const shuffle = () => {
                capturePositions();
                const arr = [...sorted];
                for (let i = arr.length - 1; i > 0; i--) {
                  const j = Math.floor(Math.random() * (i + 1));
                  [arr[i], arr[j]] = [arr[j], arr[i]];
                }
                setGreenLetterOrder(arr);
              };
              return (
                <section className="flex shrink-0 items-center gap-1.5 rounded-xl border border-zinc-200 bg-emerald-50 px-3 py-1.5 lg:px-6 lg:py-3 lg:gap-2.5">
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 lg:gap-2.5">
                    {displayed.map((letter) => (
                      <span
                        key={letter}
                        ref={(el) => {
                          if (el) greenTileRefs.current.set(letter.charCodeAt(0), el);
                          else greenTileRefs.current.delete(letter.charCodeAt(0));
                        }}
                        className="inline-flex h-9 min-w-9 items-center justify-center rounded-md border-2 border-emerald-600 bg-emerald-500 px-1.5 font-mono text-base font-bold tracking-widest text-white lg:h-11 lg:min-w-[3rem] lg:text-xl"
                      >
                        {letter}
                      </span>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={shuffle}
                    className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md border border-emerald-300 bg-white text-emerald-700 shadow-sm transition-colors hover:bg-emerald-50 active:scale-[0.94] active:bg-emerald-100"
                    aria-label="Shuffle letters"
                    title="Shuffle letters"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]">
                      <path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H20" />
                      <path d="m18 2 4 4-4 4" />
                      <path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2" />
                      <path d="M20 18h-3.9c-1.3 0-2.5-.6-3.3-1.7l-.5-.8" />
                      <path d="m18 14 4 4-4 4" />
                    </svg>
                  </button>
                </section>
              );
            })()}

            <section className="flex flex-1 flex-col lg:block lg:flex-none">
              <GuessColumn
                title="My guesses"
                elementId="my-guesses"
                guesses={myGuesses}
                optimisticGuess={optimisticGuess}
                emptyText="No guesses yet"
                scrollRef={myGuessesRef}
                onScroll={() => {
                  keepMyGuessesPinnedRef.current = isNearBottom(myGuessesRef.current);
                }}
              />
            </section>

            {/* Alphabet — the letter-marking board. It sits ABOVE the composer so the
                composer stays pinned to the bottom of the screen; when it's focused the
                mobile keyboard opens directly beneath it (no page scroll / jump). */}
            <div className="shrink-0 lg:hidden">
              <AlphabetBoard
                displayedAlphabet={displayedAlphabet}
                onToggleLetter={toggleLetter}
                disabled={!isGameActive}
              />
            </div>

            {isGameActive && (
              <form
                ref={guessFormRef}
                onSubmit={handleSubmitGuess}
                className="shrink-0 space-y-2.5 rounded-xl border border-zinc-200 bg-zinc-50 p-3"
              >
                <div className="flex items-center gap-2">
                  <input
                    ref={guessInputRef}
                    type="text"
                    value={guessText}
                    onChange={(e) =>
                      setGuessText(e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, guessMaxLength))
                    }
                    placeholder={guessType === "fourLetter" ? "4-letter guess" : "5-letter guess"}
                    maxLength={guessMaxLength}
                    autoCapitalize="characters"
                    spellCheck={false}
                    className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-4 py-2.5 font-mono text-[16px] tracking-widest text-zinc-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 disabled:bg-zinc-50"
                    disabled={isSubmitting}
                  />
                  <button
                    type="submit"
                    disabled={!guessText.trim() || isSubmitting || guessText.length !== guessMaxLength}
                    className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg bg-zinc-900 text-lg font-bold text-white transition hover:bg-zinc-800 active:scale-95 disabled:opacity-40"
                    aria-label="Submit guess"
                  >
                    {isSubmitting ? "…" : "↑"}
                  </button>
                </div>
                <div className="grid grid-cols-2 rounded-lg bg-zinc-100 p-0.5">
                  <button
                    type="button"
                    onClick={() => selectGuessType("fourLetter")}
                    disabled={isSubmitting}
                    className={`inline-flex min-h-11 items-center justify-center rounded-md border px-3 py-2 text-sm font-semibold transition active:scale-[0.98] ${
                      guessType === "fourLetter"
                        ? "border-zinc-900 bg-white text-zinc-900 shadow-sm"
                        : "border-transparent text-zinc-700 hover:border-zinc-200 hover:bg-white/70"
                    }`}
                    aria-pressed={guessType === "fourLetter"}
                  >
                    4-letter guess
                  </button>
                  <button
                    type="button"
                    onClick={() => selectGuessType("fullWord")}
                    disabled={isSubmitting}
                    className={`inline-flex min-h-11 items-center justify-center rounded-md border px-3 py-2 text-sm font-semibold transition active:scale-[0.98] ${
                      guessType === "fullWord"
                        ? "border-zinc-900 bg-white text-zinc-900 shadow-sm"
                        : "border-transparent text-zinc-700 hover:border-zinc-200 hover:bg-white/70"
                    }`}
                    aria-pressed={guessType === "fullWord"}
                  >
                    5-letter guess
                  </button>
                </div>
              </form>
            )}
          </div>
        )}

        {gameState.game.status === "completed" && (
          <div className="flex justify-center">
            <button
              onClick={onExitToMenu}
              className="inline-flex w-full items-center justify-center rounded-lg bg-emerald-600 px-5 py-2.5 font-semibold text-white transition hover:bg-emerald-700 sm:w-auto"
            >
              Play again
            </button>
          </div>
        )}
      </div>

      <div className="min-w-0 lg:sticky lg:top-16 lg:self-start hidden lg:block">
        <AlphabetBoard
                displayedAlphabet={displayedAlphabet}
                onToggleLetter={toggleLetter}
                disabled={!isGameActive}
              />
      </div>
    </div>
  );
}

function GuessColumn(props: {
  title: string;
  elementId: string;
  guesses: Array<{
    id: string;
    text: string;
    type: "fourLetter" | "fullWord";
    matchCount: number;
    isCorrect: boolean;
  }>;
  optimisticGuess?: OptimisticGuessRow | null;
  emptyText: string;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onScroll: React.UIEventHandler<HTMLDivElement>;
}) {
  // Skip the optimistic row once the committed server guess with the same
  // text+type has landed. There's a brief window where the server row arrives
  // before the parent's clearing effect runs; without this guard both rows
  // render together and the list flickers with a duplicate.
  const optimistic = props.optimisticGuess;
  const optimisticAlreadyCommitted =
    optimistic != null &&
    props.guesses.some((g) => g.text === optimistic.text && g.type === optimistic.type);
  const allGuesses =
    optimistic && !optimisticAlreadyCommitted
      ? [
          ...props.guesses,
          {
            ...optimistic,
            matchCount: optimistic.matchCount ?? 0,
            isCorrect: optimistic.isCorrect ?? false,
          },
        ]
      : props.guesses;

  return (
    <div className="flex min-h-[7.5rem] min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white p-3 shadow-sm lg:min-h-0 lg:flex-none lg:p-5">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-700 lg:text-base">{props.title}</h3>
        <span className="text-sm font-semibold text-zinc-700 lg:text-base"># of letters in opponent&apos;s word</span>
      </div>
      <div
        ref={props.scrollRef}
        id={props.elementId}
        onScroll={props.onScroll}
        className="min-h-[5rem] flex-1 space-y-2 overflow-y-scroll overscroll-y-contain pr-1 lg:h-[min(14rem,28dvh)] lg:min-h-0 lg:flex-none"
        style={{ scrollbarGutter: "stable both-edges", overflowAnchor: "none" }}
      >
        {allGuesses.length === 0 ? (
          <p className="text-sm leading-6 text-zinc-400">{props.emptyText}</p>
        ) : (
          allGuesses.map((guess) => (
            <div
              key={guess.id}
              className={`guess-row-enter flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm transition-opacity lg:px-4 lg:py-3 lg:text-base ${"pending" in guess && guess.pending === true ? "bg-zinc-100 opacity-60" : "bg-zinc-50"}`}
            >
              <span className="font-mono font-bold tracking-widest text-zinc-900">
                {guess.text} {guess.type === "fullWord" && "🎯"}
              </span>
              {"pending" in guess && guess.pending === true ? (
                <span className="text-xs text-zinc-400">...</span>
              ) : (
                renderGuessResult(guess)
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function renderGuessResult(guess: { isCorrect: boolean; type: "fourLetter" | "fullWord"; matchCount: number }) {
  if (guess.isCorrect) {
    return <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800">Correct</span>;
  }
  if (guess.type === "fullWord") {
    return <span className="rounded-full bg-rose-100 px-2.5 py-1 text-xs font-semibold text-rose-800">Wrong word</span>;
  }
  return (
    <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-semibold text-zinc-700">
      {guess.matchCount}
    </span>
  );
}

function shouldPinGuessPane(guessCount: number, wasPinned: boolean) {
  return guessCount <= 1 || wasPinned;
}

function scrollGuessPaneToBottom(element: HTMLDivElement | null) {
  if (!element) {
    return;
  }

  element.scrollTop = element.scrollHeight;
}

function isNearBottom(element: HTMLDivElement | null, threshold = 28) {
  if (!element) {
    return true;
  }

  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
}

