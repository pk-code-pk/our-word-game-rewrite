import { api } from "../lib/api";
import { usePollingQuery } from "../lib/usePollingQuery";

interface StatChipProps {
  label: string;
  value: string | number;
  tone?: "slate" | "indigo" | "emerald" | "amber";
}

function StatChip({ label, value, tone = "slate" }: StatChipProps) {
  const toneClasses = {
    slate: "border-zinc-200 bg-zinc-50 text-zinc-900",
    indigo: "border-blue-100 bg-blue-50 text-blue-900",
    emerald: "border-emerald-100 bg-emerald-50 text-emerald-900",
    amber: "border-amber-100 bg-amber-50 text-amber-900",
  }[tone];

  return (
    <div className={`rounded-xl border px-3 py-2.5 ${toneClasses}`}>
      <div className="text-[10px] font-semibold uppercase tracking-widest opacity-60">{label}</div>
      <div className="mt-0.5 text-lg font-black tracking-tight">{value}</div>
    </div>
  );
}

export function Leaderboard() {
  const leaderboardQuery = usePollingQuery(() => api.getLeaderboard(), [], { intervalMs: 5000 });
  const leaderboard = leaderboardQuery.data?.leaderboard ?? [];

  if (leaderboardQuery.loading) {
    return (
      <div className="mx-auto max-w-4xl rounded-2xl border border-zinc-200 bg-white p-8 text-center shadow-sm">
        <div className="inline-flex items-center gap-2 text-sm text-zinc-500">
          <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-700" />
          Loading...
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="rounded-t-2xl bg-zinc-950 px-5 py-5 text-white sm:px-6">
        <p className="text-xs font-semibold uppercase tracking-widest text-zinc-400">Leaderboard</p>
        <h2 className="mt-1 font-display text-2xl font-bold text-white">Top players</h2>
        <p className="mt-1 text-sm text-zinc-400">Ranked by wins · streaks break ties</p>
      </div>

      <div className="overflow-hidden rounded-b-2xl border border-t-0 border-zinc-200 bg-white shadow-sm">
        {leaderboardQuery.error && (
          <div className="border-b border-zinc-100 bg-amber-50 px-5 py-3 text-sm text-amber-700">
            Showing cached data — refresh unavailable.
          </div>
        )}

        {leaderboard.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-zinc-400">
            No completed games yet. Be the first.
          </div>
        ) : (
          <div className="divide-y divide-zinc-100">
            {leaderboard.map((entry, index) => (
              <article
                key={`${entry.username}-${index}`}
                className={`px-4 py-4 sm:px-5 ${index === 0 ? "bg-emerald-50/50" : ""}`}
              >
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-4">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-zinc-900 text-sm font-black text-white">
                    {index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : `#${index + 1}`}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="max-w-full truncate font-semibold text-zinc-900">{entry.username}</h3>
                      <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-500">{entry.gamesPlayed} games</span>
                    </div>

                    <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                      <StatChip label="Wins" value={entry.wins} tone="emerald" />
                      <StatChip label="Win rate" value={`${entry.winRate}%`} tone="indigo" />
                      <StatChip label="Streak" value={entry.currentWinStreak > 0 ? entry.currentWinStreak : 0} tone={entry.currentWinStreak > 0 ? "amber" : "slate"} />
                    </div>

                    <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex flex-wrap gap-1.5 text-xs text-zinc-400">
                        <span>Avg {entry.averageGuessesPerWin}/win</span>
                        <span>·</span>
                        <span>Best {entry.bestWinGuesses ?? "—"}</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {entry.recentResults.length > 0 ? entry.recentResults.map((result, i) => (
                          <span key={i} className={`inline-flex h-6 w-6 items-center justify-center rounded text-[11px] font-bold ${result === "W" ? "bg-emerald-500 text-white" : "bg-rose-500 text-white"}`}>
                            {result}
                          </span>
                        )) : <span className="text-xs text-zinc-300">—</span>}
                      </div>
                    </div>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}

        <div className="border-t border-zinc-100 px-5 py-3 text-center text-xs text-zinc-400">
          Lower avg guesses/win is better · last 5 games shown
        </div>
      </div>
    </div>
  );
}
