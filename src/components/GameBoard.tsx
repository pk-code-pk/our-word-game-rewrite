import { useEffect, useLayoutEffect, useRef, useState } from "react";
import confetti from "canvas-confetti";
import { toast } from "sonner";
import { AlphabetBoard } from "./AlphabetBoard";
import { PresenceBadge } from "./PresenceBadge";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useGameSocket } from "../lib/useGameSocket";

interface GameBoardProps {
  gameId: string;
  onExitToMenu: () => void;
}

export function GameBoard({ gameId, onExitToMenu }: GameBoardProps) {
  const { user } = useAuth();
  const gameStateQuery = useGameSocket(gameId);
  const gameState = gameStateQuery.data?.gameState;
  const [guessText, setGuessText] = useState("");
  const [guessType, setGuessType] = useState<"fourLetter" | "fullWord">("fourLetter");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLeavingWaitingLobby, setIsLeavingWaitingLobby] = useState(false);
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

  useEffect(() => {
    latestGameStatusRef.current = gameState?.game.status;
  }, [gameState?.game.status]);

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

    if (shouldPinGuessPane(myGuesses.length, keepMyGuessesPinnedRef.current)) {
      scrollGuessPaneToBottom(myGuessesRef.current);
    }
  }, [gameState?.game.status, myGuesses.length]);

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

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const viewport = window.visualViewport;
    if (!viewport) {
      return;
    }

    const keepComposerVisibleOnViewportChange = () => {
      if (document.activeElement === guessInputRef.current) {
        ensureComposerStaysVisible(guessFormRef.current);
      }
    };

    viewport.addEventListener("resize", keepComposerVisibleOnViewportChange);
    window.addEventListener("orientationchange", keepComposerVisibleOnViewportChange);

    return () => {
      viewport.removeEventListener("resize", keepComposerVisibleOnViewportChange);
      window.removeEventListener("orientationchange", keepComposerVisibleOnViewportChange);
    };
  }, []);

  const handleSubmitGuess = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentPlayer || !guessText.trim() || isSubmitting) return;

    const word = guessText.trim().toUpperCase();
    if (guessType === "fourLetter" && word.length !== 4) {
      toast.error("Four-letter guesses must be exactly 4 letters");
      return;
    }
    if (guessType === "fullWord" && word.length !== 5) {
      toast.error("Full word guesses must be exactly 5 letters");
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await api.submitGuess(gameId, { type: guessType, text: word });
      if (result.isCorrect) {
        toast.success("You guessed it correctly! You win!");
      } else if (guessType === "fullWord") {
        toast.success("Guess submitted! That's not the correct word.");
      } else {
        toast.success(
          `Guess submitted! ${result.matchCount} letter${result.matchCount !== 1 ? "s" : ""} match${result.matchCount === 1 ? "es" : ""}`
        );
      }
      setGuessText("");
      keepMyGuessesPinnedRef.current = true;
      window.requestAnimationFrame(() => {
        guessInputRef.current?.focus({ preventScroll: true });
      });
    } catch (error) {
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
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
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

  const presence = gameState.presence ?? {
    me: "offline" as const,
    opponent: opponent ? ("offline" as const) : null,
  };
  const isGameActive = gameState.game.status === "active";
  const isWaitingForOpponent = gameState.game.status === "waiting";
  const queryError = gameStateQuery.error;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-5">
      <div className="min-w-0 space-y-4 rounded-xl border border-zinc-200 bg-white p-4 sm:p-5">
        <div className="flex flex-col gap-3 border-b border-zinc-100 pb-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <span className="inline-flex rounded-full bg-zinc-100 px-2.5 py-0.5 text-[11px] font-semibold text-zinc-600">
              Code {gameState.game.code}
            </span>
            {opponent ? (
              <p className="text-sm text-zinc-500">Playing against {opponent.username}</p>
            ) : (
              <p className="text-sm text-zinc-500">Waiting for an opponent to join.</p>
            )}
          </div>
          <button
            onClick={() => void handleExit()}
            disabled={isLeavingWaitingLobby}
            className="inline-flex w-full items-center justify-center rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-600 transition hover:bg-zinc-50 sm:w-auto"
          >
            {isWaitingForOpponent ? (isLeavingWaitingLobby ? "Cancelling..." : "Cancel waiting lobby") : "Back to menu"}
          </button>
        </div>

        {queryError && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
            Connection issue — retrying...
          </div>
        )}

        {isWaitingForOpponent && (
          <div className="rounded-lg border border-zinc-200 bg-white p-5 text-center shadow-sm">
            <div className="animate-pulse text-base font-medium text-zinc-600">Waiting for opponent...</div>
            <div className="mt-2 font-mono text-sm font-semibold tracking-widest text-zinc-500">{gameState.game.code}</div>
          </div>
        )}

        {opponent && (
          <div className="flex gap-2 rounded-lg border border-zinc-100 bg-zinc-50 p-2">
            <PresenceBadge status={presence.me} label="You" />
            <PresenceBadge status={presence.opponent} label={opponent.username} />
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
          <div className="space-y-3 lg:space-y-5">
            <section className="flex items-center justify-between rounded-xl border border-zinc-200 bg-emerald-50 px-4 py-3">
              <p className="text-sm font-medium text-emerald-900">{opponent.username} found</p>
              <span className="font-mono text-3xl font-black text-emerald-700">{opponentFoundLetterCount ?? "—"}</span>
            </section>

            <section>
              <GuessColumn
                title="Your guesses"
                elementId="my-guesses"
                guesses={myGuesses}
                emptyText="No guesses yet"
                scrollRef={myGuessesRef}
                onScroll={() => {
                  keepMyGuessesPinnedRef.current = isNearBottom(myGuessesRef.current);
                }}
              />
            </section>

            {/* Alphabet — visible inline on mobile, hidden (sidebar handles it) on desktop */}
            <div className="lg:hidden">
              <AlphabetBoard gameId={gameId} alphabet={currentPlayer.alphabet} disabled={!isGameActive} />
            </div>

            {isGameActive && (
              <form
                ref={guessFormRef}
                onSubmit={handleSubmitGuess}
                className="space-y-2.5 rounded-xl border border-zinc-200 bg-zinc-50 p-3"
              >
                <input
                  ref={guessInputRef}
                  type="text"
                  value={guessText}
                  onChange={(e) => setGuessText(e.target.value.toUpperCase())}
                  placeholder={guessType === "fourLetter" ? "4-letter word" : "5-letter word"}
                  maxLength={guessType === "fourLetter" ? 4 : 5}
                  autoCapitalize="characters"
                  spellCheck={false}
                  className="w-full rounded-lg border border-zinc-200 bg-white px-4 py-2.5 font-mono text-[16px] tracking-widest text-zinc-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 disabled:bg-zinc-50"
                  disabled={isSubmitting}
                  onFocus={() => ensureComposerStaysVisible(guessFormRef.current)}
                />
                <div className="flex items-center gap-2">
                  <div className="grid flex-1 grid-cols-2 rounded-lg bg-zinc-100 p-0.5">
                    <button
                      type="button"
                      onClick={() => setGuessType("fourLetter")}
                      disabled={isSubmitting}
                      className={`inline-flex items-center justify-center rounded-md border px-3 py-2 text-sm font-semibold transition ${
                        guessType === "fourLetter"
                          ? "border-zinc-900 bg-white text-zinc-900 shadow-sm"
                          : "border-transparent text-zinc-700 hover:border-zinc-200 hover:bg-white/70"
                      }`}
                      aria-pressed={guessType === "fourLetter"}
                    >
                      4 letters
                    </button>
                    <button
                      type="button"
                      onClick={() => setGuessType("fullWord")}
                      disabled={isSubmitting}
                      className={`inline-flex items-center justify-center rounded-md border px-3 py-2 text-sm font-semibold transition ${
                        guessType === "fullWord"
                          ? "border-zinc-900 bg-white text-zinc-900 shadow-sm"
                          : "border-transparent text-zinc-700 hover:border-zinc-200 hover:bg-white/70"
                      }`}
                      aria-pressed={guessType === "fullWord"}
                    >
                      Full word
                    </button>
                  </div>
                  <button
                    type="submit"
                    disabled={
                      !guessText.trim() ||
                      isSubmitting ||
                      (guessType === "fourLetter" && guessText.length !== 4) ||
                      (guessType === "fullWord" && guessText.length !== 5)
                    }
                    className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-zinc-900 text-lg font-bold text-white transition hover:bg-zinc-800 disabled:opacity-40"
                    aria-label="Submit guess"
                  >
                    {isSubmitting ? "…" : "↑"}
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
        <AlphabetBoard gameId={gameId} alphabet={currentPlayer.alphabet} disabled={!isGameActive} />
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
  emptyText: string;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onScroll: React.UIEventHandler<HTMLDivElement>;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white p-3 shadow-sm lg:p-5">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-zinc-700">{props.title}</h3>
      </div>
      <div
        ref={props.scrollRef}
        id={props.elementId}
        onScroll={props.onScroll}
        className="h-[min(8rem,16dvh)] min-h-0 space-y-2 overflow-y-scroll overscroll-y-contain pr-1 sm:h-[min(10rem,20dvh)] lg:h-[min(10rem,20dvh)]"
        style={{ scrollbarGutter: "stable both-edges", overflowAnchor: "none" }}
      >
        {props.guesses.length === 0 ? (
          <p className="text-sm leading-6 text-zinc-400">{props.emptyText}</p>
        ) : (
          props.guesses.map((guess) => (
            <div key={guess.id} className="flex items-center justify-between gap-2 rounded-lg bg-zinc-50 px-3 py-2 text-sm">
              <span className="font-mono font-bold tracking-widest text-zinc-900">
                {guess.text} {guess.type === "fullWord" && "🎯"}
              </span>
              {renderGuessResult(guess)}
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
      {guess.matchCount} match{guess.matchCount !== 1 ? "es" : ""}
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

function ensureComposerStaysVisible(element: HTMLElement | null) {
  if (!element) {
    return;
  }

  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  const rect = element.getBoundingClientRect();
  const topSafeArea = 16;
  const bottomSafeArea = 20;
  const isVisible = rect.top >= topSafeArea && rect.bottom <= viewportHeight - bottomSafeArea;

  if (!isVisible) {
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}
