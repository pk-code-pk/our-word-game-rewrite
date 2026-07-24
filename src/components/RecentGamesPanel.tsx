import type { RecentGameSummary } from "../../shared/types";

interface RecentGamesPanelProps {
  games: RecentGameSummary[];
  onOpenGame: (gameId: string) => void;
}

export function RecentGamesPanel({ games, onOpenGame }: RecentGamesPanelProps) {
  const game = games.find((g) => !g.isExpired && g.status !== "completed") ?? null;
  if (!game) return null;

  return (
    <div className="mx-auto max-w-2xl">
      <button
        type="button"
        onClick={() => onOpenGame(game.gameId)}
        className="flex w-full items-center justify-between gap-4 rounded-xl border border-zinc-200 bg-white px-4 py-3 shadow-sm transition hover:bg-zinc-50"
      >
        <span className="text-sm font-semibold text-zinc-900">
          {game.opponentName ? `Resume vs ${game.opponentName}` : "Resume: waiting for opponent"}
        </span>
        <span className="shrink-0 text-sm font-semibold text-zinc-500">Resume →</span>
      </button>
    </div>
  );
}
