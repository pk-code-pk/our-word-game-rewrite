import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maybeRunBotTurn } from "./botRunner.js";
import { db, initDb } from "./db.js";
import { createBotGame, forfeitGame, getGameState, submitGuess } from "./gameService.js";
import { getLeaderboard } from "./leaderboard.js";
import type { AuthUser } from "./types.js";
import { BOT_DIFFICULTY_CONFIG, BOT_DISPLAY_NAMES } from "../shared/botBrain.js";

function makeUser(id: string, email: string, username = email.split("@")[0] ?? id): AuthUser {
  return { id, email, username, isAnonymous: false, createdAt: Date.now() };
}

function seedUser(user: AuthUser) {
  db.prepare(
    `INSERT INTO users (id, email, username, password_hash, is_anonymous, created_at) VALUES (?, ?, ?, NULL, ?, ?)`
  ).run(user.id, user.email, user.username, user.isAnonymous ? 1 : 0, user.createdAt);
}

function botRow(gameId: string) {
  return db
    .prepare(
      `SELECT id, user_id, username, is_bot, bot_difficulty, bot_next_move_at, alphabet_json, secret_word, total_guesses
       FROM players WHERE game_id = ? AND is_bot = 1`
    )
    .get(gameId) as {
    id: string;
    user_id: string;
    username: string;
    is_bot: number;
    bot_difficulty: string;
    bot_next_move_at: number | null;
    alphabet_json: string;
    secret_word: string;
    total_guesses: number;
  };
}

function botGuessCount(gameId: string) {
  const bot = botRow(gameId);
  return (
    db.prepare(`SELECT COUNT(*) AS count FROM guesses WHERE player_id = ?`).get(bot.id) as { count: number }
  ).count;
}

describe("bot runner", () => {
  let currentNow = 1_700_000_000_000;
  const human = makeUser("user-human", "human@example.com", "human");

  beforeEach(async () => {
    initDb();
    db.exec(`
      PRAGMA foreign_keys = OFF;
      DELETE FROM game_invites;
      DELETE FROM friendships;
      DELETE FROM friend_requests;
      DELETE FROM player_presence;
      DELETE FROM chat_messages;
      DELETE FROM guesses;
      DELETE FROM players;
      DELETE FROM games;
      DELETE FROM sessions;
      DELETE FROM user_stats;
      DELETE FROM users;
      PRAGMA foreign_keys = ON;
    `);
    currentNow = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => currentNow);
    seedUser(human);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function advanceTime(ms: number) {
    currentNow += ms;
  }

  async function startBotGame(difficulty: "easy" | "medium" | "hard" = "medium") {
    return createBotGame(human, "human", "CHAIR", difficulty);
  }

  it("opens already active with both seats filled", async () => {
    const { gameId, botName } = await startBotGame();

    expect(botName).toBe(BOT_DISPLAY_NAMES.medium);

    const game = db.prepare(`SELECT status, public FROM games WHERE id = ?`).get(gameId) as {
      status: string;
      public: number;
    };
    expect(game.status).toBe("active");
    // Never listed in public lobbies — there is no seat to fill.
    expect(game.public).toBe(0);

    const state = await getGameState(human, gameId);
    expect(state?.opponent?.username).toBe(BOT_DISPLAY_NAMES.medium);
    expect(state?.opponent?.isBot).toBe(true);
  });

  it("gives the bot its own valid secret, hidden until the game ends", async () => {
    const { gameId } = await startBotGame();
    const bot = botRow(gameId);

    expect(bot.secret_word).toMatch(/^[A-Z]{5}$/);
    expect(new Set(bot.secret_word).size).toBe(5);

    const state = await getGameState(human, gameId);
    expect(state?.opponent?.secretWord).toBeUndefined();
  });

  it("does not move before its turn is due", async () => {
    const { gameId } = await startBotGame();

    expect(await maybeRunBotTurn(gameId)).toBe(false);
    expect(botGuessCount(gameId)).toBe(0);
  });

  it("moves once the scheduled time arrives", async () => {
    const { gameId } = await startBotGame();

    advanceTime(BOT_DIFFICULTY_CONFIG.medium.maxDelayMs + 1);
    expect(await maybeRunBotTurn(gameId)).toBe(true);
    expect(botGuessCount(gameId)).toBe(1);

    const bot = botRow(gameId);
    expect(bot.total_guesses).toBe(1);
    // Rescheduled forward rather than left due.
    expect(bot.bot_next_move_at).toBeGreaterThan(currentNow);
  });

  it("lets only one of several concurrent ticks take the turn", async () => {
    const { gameId } = await startBotGame();
    advanceTime(BOT_DIFFICULTY_CONFIG.medium.maxDelayMs + 1);

    // Mirrors the real hazard: a poll, a broadcast refetch, and a guess POST all
    // landing on the same due turn at once.
    const results = await Promise.all([
      maybeRunBotTurn(gameId),
      maybeRunBotTurn(gameId),
      maybeRunBotTurn(gameId),
      maybeRunBotTurn(gameId),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(botGuessCount(gameId)).toBe(1);
  });

  it("marks its alphabet from what it has actually deduced", async () => {
    const { gameId } = await startBotGame();

    const before = JSON.parse(botRow(gameId).alphabet_json) as Record<string, string>;
    expect(Object.values(before).every((state) => state === "unknown")).toBe(true);

    // Several turns in, the field has narrowed enough to have ruled letters out.
    for (let turn = 0; turn < 6; turn += 1) {
      advanceTime(BOT_DIFFICULTY_CONFIG.medium.maxDelayMs + 1);
      await maybeRunBotTurn(gameId);
    }

    const after = JSON.parse(botRow(gameId).alphabet_json) as Record<string, string>;
    expect(Object.values(after).some((state) => state !== "unknown")).toBe(true);
  });

  it("plays through to a win and then stops scheduling", async () => {
    const { gameId } = await startBotGame("hard");

    let solved = false;
    for (let turn = 0; turn < 60 && !solved; turn += 1) {
      advanceTime(BOT_DIFFICULTY_CONFIG.hard.maxDelayMs + 1);
      await maybeRunBotTurn(gameId);
      const game = db.prepare(`SELECT status FROM games WHERE id = ?`).get(gameId) as { status: string };
      solved = game.status === "completed";
    }

    expect(solved).toBe(true);

    const bot = botRow(gameId);
    expect(bot.bot_next_move_at).toBeNull();

    // A finished game must not keep generating guesses on later polls.
    const guessesAtEnd = botGuessCount(gameId);
    advanceTime(BOT_DIFFICULTY_CONFIG.hard.maxDelayMs + 1);
    expect(await maybeRunBotTurn(gameId)).toBe(false);
    expect(botGuessCount(gameId)).toBe(guessesAtEnd);
  });

  it("never guesses the human's secret before deducing it", async () => {
    // The bot's own secret is CHAIR-adjacent only by coincidence; what matters
    // is that it cannot open with the answer. A bot reading the secret directly
    // would solve on move one.
    const { gameId } = await startBotGame("hard");

    advanceTime(BOT_DIFFICULTY_CONFIG.hard.maxDelayMs + 1);
    await maybeRunBotTurn(gameId);

    const first = db
      .prepare(`SELECT type, text FROM guesses WHERE player_id = ? ORDER BY guess_number ASC`)
      .get(botRow(gameId).id) as { type: string; text: string };

    expect(first.type).toBe("fourLetter");
    expect(first.text).not.toBe("CHAIR");
  });

  it("is a no-op for games with no bot in them", async () => {
    const other = makeUser("user-other", "other@example.com", "other");
    seedUser(other);

    const { gameId } = (await (
      await import("./gameService.js")
    ).createGame(human, "human", "CHAIR", true)) as { gameId: string; code: string };

    expect(await maybeRunBotTurn(gameId)).toBe(false);
  });

  it("keeps bot results off the leaderboard", async () => {
    const { gameId } = await startBotGame("hard");

    // Human wins outright.
    const bot = botRow(gameId);
    advanceTime(2_000);
    const result = await submitGuess(human, gameId, "fullWord", bot.secret_word);
    expect(result.isCorrect).toBe(true);

    expect(db.prepare(`SELECT COUNT(*) AS count FROM user_stats`).get()).toEqual({ count: 0 });
    expect(await getLeaderboard()).toHaveLength(0);
  });

  it("keeps a forfeited bot game off the leaderboard too", async () => {
    const { gameId } = await startBotGame();

    advanceTime(2_000);
    await forfeitGame(human, gameId);

    expect(db.prepare(`SELECT COUNT(*) AS count FROM user_stats`).get()).toEqual({ count: 0 });
    expect(await getLeaderboard()).toHaveLength(0);
  });

  it("still records stats for games between two humans", async () => {
    const other = makeUser("user-other", "other@example.com", "other");
    seedUser(other);

    const gameService = await import("./gameService.js");
    const { code, gameId } = (await gameService.createGame(human, "human", "CHAIR", true)) as {
      gameId: string;
      code: string;
    };
    await gameService.joinGame(other, code, "other", "MOUNT");

    advanceTime(2_000);
    await submitGuess(human, gameId, "fullWord", "MOUNT");

    const stats = db.prepare(`SELECT COUNT(*) AS count FROM user_stats`).get() as { count: number };
    expect(stats.count).toBe(2);
  });
});
