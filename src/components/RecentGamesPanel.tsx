import type { RecentGameSummary } from "../../shared/types";

interface RecentGamesPanelProps {
  games: RecentGameSummary[];
  onOpenGame: (gameId: string) => void;
}

function formatTimestamp(timestamp: number) {
  return new Date(timestamp).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function RecentGamesPanel({ games, onOpenGame }: RecentGamesPanelProps) {
  if (games.length === 0) {
    return null;
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
      <div className="flex flex-col gap-3 border-b border-zinc-100 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="min-w-0">
          <h3 className="font-display font-bold text-zinc-900">Resume a game</h3>
          <p className="mt-0.5 text-sm text-zinc-500">Jump back into your recent matches.</p>
        </div>
      </div>

      <ul className="divide-y divide-zinc-100">
        {games.slice(0, 6).map((game) => (
          <li key={game.gameId} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-5">
            <div className="min-w-0 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-zinc-900">
                  {game.opponentName ? `vs ${game.opponentName}` : "Waiting for opponent"}
                </span>
                {game.isExpired && <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-semibold text-rose-700">Expired</span>}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400">
                <span className="font-mono font-semibold tracking-widest text-zinc-500">{game.code}</span>
                <span>{formatTimestamp(game.lastActivityAt)}</span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => onOpenGame(game.gameId)}
              disabled={game.isExpired}
              className="inline-flex min-h-11 w-full shrink-0 items-center justify-center rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-400 sm:w-auto"
            >
              {game.isExpired ? "Gone" : game.status === "completed" ? "Review" : "Resume"}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
