// Adversarial pass over the bot feature: things that should NOT be possible,
// and races that only show up under concurrency.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maybeRunBotTurn } from "./botRunner.js";
import { db, initDb } from "./db.js";
import { createBotGame, getGameState, joinGame, submitGuess } from "./gameService.js";
import type { AuthUser } from "./types.js";
import { BOT_DIFFICULTY_CONFIG } from "../shared/botBrain.js";

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
    .prepare(`SELECT id, secret_word, bot_difficulty FROM players WHERE game_id = ? AND is_bot = 1`)
    .get(gameId) as { id: string; secret_word: string; bot_difficulty: string };
}

function guessCount(playerId: string) {
  return (db.prepare(`SELECT COUNT(*) AS count FROM guesses WHERE player_id = ?`).get(playerId) as { count: number })
    .count;
}

describe("bot feature — adversarial", () => {
  let currentNow = 1_700_000_000_000;
  const human = makeUser("user-human", "human@example.com", "human");
  const stranger = makeUser("user-stranger", "stranger@example.com", "stranger");

  beforeEach(() => {
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
    seedUser(stranger);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const advanceTime = (ms: number) => {
    currentNow += ms;
  };

  // joinGame throws synchronously on SQLite and rejects on Postgres, so the
  // assertion has to tolerate both shapes.
  async function captureFailure(run: () => unknown): Promise<Error> {
    try {
      await run();
    } catch (error) {
      return error as Error;
    }
    throw new Error("expected the call to fail, but it succeeded");
  }

  it("refuses to let a third player join a bot game with its code", async () => {
    const { code } = await createBotGame(human, "human", "CHAIR", "medium");

    const error = await captureFailure(() => joinGame(stranger, code, "stranger", "MOUNT"));
    expect(error.message).toMatch(/already started|not found|full/i);

    const players = db.prepare(`SELECT COUNT(*) AS count FROM players WHERE game_id IN (SELECT id FROM games WHERE code = ?)`).get(code) as { count: number };
    expect(players.count).toBe(2);
  });

  it("does not expose a bot game to a non-participant", async () => {
    const { gameId } = await createBotGame(human, "human", "CHAIR", "medium");
    expect(await getGameState(stranger, gameId)).toBeNull();
  });

  it("never reveals the bot's secret mid-game, even after many turns", async () => {
    const { gameId } = await createBotGame(human, "human", "CHAIR", "hard");
    const secret = botRow(gameId).secret_word;

    for (let turn = 0; turn < 5; turn += 1) {
      advanceTime(BOT_DIFFICULTY_CONFIG.hard.maxDelayMs + 1);
      await maybeRunBotTurn(gameId);
    }

    const state = await getGameState(human, gameId);
    expect(state?.game.status).toBe("active");
    expect(state?.opponent?.secretWord).toBeUndefined();
    expect(JSON.stringify(state)).not.toContain(secret);
  });

  it("drops a claimed turn rather than writing into a game that just ended", async () => {
    const { gameId } = await createBotGame(human, "human", "CHAIR", "hard");
    const bot = botRow(gameId);
    advanceTime(BOT_DIFFICULTY_CONFIG.hard.maxDelayMs + 1);

    // The human's winning guess lands while the bot's turn is due. The bot must
    // not append a guess to a completed game, and must not throw.
    const [, botMoved] = await Promise.all([
      submitGuess(human, gameId, "fullWord", bot.secret_word),
      maybeRunBotTurn(gameId),
    ]);

    const game = db.prepare(`SELECT status FROM games WHERE id = ?`).get(gameId) as { status: string };
    expect(game.status).toBe("completed");

    // Whether the bot squeezed a probe in before the win is a genuine race, but
    // it must never leave the game inconsistent: at most one guess, and the
    // winner must still be the human.
    expect(guessCount(bot.id)).toBeLessThanOrEqual(1);
    expect(typeof botMoved).toBe("boolean");

    const winner = db.prepare(`SELECT winner_player_id FROM games WHERE id = ?`).get(gameId) as {
      winner_player_id: string;
    };
    expect(winner.winner_player_id).not.toBe(bot.id);
  });

  it("keeps concurrent bot games for one player completely separate", async () => {
    const first = await createBotGame(human, "human", "CHAIR", "hard");
    const second = await createBotGame(human, "human", "MOUNT", "hard");
    const third = await createBotGame(human, "human", "BLAZE", "hard");

    expect(new Set([first.gameId, second.gameId, third.gameId]).size).toBe(3);

    advanceTime(BOT_DIFFICULTY_CONFIG.hard.maxDelayMs + 1);
    await Promise.all([
      maybeRunBotTurn(first.gameId),
      maybeRunBotTurn(second.gameId),
      maybeRunBotTurn(third.gameId),
    ]);

    // All three bots share one user account, so a game_id filter slipping
    // anywhere would show up as guesses landing on the wrong board.
    for (const game of [first, second, third]) {
      expect(guessCount(botRow(game.gameId).id)).toBe(1);
    }
  });

  it("survives a bot row with a corrupted difficulty instead of crashing the request", async () => {
    const { gameId } = await createBotGame(human, "human", "CHAIR", "medium");
    db.prepare(`UPDATE players SET bot_difficulty = 'impossible' WHERE game_id = ? AND is_bot = 1`).run(gameId);

    advanceTime(BOT_DIFFICULTY_CONFIG.medium.maxDelayMs + 1);
    await expect(maybeRunBotTurn(gameId)).resolves.toBe(false);

    // The human's own view must still load.
    expect(await getGameState(human, gameId)).not.toBeNull();
  });

  it("rejects an unknown difficulty at creation", async () => {
    await expect(createBotGame(human, "human", "CHAIR", "impossible")).rejects.toThrow(/difficulty/i);
    await expect(createBotGame(human, "human", "CHAIR", "")).rejects.toThrow(/difficulty/i);
  });

  it("applies the same word validation the human gets", async () => {
    await expect(createBotGame(human, "human", "AAAAA", "medium")).rejects.toThrow(/duplicate/i);
    await expect(createBotGame(human, "human", "ZZZZZ", "medium")).rejects.toThrow();
    await expect(createBotGame(human, "human", "CHAI", "medium")).rejects.toThrow(/5 letters/i);
    await expect(createBotGame(human, "", "CHAIR", "medium")).rejects.toThrow(/username/i);
  });

  it("stays inside the guess rate limit across a long game", async () => {
    const { gameId } = await createBotGame(human, "human", "CHAIR", "hard");
    const bot = botRow(gameId);

    // Drive many turns at the bot's fastest legal cadence. If the pacing config
    // ever drifts past the burst limit, submitGuess starts throwing and the
    // guess count stops tracking the number of turns.
    let turns = 0;
    for (let i = 0; i < 6; i += 1) {
      advanceTime(BOT_DIFFICULTY_CONFIG.hard.minDelayMs);
      const game = db.prepare(`SELECT status FROM games WHERE id = ?`).get(gameId) as { status: string };
      if (game.status !== "active") break;
      if (await maybeRunBotTurn(gameId)) turns += 1;
    }

    expect(turns).toBeGreaterThan(0);
    expect(guessCount(bot.id)).toBe(turns);
  });

  it("does not resurrect a deleted game", async () => {
    const { gameId } = await createBotGame(human, "human", "CHAIR", "medium");
    db.exec(`PRAGMA foreign_keys = ON`);
    db.prepare(`DELETE FROM games WHERE id = ?`).run(gameId);

    advanceTime(BOT_DIFFICULTY_CONFIG.medium.maxDelayMs + 1);
    await expect(maybeRunBotTurn(gameId)).resolves.toBe(false);
  });
});
