import { useEffect, useState } from "react";
import type { LeaderboardEntry } from "../../shared/types";
import { api } from "../lib/api";
import { SocialHeaderButton } from "./social/SocialHeaderButton";
import { SocialOverlay } from "./social/SocialOverlay";

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; entries: LeaderboardEntry[] }
  | { status: "error"; message: string };

function formatWinRate(entry: LeaderboardEntry) {
  return `${entry.winRate}%`;
}

function formatAvgGuesses(entry: LeaderboardEntry) {
  return entry.wins > 0 ? entry.averageGuessesPerWin.toFixed(1) : "—";
}

export function Leaderboard() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LoadState>({ status: "idle" });

  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;
    setState({ status: "loading" });

    api
      .getLeaderboard()
      .then((response) => {
        if (cancelled) return;
        setState({ status: "loaded", entries: response.leaderboard });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "Could not load the leaderboard.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <>
      <SocialHeaderButton
        icon={<span aria-hidden="true">🏆</span>}
        active={open}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="min-h-11 sm:min-h-11"
      >
        <span className="hidden sm:inline">Leaderboard</span>
        <span className="sm:hidden">Ranks</span>
      </SocialHeaderButton>

      <SocialOverlay
        open={open}
        onClose={() => setOpen(false)}
        eyebrow="Top players"
        title="Leaderboard"
        subtitle="Ranked by wins across every finished game."
        size="lg"
      >
        {state.status === "loading" || state.status === "idle" ? (
          <div className="space-y-3" aria-busy="true">
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className="h-12 animate-pulse rounded-2xl border border-slate-100 bg-slate-50" />
            ))}
          </div>
        ) : state.status === "error" ? (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-4 text-sm text-rose-700">
            {state.message}
          </div>
        ) : state.entries.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-10 text-center text-sm text-slate-500">
            No finished games yet. Win a match to claim the top spot.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-slate-200">
            <table className="w-full min-w-[34rem] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                  <th scope="col" className="px-3 py-3 sm:px-4">#</th>
                  <th scope="col" className="px-3 py-3 sm:px-4">Player</th>
                  <th scope="col" className="px-3 py-3 text-right sm:px-4">Wins</th>
                  <th scope="col" className="px-3 py-3 text-right sm:px-4">Games</th>
                  <th scope="col" className="px-3 py-3 text-right sm:px-4">Win rate</th>
                  <th scope="col" className="px-3 py-3 text-right sm:px-4">Avg / win</th>
                </tr>
              </thead>
              <tbody>
                {state.entries.map((entry, index) => (
                  <tr
                    key={`${entry.username}-${index}`}
                    className="h-12 border-b border-slate-100 last:border-b-0 odd:bg-white even:bg-slate-50/60"
                  >
                    <td className="px-3 py-2 font-bold tabular-nums text-slate-400 sm:px-4">{index + 1}</td>
                    <td className="max-w-[10rem] truncate px-3 py-2 font-semibold text-slate-900 sm:px-4">
                      {entry.username}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-900 sm:px-4">
                      {entry.wins}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-600 sm:px-4">{entry.gamesPlayed}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-600 sm:px-4">{formatWinRate(entry)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-600 sm:px-4">
                      {formatAvgGuesses(entry)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SocialOverlay>
    </>
  );
}
