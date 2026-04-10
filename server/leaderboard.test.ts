import { beforeEach, describe, expect, it } from "vitest";
import { db, initDb } from "./db";
import { buildLeaderboard, getLeaderboard, type LeaderboardSourceRow } from "./leaderboard";
import type { AuthUser } from "./types";

function makeUser(id: string, email: string, username = email.split("@")[0] ?? id): AuthUser {
  return {
    id,
    email,
    username,
    isAnonymous: false,
    createdAt: Date.now(),
  };
}

function seedUser(user: AuthUser) {
  db.prepare(
    `INSERT INTO users (id, email, username, password_hash, is_anonymous, created_at) VALUES (?, ?, ?, NULL, ?, ?)`
  ).run(user.id, user.email, user.username, user.isAnonymous ? 1 : 0, user.createdAt);
}

function insertUserStat(
  userId: string,
  username: string,
  wins: number,
  losses: number,
  totalGuesses: number,
  totalWinGuesses: number,
  gamesPlayed: number,
  currentWinStreak: number,
  recentResultsJson: string,
  bestWinGuesses: number | null,
  updatedAt: number
) {
  db.prepare(
    `INSERT INTO user_stats (
      user_id, wins, losses, total_guesses, total_win_guesses, games_played, most_recent_username,
      current_win_streak, recent_results_json, best_win_guesses, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    userId,
    wins,
    losses,
    totalGuesses,
    totalWinGuesses,
    gamesPlayed,
    username,
    currentWinStreak,
    recentResultsJson,
    bestWinGuesses,
    updatedAt
  );
}

function insertGuessRows(params: {
  gameId: string;
  playerId: string;
  guessCount: number;
  isWinner: boolean;
  secretWord: string;
}) {
  const { gameId, playerId, guessCount, isWinner, secretWord } = params;
  const createdAtBase = Date.now();

  for (let index = 0; index < guessCount; index += 1) {
    const isCorrect = isWinner && index === guessCount - 1;
    db.prepare(
      `INSERT INTO guesses (id, game_id, player_id, type, text, match_count, is_correct, guess_number, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `${gameId}-${playerId}-guess-${index + 1}`,
      gameId,
      playerId,
      isCorrect ? "fullWord" : "fourLetter",
      isCorrect ? secretWord : "DARK",
      isCorrect ? 5 : 0,
      isCorrect ? 1 : 0,
      index + 1,
      createdAtBase + index
    );
  }
}

function insertCompletedGame(params: {
  gameId: string;
  code: string;
  completedAt: number;
  winnerIndex: 0 | 1;
  players: [
    { userId: string; username: string; playerId: string; secretWord: string; guessCount: number },
    { userId: string; username: string; playerId: string; secretWord: string; guessCount: number },
  ];
}) {
  const { gameId, code, completedAt, winnerIndex, players } = params;
  const gameCreatedAt = completedAt - 5_000;
  const winnerPlayerId = players[winnerIndex].playerId;

  db.prepare(
    `INSERT INTO games (id, code, status, public, created_at, last_activity_at, completed_at, winner_player_id)
     VALUES (?, ?, 'completed', 1, ?, ?, ?, ?)`
  ).run(gameId, code, gameCreatedAt, completedAt, completedAt, winnerPlayerId);

  for (const [index, player] of players.entries()) {
    db.prepare(
      `INSERT INTO players (
         id, game_id, user_id, username, secret_word_hash, secret_word, alphabet_json, total_guesses, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      player.playerId,
      gameId,
      player.userId,
      player.username,
      `hash-${player.secretWord}`,
      player.secretWord,
      JSON.stringify({ A: "unknown" }),
      player.guessCount,
      gameCreatedAt + index + 1
    );

    insertGuessRows({
      gameId,
      playerId: player.playerId,
      guessCount: player.guessCount,
      isWinner: index === winnerIndex,
      secretWord: player.secretWord,
    });
  }
}

function makeSourceRow(
  gameId: string,
  completedAt: number,
  winnerPlayerId: string,
  playerId: string,
  userId: string,
  username: string,
  playerCreatedAt: number,
  guessCount: number
): LeaderboardSourceRow {
  return {
    gameId,
    gameCreatedAt: completedAt - 5_000,
    completedAt,
    winnerPlayerId,
    playerId,
    userId,
    username,
    playerCreatedAt,
    guessCount,
  };
}

function completedGameRows(params: {
  gameId: string;
  completedAt: number;
  winnerIndex: 0 | 1;
  players: [
    { userId: string; username: string; playerId: string; guessCount: number },
    { userId: string; username: string; playerId: string; guessCount: number },
  ];
}): LeaderboardSourceRow[] {
  const { gameId, completedAt, winnerIndex, players } = params;
  const winnerPlayerId = players[winnerIndex].playerId;
  return players.map((player, index) =>
    makeSourceRow(
      gameId,
      completedAt,
      winnerPlayerId,
      player.playerId,
      player.userId,
      player.username,
      completedAt - 1_000 + index,
      player.guessCount
    )
  );
}

describe("leaderboard", () => {
  beforeEach(() => {
    initDb();
    db.exec(`
      DELETE FROM chat_messages;
      DELETE FROM guesses;
      DELETE FROM players;
      DELETE FROM games;
      DELETE FROM sessions;
      DELETE FROM user_stats;
      DELETE FROM users;
    `);
  });

  it("derives standings from completed games instead of stale aggregates", () => {
    const alpha = makeUser("user-alpha", "alpha@example.com");
    const bravo = makeUser("user-bravo", "bravo@example.com");
    seedUser(alpha);
    seedUser(bravo);

    insertUserStat(
      bravo.id,
      "Bravo",
      99,
      0,
      99,
      99,
      99,
      12,
      JSON.stringify(["W", "W", "W"]),
      1,
      Date.now()
    );

    insertCompletedGame({
      gameId: "game-alpha",
      code: "ALPHA1",
      completedAt: 1_700_000_000_000,
      winnerIndex: 0,
      players: [
        {
          userId: alpha.id,
          username: "Alpha",
          playerId: "player-alpha",
          secretWord: "CRANE",
          guessCount: 2,
        },
        {
          userId: bravo.id,
          username: "Bravo",
          playerId: "player-bravo",
          secretWord: "LIGHT",
          guessCount: 4,
        },
      ],
    });

    const leaderboard = getLeaderboard();

    expect(leaderboard[0]?.username).toBe("Alpha");
    expect(leaderboard[0]?.wins).toBe(1);
    expect(leaderboard[0]?.averageGuessesPerWin).toBe(2);
    expect(leaderboard[0]?.recentResults).toEqual(["W"]);
    expect(leaderboard.find((entry) => entry.username === "Bravo")?.wins).toBe(0);
  });

  it("prefers recent form when core stats are tied", () => {
    const rows: LeaderboardSourceRow[] = [
      ...completedGameRows({
        gameId: "alice-1",
        completedAt: 1_700_000_000_000,
        winnerIndex: 1,
        players: [
          { userId: "alice", username: "Alice", playerId: "alice-1", guessCount: 6 },
          { userId: "alice-op-1", username: "Alice Opp 1", playerId: "alice-op-1", guessCount: 3 },
        ],
      }),
      ...completedGameRows({
        gameId: "alice-2",
        completedAt: 1_700_000_001_000,
        winnerIndex: 0,
        players: [
          { userId: "alice", username: "Alice", playerId: "alice-2", guessCount: 3 },
          { userId: "alice-op-2", username: "Alice Opp 2", playerId: "alice-op-2", guessCount: 6 },
        ],
      }),
      ...completedGameRows({
        gameId: "alice-3",
        completedAt: 1_700_000_002_000,
        winnerIndex: 1,
        players: [
          { userId: "alice", username: "Alice", playerId: "alice-3", guessCount: 6 },
          { userId: "alice-op-3", username: "Alice Opp 3", playerId: "alice-op-3", guessCount: 3 },
        ],
      }),
      ...completedGameRows({
        gameId: "alice-4",
        completedAt: 1_700_000_003_000,
        winnerIndex: 0,
        players: [
          { userId: "alice", username: "Alice", playerId: "alice-4", guessCount: 3 },
          { userId: "alice-op-4", username: "Alice Opp 4", playerId: "alice-op-4", guessCount: 6 },
        ],
      }),
      ...completedGameRows({
        gameId: "bob-1",
        completedAt: 1_700_000_004_000,
        winnerIndex: 0,
        players: [
          { userId: "bob", username: "Bob", playerId: "bob-1", guessCount: 3 },
          { userId: "bob-op-1", username: "Bob Opp 1", playerId: "bob-op-1", guessCount: 6 },
        ],
      }),
      ...completedGameRows({
        gameId: "bob-2",
        completedAt: 1_700_000_005_000,
        winnerIndex: 1,
        players: [
          { userId: "bob", username: "Bob", playerId: "bob-2", guessCount: 6 },
          { userId: "bob-op-2", username: "Bob Opp 2", playerId: "bob-op-2", guessCount: 3 },
        ],
      }),
      ...completedGameRows({
        gameId: "bob-3",
        completedAt: 1_700_000_006_000,
        winnerIndex: 1,
        players: [
          { userId: "bob", username: "Bob", playerId: "bob-3", guessCount: 6 },
          { userId: "bob-op-3", username: "Bob Opp 3", playerId: "bob-op-3", guessCount: 3 },
        ],
      }),
      ...completedGameRows({
        gameId: "bob-4",
        completedAt: 1_700_000_007_000,
        winnerIndex: 0,
        players: [
          { userId: "bob", username: "Bob", playerId: "bob-4", guessCount: 3 },
          { userId: "bob-op-4", username: "Bob Opp 4", playerId: "bob-op-4", guessCount: 6 },
        ],
      }),
    ];

    const leaderboard = buildLeaderboard(rows);
    const alice = leaderboard.find((entry) => entry.username === "Alice");
    const bob = leaderboard.find((entry) => entry.username === "Bob");

    expect(alice?.wins).toBe(2);
    expect(bob?.wins).toBe(2);
    expect(alice?.currentWinStreak).toBe(1);
    expect(bob?.currentWinStreak).toBe(1);
    expect(alice?.averageGuessesPerWin).toBe(3);
    expect(bob?.averageGuessesPerWin).toBe(3);
    expect(leaderboard[0]?.username).toBe("Alice");
  });

  it("falls back to username ordering when all ranking metrics are identical", () => {
    const rows: LeaderboardSourceRow[] = [
      ...completedGameRows({
        gameId: "amy-1",
        completedAt: 1_700_000_000_000,
        winnerIndex: 0,
        players: [
          { userId: "amy", username: "Amy", playerId: "amy-1", guessCount: 2 },
          { userId: "amy-op-1", username: "Amy Opp", playerId: "amy-op-1", guessCount: 4 },
        ],
      }),
      ...completedGameRows({
        gameId: "zed-1",
        completedAt: 1_700_000_000_000,
        winnerIndex: 0,
        players: [
          { userId: "zed", username: "Zed", playerId: "zed-1", guessCount: 2 },
          { userId: "zed-op-1", username: "Zed Opp", playerId: "zed-op-1", guessCount: 4 },
        ],
      }),
    ];

    const leaderboard = buildLeaderboard(rows);

    expect(leaderboard[0]?.username).toBe("Amy");
    expect(leaderboard[1]?.username).toBe("Zed");
  });

  it("tracks current streak and keeps only the five most recent results", () => {
    const rows: LeaderboardSourceRow[] = [
      ...completedGameRows({
        gameId: "streak-1",
        completedAt: 1_700_000_000_000,
        winnerIndex: 0,
        players: [
          { userId: "streak", username: "Streak", playerId: "streak-1", guessCount: 2 },
          { userId: "streak-op-1", username: "Opponent 1", playerId: "streak-op-1", guessCount: 4 },
        ],
      }),
      ...completedGameRows({
        gameId: "streak-2",
        completedAt: 1_700_000_001_000,
        winnerIndex: 0,
        players: [
          { userId: "streak", username: "Streak", playerId: "streak-2", guessCount: 2 },
          { userId: "streak-op-2", username: "Opponent 2", playerId: "streak-op-2", guessCount: 4 },
        ],
      }),
      ...completedGameRows({
        gameId: "streak-3",
        completedAt: 1_700_000_002_000,
        winnerIndex: 1,
        players: [
          { userId: "streak", username: "Streak", playerId: "streak-3", guessCount: 4 },
          { userId: "streak-op-3", username: "Opponent 3", playerId: "streak-op-3", guessCount: 2 },
        ],
      }),
      ...completedGameRows({
        gameId: "streak-4",
        completedAt: 1_700_000_003_000,
        winnerIndex: 0,
        players: [
          { userId: "streak", username: "Streak", playerId: "streak-4", guessCount: 2 },
          { userId: "streak-op-4", username: "Opponent 4", playerId: "streak-op-4", guessCount: 4 },
        ],
      }),
      ...completedGameRows({
        gameId: "streak-5",
        completedAt: 1_700_000_004_000,
        winnerIndex: 0,
        players: [
          { userId: "streak", username: "Streak", playerId: "streak-5", guessCount: 2 },
          { userId: "streak-op-5", username: "Opponent 5", playerId: "streak-op-5", guessCount: 4 },
        ],
      }),
      ...completedGameRows({
        gameId: "streak-6",
        completedAt: 1_700_000_005_000,
        winnerIndex: 0,
        players: [
          { userId: "streak", username: "Streak", playerId: "streak-6", guessCount: 2 },
          { userId: "streak-op-6", username: "Opponent 6", playerId: "streak-op-6", guessCount: 4 },
        ],
      }),
    ];

    const leaderboard = buildLeaderboard(rows);
    const streak = leaderboard.find((entry) => entry.username === "Streak");

    expect(streak?.currentWinStreak).toBe(3);
    expect(streak?.recentResults).toEqual(["W", "L", "W", "W", "W"]);
  });
});
