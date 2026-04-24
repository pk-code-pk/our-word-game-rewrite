import type { RecentGameSummary } from "../../shared/types";

interface RecentGamesPanelProps {
  games: RecentGameSummary[];
  onOpenGame: (gameId: string) => void;
}

export function RecentGamesPanel({ games, onOpenGame }: RecentGamesPanelProps) {
  const game = games.find((g) => !g.isExpired && g.status !== "completed") ?? null;
  if (!game) return null;

  return (
    <section className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
      <div className="flex items-center justify-between gap-4 px-4 py-4 sm:px-5">
        <div className="min-w-0">
          <h3 className="font-display font-bold text-zinc-900">Resume game</h3>
          <p className="mt-0.5 truncate text-sm text-zinc-500">
            {game.opponentName ? `vs ${game.opponentName}` : "Waiting for opponent"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onOpenGame(game.gameId)}
          className="inline-flex shrink-0 items-center justify-center rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-zinc-800"
        >
          {game.status === "waiting" ? "Waiting..." : "Resume"}
        </button>
      </div>
    </section>
  );
}
