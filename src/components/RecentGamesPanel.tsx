import { useState } from "react";
import { toast } from "sonner";
import type { RecentGameSummary } from "../../shared/types";
import { api } from "../lib/api";

interface RecentGamesPanelProps {
  games: RecentGameSummary[];
  onOpenGame: (gameId: string) => void;
  onGameCleared?: () => void;
}

export function RecentGamesPanel({ games, onOpenGame, onGameCleared }: RecentGamesPanelProps) {
  // Every unfinished game, not just the first. The panel used to render
  // `games.find(...)` — a single entry — so a pile of abandoned games could only
  // be cleared one at a time, each one revealing the next.
  const openGames = games.filter((game) => !game.isExpired && game.status !== "completed");
  const [clearingGameId, setClearingGameId] = useState<string | null>(null);
  const [confirmingGameId, setConfirmingGameId] = useState<string | null>(null);

  if (openGames.length === 0) return null;

  const clearGame = async (game: RecentGameSummary) => {
    setClearingGameId(game.gameId);
    try {
      if (game.status === "waiting") {
        // Nobody has joined, so nothing is lost by cancelling outright.
        await api.leaveWaitingGame(game.gameId);
        toast.success("Lobby cancelled.");
      } else {
        // An active game belongs to the opponent too — it is theirs to finish.
        // Forfeiting hands them the win and closes the game for both, rather
        // than deleting a game out from under someone mid-play.
        await api.forfeitGame(game.gameId);
        toast.success(game.opponentName ? `Forfeited to ${game.opponentName}.` : "Game forfeited.");
      }
      onGameCleared?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not clear that game.");
    } finally {
      setClearingGameId(null);
      setConfirmingGameId(null);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-2">
      {openGames.map((game) => {
        const isClearing = clearingGameId === game.gameId;
        const isConfirming = confirmingGameId === game.gameId;
        const label = game.opponentName
          ? `Resume vs ${game.opponentName}`
          : "Resume: waiting for opponent";

        return (
          <div
            key={game.gameId}
            className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-3 shadow-sm"
          >
            <button
              type="button"
              onClick={() => onOpenGame(game.gameId)}
              disabled={isClearing}
              className="flex min-w-0 flex-1 items-center justify-between gap-4 text-left transition disabled:opacity-40"
            >
              <span className="truncate text-sm font-semibold text-zinc-900">{label}</span>
              <span className="shrink-0 text-sm font-semibold text-zinc-500">Resume →</span>
            </button>

            {isConfirming ? (
              // Forfeiting is not undoable and hands the opponent a win, so an
              // active game asks first. Waiting lobbies skip this — there is no
              // opponent yet and nothing to lose.
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void clearGame(game)}
                  disabled={isClearing}
                  className="min-h-9 rounded-lg bg-rose-600 px-2.5 text-xs font-semibold text-white transition hover:bg-rose-700 disabled:opacity-40"
                >
                  {isClearing ? "..." : "Forfeit"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingGameId(null)}
                  disabled={isClearing}
                  className="min-h-9 rounded-lg border border-zinc-300 px-2.5 text-xs font-semibold text-zinc-700 transition hover:bg-zinc-50 disabled:opacity-40"
                >
                  Keep
                </button>
              </div>
            ) : (
              <button
                type="button"
                aria-label={game.status === "waiting" ? "Cancel lobby" : "Forfeit and remove game"}
                title={game.status === "waiting" ? "Cancel lobby" : "Forfeit and remove game"}
                onClick={() => {
                  if (game.status === "waiting") {
                    void clearGame(game);
                  } else {
                    setConfirmingGameId(game.gameId);
                  }
                }}
                disabled={isClearing}
                className="min-h-9 shrink-0 rounded-lg border border-zinc-300 px-2.5 text-xs font-semibold text-zinc-500 transition hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40"
              >
                {isClearing ? "..." : "Remove"}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
