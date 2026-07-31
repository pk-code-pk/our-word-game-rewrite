import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import confetti from "canvas-confetti";
import { toast } from "sonner";
import { AlphabetBoard } from "./AlphabetBoard";
import { HowToPlay } from "./HowToPlay";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useGameSocket } from "../lib/useGameSocket";
import { useOptimisticAlphabet } from "../lib/useOptimisticAlphabet";
import { GUESS_COOLDOWN_MS } from "../../shared/gameLogic";

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

// Extra hold on top of the server cooldown to absorb request latency, so the
// client never permits a guess the server will reject for pacing.
const SUBMIT_LOCK_MARGIN_MS = 150;

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
  // Synchronous double-submit lock: pointerdown-submit plus a surviving
  // click/form-submit can both fire in the same tick, before the async
  // isSubmitting state has re-rendered.
  const submitLockRef = useRef(false);
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

  // Desktop power-shortcut: hold Shift and press a letter key to cycle its
  // mark on the alphabet board, no mouse travel needed. Works even while the
  // guess input is focused (capitals are never legitimate input there — the
  // field uppercases everything anyway), but never steals keys from other
  // text fields like chat or social search.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Desktop-only: on mobile the on-screen keyboard can emit shifted keys
      // (auto-caps etc.) and there's a tappable alphabet right there anyway.
      if (window.innerWidth < 1024) return;
      if (!e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!/^[a-zA-Z]$/.test(e.key)) return;
      const active = document.activeElement;
      const isTextField = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
      if (isTextField && active !== guessInputRef.current) return;
      e.preventDefault();
      toggleLetter(e.key.toUpperCase());
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleLetter]);

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

  // Mobile keyboard: hands-off while it's OPEN (iOS's native pan is the smooth
  // path; scripted corrections during the animation read as a bounce). But iOS
  // has a known bug (widely reported against iOS 26 Safari/WebView: Apple
  // forums threads 800154/800125) where CLOSING the keyboard fails to reset
  // the viewport pan, leaving the page stuck scrolled up with a blank gap
  // under the composer. Community-consensus fix: correct ONCE at the
  // keyboard-dismiss boundary (focusout), after the dismiss animation, with a
  // scroll reset plus a 1px scroll nudge that forces Safari to recompute
  // fixed/layout positioning.
  const handleGuessInputBlur = () => {
    if (window.innerWidth >= 1024) {
      return;
    }
    const vv = window.visualViewport;
    if (!vv) {
      return;
    }

    // HANDS OFF during the dismissal: iOS's own scroll-restore animation is
    // smooth, and correcting at blur time shifted the whole page (header pop /
    // flash at the top). With the page background now one uniform color, the
    // overscroll region iOS exposes during the animation is indistinguishable
    // from the page, so there is nothing to hide. The only thing left to
    // repair is the documented iOS bug where the restore never happens: after
    // the viewport is back to full height and iOS has had time to finish, if
    // the pan/scroll is still stuck, snap it back with the recompute nudge.
    const cleanup = () => {
      vv.removeEventListener("resize", onRestored);
      window.clearTimeout(fallbackTimer);
    };
    const fixIfStuck = () => {
      const active = document.activeElement;
      // Focus moved to another field: keyboard is still up, don't touch.
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
      if (vv.scale !== 1) return; // never yank a pinch-zoomed viewport
      if (Math.max(vv.offsetTop, window.scrollY) < 1) return;
      window.scrollTo(0, 0);
      window.scrollBy(0, -1);
      window.scrollBy(0, 1);
    };
    const onRestored = () => {
      if (vv.height >= window.innerHeight - 60) {
        cleanup();
        // Give iOS's own restore animation time to finish before judging it stuck.
        window.setTimeout(fixIfStuck, 300);
      }
    };
    vv.addEventListener("resize", onRestored);
    const fallbackTimer = window.setTimeout(() => {
      cleanup();
      fixIfStuck();
    }, 900);
  };

  const submitCurrentGuess = async () => {
    if (!currentPlayer || !guessText.trim() || isSubmitting || submitLockRef.current) return;
    submitLockRef.current = true;
    // Hold the lock for the server's own cooldown, imported rather than
    // hardcoded. When this was a local 400ms it was shorter than the server's
    // window, so a second guess inside the gap was accepted by the UI and then
    // always rejected — which the player saw as the guess disappearing.
    //
    // The margin keeps the client strictly the stricter of the two. The server
    // measures its cooldown from when it *recorded* the previous guess, which
    // is later than when we sent it by however long the round trip took, so an
    // exactly-at-cooldown submit can still land inside the server's window.
    window.setTimeout(() => {
      submitLockRef.current = false;
    }, GUESS_COOLDOWN_MS + SUBMIT_LOCK_MARGIN_MS);

    const word = guessText.trim().toUpperCase();
    const expectedLength = guessType === "fourLetter" ? 4 : 5;
    if (word.length !== expectedLength) {
      toast.error(`${guessType === "fourLetter" ? "Four-letter" : "Full word"} guesses must be exactly ${expectedLength} letters`);
      return;
    }

    // Local dictionary check is BEST-EFFORT: only when the word-list chunk is
    // already loaded. Awaiting the ~130KB import here made submits randomly
    // slow (instant when warm, visibly delayed on cold/slow networks). The
    // server validates regardless, and the catch path below already rolls the
    // optimistic row back and restores the text on rejection.
    if (cachedWordValidator && !cachedWordValidator(word, expectedLength)) {
      toast.error("Not a valid word");
      return;
    }
    void loadWordValidator(); // keep warming for the next guess

    // Show the word in the list immediately; fill matchCount/isCorrect from the same
    // API response as the toast (no need to wait for WebSocket gameState).
    setOptimisticGuess({ id: `opt-${Date.now()}`, text: word, type: guessType, pending: true });
    setGuessText("");
    keepMyGuessesPinnedRef.current = true;
    if (window.innerWidth < 1024) {
      // Mobile: dismiss the keyboard after a guess, synchronously so the
      // keyboard-Go path and the submit-button path are frame-identical.
      // (Re-focusing here compounded iOS pans; and the next action after a
      // guess is marking letters on the alphabet the keyboard was covering.)
      guessInputRef.current?.blur();
    } else {
      // Desktop: keep focus so the next guess can be typed immediately.
      window.requestAnimationFrame(() => {
        guessInputRef.current?.focus({ preventScroll: true });
      });
    }

    setIsSubmitting(true);
    try {
      const result = await gameStateQuery.submitGuess({ type: guessType, text: word });
      setOptimisticGuess((row) =>
        row && row.text === word && row.type === guessType
          ? { ...row, pending: false, matchCount: result.matchCount, isCorrect: result.isCorrect }
          : row
      );
      // On mobile the toast otherwise enters during the keyboard-dismiss
      // animation — enter transition + keyboard slide + viewport restore all
      // compete for the same frames and the toast looks choppy. Let the
      // keyboard finish first; desktop shows it immediately.
      const showResultToast = () => {
        if (result.isCorrect) {
          toast.success("You guessed it!");
        } else if (guessType === "fullWord") {
          toast("Not the word.");
        } else {
          toast(
            `${result.matchCount} letter${result.matchCount !== 1 ? "s" : ""} match${result.matchCount === 1 ? "es" : ""}`
          );
        }
      };
      if (window.innerWidth < 1024) {
        window.setTimeout(showResultToast, 450);
      } else {
        showResultToast();
      }
    } catch (error) {
      setOptimisticGuess(null);
      // Restore the failed word for a retry, but never clobber a next guess
      // the player already started typing during the round-trip.
      setGuessText((current) => (current === "" ? word : current));
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
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_480px]">
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
    <div
      className={`flex min-h-0 flex-1 flex-col lg:min-h-fit lg:flex-none ${
        gameState.game.status === "completed"
          ? "lg:mx-auto lg:w-full lg:max-w-2xl"
          : "lg:grid lg:grid-cols-[minmax(0,1fr)_480px] lg:gap-5"
      }`}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 rounded-xl border border-zinc-200 bg-white px-3 pb-3 pt-2 sm:px-4 sm:pb-4 sm:pt-2 lg:block lg:min-h-fit lg:flex-none lg:space-y-5 lg:px-6 lg:pb-6 lg:pt-4">
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
          <div className="flex flex-1 flex-col justify-center gap-4 py-4">
            {(() => {
              const didWin = currentPlayer.id === gameState.game.winnerId;
              const abandoned = !gameState.game.winnerId;
              return (
                <div
                  className={`rounded-xl border px-5 py-6 text-center ${
                    abandoned
                      ? "border-zinc-200 bg-zinc-50"
                      : didWin
                      ? "border-emerald-200 bg-emerald-50"
                      : "border-rose-200 bg-rose-50"
                  }`}
                >
                  <p
                    className={`font-display text-2xl font-black tracking-tight ${
                      abandoned ? "text-zinc-700" : didWin ? "text-emerald-800" : "text-rose-800"
                    }`}
                  >
                    {abandoned ? "Game over" : didWin ? "You won! 🎉" : `${opponent.username} won`}
                  </p>
                  <p className="mt-1.5 text-sm text-zinc-600">
                    {abandoned
                      ? "This game ended without a winner."
                      : didWin
                      ? `You cracked ${opponent.username}'s word in ${myGuesses.length} guess${myGuesses.length === 1 ? "" : "es"}.`
                      : `${opponent.username} got your word first.`}
                  </p>
                </div>
              );
            })()}

            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
                <h3 className="text-center text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500">
                  Your word
                </h3>
                <p className="mt-2 text-center font-mono text-3xl font-black tracking-widest text-zinc-900">
                  {currentPlayer.secretWord}
                </p>
              </div>
              <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
                <h3 className="text-center text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500">
                  {opponent.username}'s word
                </h3>
                <p className="mt-2 text-center font-mono text-3xl font-black tracking-widest text-zinc-900">
                  {opponent.secretWord}
                </p>
              </div>
            </div>

            <button
              onClick={onExitToMenu}
              className="inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-emerald-600 px-5 font-semibold text-white transition hover:bg-emerald-700 active:scale-[0.98]"
            >
              Play again
            </button>
          </div>
        )}

        {opponent && gameState.game.status !== "completed" && (
          <div className="flex min-h-0 flex-1 flex-col gap-3 lg:block lg:min-h-fit lg:space-y-5">
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
                <p className="truncate text-center text-sm font-medium text-zinc-700 lg:text-lg">
                  <span className="font-semibold">{opponent.username}</span>
                  {opponent.isBot && (
                    <span className="ml-1.5 rounded bg-zinc-200 px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-zinc-600">
                      Bot
                    </span>
                  )}
                  <span className="mx-1.5 text-zinc-400">·</span>
                  <span className="font-black text-emerald-700">{opponentFoundLetterCount ?? 0}</span>
                  <span className="text-zinc-500">/5</span> letters found
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
                        className="inline-flex h-9 min-w-9 items-center justify-center rounded-md border-2 border-emerald-600 bg-emerald-500 px-1.5 font-mono text-base font-bold tracking-widest text-white lg:h-14 lg:min-w-[3.5rem] lg:text-2xl"
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

            {/* min-h here (not just on the card) so flex can never shrink this
                section below the card's floor — that's what previously let the
                card overflow underneath the alphabet. */}
            <section className="flex min-h-[7.5rem] flex-1 flex-col lg:block lg:min-h-fit lg:flex-none">
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
                onSubmit={(e) => {
                  e.preventDefault();
                  void submitCurrentGuess();
                }}
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
                    // "Go" makes the iOS keyboard's action key SUBMIT the form —
                    // the same clean path as the submit button — instead of a
                    // Done-style key that only dismisses the keyboard.
                    enterKeyHint="go"
                    // Explicit Enter handling: implicit form submission is
                    // skipped by browsers when the default submit button is
                    // disabled (e.g. length not yet valid), which made the
                    // keyboard action key feel dead. Handle the key directly so
                    // it always takes the same path as the button.
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void submitCurrentGuess();
                      }
                    }}
                    // Deliberately NOT disabled while a guess is in flight:
                    // disabling a focused element ejects keyboard focus, which
                    // kicked desktop players out of the box on every submit.
                    // The submit lock already prevents double-sends, and typing
                    // the next guess during the round-trip is a feature.
                    className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-4 py-2.5 font-mono text-[16px] tracking-widest lg:py-3 lg:text-xl text-zinc-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                    onBlur={handleGuessInputBlur}
                  />
                  <button
                    type="submit"
                    disabled={!guessText.trim() || isSubmitting || guessText.length !== guessMaxLength}
                    // Submit on pointerdown, BEFORE the input blurs. Tapping the
                    // button while the keyboard is up otherwise fires blur first,
                    // whose scroll correction moves the button out from under the
                    // finger before the click lands — the tap goes dead. The
                    // preventDefault keeps focus (and the page) frozen until the
                    // submit handler blurs deliberately; the isSubmitting guard
                    // absorbs the redundant click/submit that may follow.
                    onPointerDown={(e) => {
                      e.preventDefault();
                      void submitCurrentGuess();
                    }}
                    className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg bg-zinc-900 text-lg font-bold lg:min-h-[3.25rem] lg:min-w-[3.25rem] lg:text-xl text-white transition hover:bg-zinc-800 active:scale-95 disabled:opacity-40"
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

      </div>

      {gameState.game.status !== "completed" && (
        <div className="min-w-0 lg:sticky lg:top-16 lg:self-start hidden lg:block">
          <AlphabetBoard
            displayedAlphabet={displayedAlphabet}
            onToggleLetter={toggleLetter}
            disabled={!isGameActive}
          />
        </div>
      )}
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
        <h3 className="text-sm font-semibold text-zinc-700 lg:text-lg">{props.title}</h3>
        <span className="text-sm font-semibold text-zinc-700 lg:text-lg"># of letters in opponent&apos;s word</span>
      </div>
      <div
        ref={props.scrollRef}
        id={props.elementId}
        onScroll={props.onScroll}
        className="min-h-[5rem] flex-1 space-y-2 overflow-y-scroll overscroll-y-contain pr-1 lg:h-[min(22rem,42dvh)] lg:min-h-0 lg:flex-none"
        style={{ scrollbarGutter: "stable both-edges", overflowAnchor: "none" }}
      >
        {allGuesses.length === 0 ? (
          <p className="text-sm leading-6 text-zinc-400">{props.emptyText}</p>
        ) : (
          allGuesses.map((guess) => (
            <div
              key={guess.id}
              className={`guess-row-enter flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm transition-opacity lg:px-5 lg:py-3.5 lg:text-lg ${"pending" in guess && guess.pending === true ? "bg-zinc-100 opacity-60" : "bg-zinc-50"}`}
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
    // The match count is the payoff of every probe — render it big and bold
    // so it reads at a glance on both mobile and desktop.
    <span className="rounded-full bg-zinc-100 px-3 py-0.5 font-mono text-lg font-black tabular-nums text-zinc-800 lg:px-3.5 lg:text-2xl">
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

