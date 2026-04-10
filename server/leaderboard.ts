import { databaseProvider, db } from "./db.js";
import { pushRecentResult } from "../shared/gameLogic.js";
import type { LeaderboardEntry } from "./types.js";

const LEADERBOARD_LIMIT = 10;
type MaybePromise<T> = T | Promise<T>;

export interface LeaderboardSourceRow {
  gameId: string;
  gameCreatedAt: number;
  completedAt: number | null;
  winnerPlayerId: string | null;
  playerId: string;
  userId: string;
  username: string;
  playerCreatedAt: number;
  guessCount: number;
}

type Result = "W" | "L";

type LeaderboardAccumulator = {
  userId: string;
  username: string;
  wins: number;
  losses: number;
  totalWinGuesses: number;
  gamesPlayed: number;
  currentWinStreak: number;
  bestWinGuesses: number | null;
  recentResults: Result[];
  lastCompletedAt: number;
};

type InternalLeaderboardEntry = LeaderboardEntry & {
  userId: string;
  lastCompletedAt: number;
};

function compareBestWinGuesses(left: number | null, right: number | null) {
  if (left === null && right === null) {
    return 0;
  }

  if (left === null) {
    return 1;
  }

  if (right === null) {
    return -1;
  }

  return left - right;
}

function compareRecentForm(left: Result[], right: Result[]) {
  const maxLength = Math.max(left.length, right.length, 5);

  for (let index = 1; index <= maxLength; index += 1) {
    const leftResult = left[left.length - index] ?? "L";
    const rightResult = right[right.length - index] ?? "L";

    if (leftResult !== rightResult) {
      return leftResult === "W" ? -1 : 1;
    }
  }

  return 0;
}

function compareEntries(left: InternalLeaderboardEntry, right: InternalLeaderboardEntry) {
  if (left.wins !== right.wins) {
    return right.wins - left.wins;
  }

  if (left.winRate !== right.winRate) {
    return right.winRate - left.winRate;
  }

  if (left.currentWinStreak !== right.currentWinStreak) {
    return right.currentWinStreak - left.currentWinStreak;
  }

  const recentForm = compareRecentForm(left.recentResults, right.recentResults);
  if (recentForm !== 0) {
    return recentForm;
  }

  if (left.averageGuessesPerWin !== right.averageGuessesPerWin) {
    return left.averageGuessesPerWin - right.averageGuessesPerWin;
  }

  const bestWinGuesses = compareBestWinGuesses(left.bestWinGuesses ?? null, right.bestWinGuesses ?? null);
  if (bestWinGuesses !== 0) {
    return bestWinGuesses;
  }

  if (left.lastCompletedAt !== right.lastCompletedAt) {
    return right.lastCompletedAt - left.lastCompletedAt;
  }

  const usernameCompare = left.username.localeCompare(right.username, undefined, {
    sensitivity: "base",
  });
  if (usernameCompare !== 0) {
    return usernameCompare;
  }

  return left.userId.localeCompare(right.userId);
}

function getOrCreateAccumulator(
  entries: Map<string, LeaderboardAccumulator>,
  userId: string,
  username: string,
  completedAt: number
) {
  const existing = entries.get(userId);
  if (existing) {
    existing.username = username;
    existing.lastCompletedAt = completedAt;
    return existing;
  }

  const accumulator: LeaderboardAccumulator = {
    userId,
    username,
    wins: 0,
    losses: 0,
    totalWinGuesses: 0,
    gamesPlayed: 0,
    currentWinStreak: 0,
    bestWinGuesses: null,
    recentResults: [],
    lastCompletedAt: completedAt,
  };
  entries.set(userId, accumulator);
  return accumulator;
}

function finalizeLeaderboardEntry(accumulator: LeaderboardAccumulator): InternalLeaderboardEntry {
  return {
    userId: accumulator.userId,
    username: accumulator.username,
    wins: accumulator.wins,
    averageGuessesPerWin:
      accumulator.wins > 0 ? Math.round((accumulator.totalWinGuesses / accumulator.wins) * 10) / 10 : 0,
    gamesPlayed: accumulator.gamesPlayed,
    currentWinStreak: accumulator.currentWinStreak,
    winRate: accumulator.gamesPlayed > 0 ? Math.round((accumulator.wins / accumulator.gamesPlayed) * 100) : 0,
    bestWinGuesses: accumulator.bestWinGuesses ?? undefined,
    recentResults: [...accumulator.recentResults],
    lastCompletedAt: accumulator.lastCompletedAt,
  };
}

export function buildLeaderboard(rows: LeaderboardSourceRow[]): LeaderboardEntry[] {
  const completedRows = [...rows]
    .filter((row): row is LeaderboardSourceRow & { completedAt: number; winnerPlayerId: string } => {
      return row.completedAt !== null && row.winnerPlayerId !== null;
    })
    .sort((left, right) => {
      if (left.completedAt !== right.completedAt) {
        return left.completedAt - right.completedAt;
      }

      if (left.gameCreatedAt !== right.gameCreatedAt) {
        return left.gameCreatedAt - right.gameCreatedAt;
      }

      if (left.gameId !== right.gameId) {
        return left.gameId.localeCompare(right.gameId);
      }

      if (left.playerCreatedAt !== right.playerCreatedAt) {
        return left.playerCreatedAt - right.playerCreatedAt;
      }

      return left.playerId.localeCompare(right.playerId);
    });

  const groupedByGame = new Map<string, LeaderboardSourceRow[]>();
  for (const row of completedRows) {
    const existing = groupedByGame.get(row.gameId);
    if (existing) {
      existing.push(row);
    } else {
      groupedByGame.set(row.gameId, [row]);
    }
  }

  const accumulators = new Map<string, LeaderboardAccumulator>();

  for (const gameRows of groupedByGame.values()) {
    const winnerPlayerId = gameRows[0]?.winnerPlayerId;
    if (!winnerPlayerId) {
      continue;
    }

    if (!gameRows.some((row) => row.playerId === winnerPlayerId)) {
      continue;
    }

    for (const row of gameRows) {
      const result: Result = row.playerId === winnerPlayerId ? "W" : "L";
      const accumulator = getOrCreateAccumulator(accumulators, row.userId, row.username, row.completedAt ?? 0);
      accumulator.username = row.username;
      accumulator.lastCompletedAt = row.completedAt ?? accumulator.lastCompletedAt;
      accumulator.gamesPlayed += 1;
      accumulator.recentResults = pushRecentResult(accumulator.recentResults, result);

      if (result === "W") {
        accumulator.wins += 1;
        accumulator.totalWinGuesses += row.guessCount;
        accumulator.currentWinStreak += 1;
        accumulator.bestWinGuesses =
          accumulator.bestWinGuesses === null ? row.guessCount : Math.min(accumulator.bestWinGuesses, row.guessCount);
      } else {
        accumulator.losses += 1;
        accumulator.currentWinStreak = 0;
      }
    }
  }

  return [...accumulators.values()]
    .map(finalizeLeaderboardEntry)
    .sort(compareEntries)
    .slice(0, LEADERBOARD_LIMIT);
}

export function getLeaderboard(): LeaderboardEntry[];
export function getLeaderboard(): any {
  const mapRows = (
    rows: Array<{
      game_id: string;
      game_created_at: number;
      completed_at: number | null;
      winner_player_id: string | null;
      player_id: string;
      user_id: string;
      username: string;
      player_created_at: number;
      guess_count: number;
    }>
  ) =>
    buildLeaderboard(
      rows.map((row) => ({
        gameId: row.game_id,
        gameCreatedAt: row.game_created_at,
        completedAt: row.completed_at,
        winnerPlayerId: row.winner_player_id,
        playerId: row.player_id,
        userId: row.user_id,
        username: row.username,
        playerCreatedAt: row.player_created_at,
        guessCount: row.guess_count,
      }))
    );

  const sql = `SELECT
         g.id AS game_id,
         g.created_at AS game_created_at,
         g.completed_at AS completed_at,
         g.winner_player_id AS winner_player_id,
         p.id AS player_id,
         p.user_id AS user_id,
         p.username AS username,
         p.created_at AS player_created_at,
         COALESCE(gc.guess_count, 0) AS guess_count
       FROM games g
       JOIN players p ON p.game_id = g.id
       LEFT JOIN (
         SELECT player_id, COUNT(*) AS guess_count
         FROM guesses
         GROUP BY player_id
       ) gc ON gc.player_id = p.id
       WHERE g.status = 'completed'
         AND g.completed_at IS NOT NULL
         AND g.winner_player_id IS NOT NULL
       ORDER BY g.completed_at ASC, g.created_at ASC, g.id ASC, p.created_at ASC, p.id ASC`;

  if (databaseProvider === "sqlite") {
    const rows = db.prepare(sql).all() as Array<{
      game_id: string;
      game_created_at: number;
      completed_at: number | null;
      winner_player_id: string | null;
      player_id: string;
      user_id: string;
      username: string;
      player_created_at: number;
      guess_count: number;
    }>;
    return mapRows(rows);
  }

  return (async () => {
    const rows = (await db.prepare(sql).all()) as Array<{
      game_id: string;
      game_created_at: number;
      completed_at: number | null;
      winner_player_id: string | null;
      player_id: string;
      user_id: string;
      username: string;
      player_created_at: number;
      guess_count: number;
    }>;
    return mapRows(rows);
  })();
}
