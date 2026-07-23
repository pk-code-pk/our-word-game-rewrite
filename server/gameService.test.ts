import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, initDb } from "./db.js";
import {
  cleanupExpiredWaitingGames,
  createGame,
  cancelWaitingLobby,
  forfeitGame,
  getGameState,
  joinGame,
  listPublicLobbies,
  markGamePresenceOffline,
  submitGuess,
  updateAlphabet,
} from "./gameService.js";
// getLeaderboard now lives in leaderboard.ts (the served source of truth,
// recomputed from games/players/guesses). gameService no longer owns a copy.
import { getLeaderboard } from "./leaderboard.js";
import type { AuthUser } from "./types.js";
import { GUESS_BURST_LIMIT, GUESS_COOLDOWN_MS } from "../shared/gameLogic.js";
import { PLAYER_PRESENCE_OFFLINE_TTL_MS } from "./presence.js";

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

describe("game service", () => {
  let currentNow = 1_700_000_000_000;

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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function advanceTime(ms: number) {
    currentNow += ms;
  }

  it("creates and lists a public lobby", () => {
    const alpha = makeUser("user-alpha", "alpha@example.com");
    seedUser(alpha);

    const created = createGame(alpha, "Alpha", "CRANE", true);
    const lobbies = listPublicLobbies();

    expect(created.code).toHaveLength(6);
    expect(lobbies.openLobbies).toHaveLength(1);
    expect(lobbies.openLobbies[0]?.host).toBe("Alpha");
  });

  it("cancels a waiting lobby and removes it from public views", () => {
    const alpha = makeUser("user-alpha", "alpha@example.com");
    seedUser(alpha);

    const created = createGame(alpha, "Alpha", "CRANE", true);
    expect(listPublicLobbies().openLobbies).toHaveLength(1);

    const result = cancelWaitingLobby(alpha, created.gameId);

    expect(result.cancelled).toBe(true);
    expect(listPublicLobbies().openLobbies).toHaveLength(0);
    expect(getGameState(alpha, created.gameId)).toBeNull();
    expect(() => joinGame(makeUser("user-bravo", "bravo@example.com"), created.code, "Bravo", "LIGHT")).toThrow(
      /game not found/i
    );
  });

  it("hides secret words until the game is completed", () => {
    const alpha = makeUser("user-alpha", "alpha@example.com");
    const bravo = makeUser("user-bravo", "bravo@example.com");
    seedUser(alpha);
    seedUser(bravo);

    const created = createGame(alpha, "Alpha", "CRANE", true);
    joinGame(bravo, created.code, "Bravo", "LIGHT");

    const alphaState = getGameState(alpha, created.gameId);
    const bravoState = getGameState(bravo, created.gameId);

    expect(alphaState?.me.secretWord).toBeUndefined();
    expect(alphaState?.opponent?.secretWord).toBeUndefined();
    expect(bravoState?.me.secretWord).toBeUndefined();
    expect(bravoState?.opponent?.secretWord).toBeUndefined();
  });

  it("reveals secret words after completion and updates the leaderboard", () => {
    const alpha = makeUser("user-alpha", "alpha@example.com");
    const bravo = makeUser("user-bravo", "bravo@example.com");
    seedUser(alpha);
    seedUser(bravo);

    const created = createGame(alpha, "Alpha", "CRANE", true);
    joinGame(bravo, created.code, "Bravo", "LIGHT");

    const result = submitGuess(alpha, created.gameId, "fullWord", "LIGHT");
    expect(result.isCorrect).toBe(true);

    const completed = getGameState(alpha, created.gameId);
    expect(completed?.me.secretWord).toBe("CRANE");
    expect(completed?.opponent?.secretWord).toBe("LIGHT");

    const leaderboard = getLeaderboard();
    expect(leaderboard[0]?.username).toBe("Alpha");
    expect(leaderboard[0]?.wins).toBe(1);
  });

  it("locks alphabet edits once a game is completed", () => {
    const alpha = makeUser("user-alpha", "alpha@example.com");
    const bravo = makeUser("user-bravo", "bravo@example.com");
    seedUser(alpha);
    seedUser(bravo);

    const created = createGame(alpha, "Alpha", "CRANE", true);
    joinGame(bravo, created.code, "Bravo", "LIGHT");
    submitGuess(alpha, created.gameId, "fullWord", "LIGHT");

    expect(() => updateAlphabet(alpha, created.gameId, "A", "present")).toThrow(/game is not active/i);
  });

  it("surfaces opponent presence as offline after inactivity and explicit offline marking", () => {
    const alpha = makeUser("user-alpha", "alpha@example.com");
    const bravo = makeUser("user-bravo", "bravo@example.com");
    seedUser(alpha);
    seedUser(bravo);

    const created = createGame(alpha, "Alpha", "CRANE", true);
    joinGame(bravo, created.code, "Bravo", "LIGHT");

    const freshState = getGameState(alpha, created.gameId);
    expect(freshState?.presence.me).toBe("online");
    expect(freshState?.presence.opponent).toBe("online");

    advanceTime(PLAYER_PRESENCE_OFFLINE_TTL_MS + 1);
    const staleState = getGameState(alpha, created.gameId);
    expect(staleState?.presence.me).toBe("online");
    expect(staleState?.presence.opponent).toBe("offline");

    markGamePresenceOffline(bravo, created.gameId);
    const alphaViewAfterExplicitOffline = getGameState(alpha, created.gameId);
    expect(alphaViewAfterExplicitOffline?.presence.opponent).toBe("offline");
  });

  it("returns how many of your real letters the opponent has identified", () => {
    const alpha = makeUser("user-alpha", "alpha@example.com");
    const bravo = makeUser("user-bravo", "bravo@example.com");
    seedUser(alpha);
    seedUser(bravo);

    const created = createGame(alpha, "Alpha", "CRANE", true);
    joinGame(bravo, created.code, "Bravo", "LIGHT");

    updateAlphabet(bravo, created.gameId, "C", "present");
    updateAlphabet(bravo, created.gameId, "R", "present");
    updateAlphabet(bravo, created.gameId, "Z", "present");
    updateAlphabet(bravo, created.gameId, "A", "absent");

    const alphaState = getGameState(alpha, created.gameId);
    const bravoState = getGameState(bravo, created.gameId);

    expect(alphaState?.opponentFoundLetterCount).toBe(2);
    expect(bravoState?.opponentFoundLetterCount).toBe(0);
  });

  it("rate limits rapid guess spam while allowing normal pacing", () => {
    const alpha = makeUser("user-alpha", "alpha@example.com");
    const bravo = makeUser("user-bravo", "bravo@example.com");
    seedUser(alpha);
    seedUser(bravo);

    const created = createGame(alpha, "Alpha", "CRANE", true);
    joinGame(bravo, created.code, "Bravo", "LIGHT");

    submitGuess(alpha, created.gameId, "fourLetter", "CARD");

    expect(() => submitGuess(alpha, created.gameId, "fourLetter", "BEND")).toThrow(
      /guessing too quickly/i
    );

    const followUpWords = ["BEND", "DIME", "FARM", "CARD"];
    for (let attempt = 2; attempt <= GUESS_BURST_LIMIT; attempt += 1) {
      advanceTime(GUESS_COOLDOWN_MS + 1);
      const result = submitGuess(alpha, created.gameId, "fourLetter", followUpWords[attempt - 2] ?? "CARD");
      expect(result.guessNumber).toBe(attempt);
    }

    advanceTime(GUESS_COOLDOWN_MS + 1);
    expect(() => submitGuess(alpha, created.gameId, "fourLetter", "FARM")).toThrow(
      /guess rate limit reached/i
    );
  });

  it("keeps join capacity capped at two players", () => {
    const alpha = makeUser("user-alpha", "alpha@example.com");
    const bravo = makeUser("user-bravo", "bravo@example.com");
    const charlie = makeUser("user-charlie", "charlie@example.com");
    seedUser(alpha);
    seedUser(bravo);
    seedUser(charlie);

    const created = createGame(alpha, "Alpha", "CRANE", true);
    joinGame(bravo, created.code, "Bravo", "LIGHT");

    expect(() => joinGame(charlie, created.code, "Charlie", "SOUND")).toThrow(
      /game is full|game already started or completed/i
    );
  });

  it("allows reusing a secret word across multiple games by the same player", () => {
    const alpha = makeUser("user-alpha", "alpha@example.com");
    seedUser(alpha);

    const first = createGame(alpha, "Alpha", "CRANE", false);
    const second = createGame(alpha, "Alpha", "CRANE", false);

    expect(first.gameId).not.toBe(second.gameId);
    expect(first.code).not.toBe(second.code);
  });

  it("forfeits an active game to the opponent and records the loss/win", () => {
    const alpha = makeUser("user-alpha", "alpha@example.com");
    const bravo = makeUser("user-bravo", "bravo@example.com");
    seedUser(alpha);
    seedUser(bravo);

    const created = createGame(alpha, "Alpha", "CRANE", true);
    joinGame(bravo, created.code, "Bravo", "LIGHT");

    const bravoState = getGameState(bravo, created.gameId);
    const bravoPlayerId = bravoState?.me.id;

    const result = forfeitGame(alpha, created.gameId);

    expect(result.status).toBe("completed");
    expect(result.winnerPlayerId).toBe(bravoPlayerId);

    const completed = getGameState(alpha, created.gameId);
    expect(completed?.game.status).toBe("completed");
    expect(completed?.game.winnerId).toBe(bravoPlayerId);

    const leaderboard = getLeaderboard();
    const bravoEntry = leaderboard.find((entry) => entry.username === "Bravo");
    const alphaEntry = leaderboard.find((entry) => entry.username === "Alpha");
    expect(bravoEntry?.wins).toBe(1);
    expect(alphaEntry?.wins).toBe(0);
    expect(alphaEntry?.gamesPlayed).toBe(1);

    expect(() => forfeitGame(alpha, created.gameId)).toThrow(/game is not active/i);
  });

  it("reaps abandoned active games after six hours of inactivity", () => {
    const alpha = makeUser("user-alpha", "alpha@example.com");
    const bravo = makeUser("user-bravo", "bravo@example.com");
    seedUser(alpha);
    seedUser(bravo);

    const created = createGame(alpha, "Alpha", "CRANE", true);
    joinGame(bravo, created.code, "Bravo", "LIGHT");

    advanceTime(6 * 60 * 60 * 1000 + 1);
    cleanupExpiredWaitingGames();

    const row = db
      .prepare(`SELECT status, winner_player_id FROM games WHERE id = ?`)
      .get(created.gameId) as { status: string; winner_player_id: string | null } | undefined;
    expect(row?.status).toBe("completed");
    expect(row?.winner_player_id).toBeNull();
  });

  it("tracks average guesses per win using wins only", () => {
    const alpha = makeUser("user-alpha", "alpha@example.com");
    const bravo = makeUser("user-bravo", "bravo@example.com");
    seedUser(alpha);
    seedUser(bravo);

    const first = createGame(alpha, "Alpha", "CRANE", false);
    joinGame(bravo, first.code, "Bravo", "LIGHT");
    submitGuess(alpha, first.gameId, "fourLetter", "CARD");
    advanceTime(GUESS_COOLDOWN_MS + 1);
    submitGuess(alpha, first.gameId, "fourLetter", "BEND");
    advanceTime(GUESS_COOLDOWN_MS + 1);
    submitGuess(alpha, first.gameId, "fullWord", "LIGHT");

    const second = createGame(alpha, "Alpha", "EARTH", false);
    joinGame(bravo, second.code, "Bravo", "SOUND");
    advanceTime(GUESS_COOLDOWN_MS + 1);
    submitGuess(alpha, second.gameId, "fourLetter", "CARD");
    advanceTime(GUESS_COOLDOWN_MS + 1);
    submitGuess(alpha, second.gameId, "fourLetter", "BEND");
    advanceTime(GUESS_COOLDOWN_MS + 1);
    submitGuess(alpha, second.gameId, "fourLetter", "DIME");
    advanceTime(GUESS_COOLDOWN_MS + 1);
    submitGuess(alpha, second.gameId, "fourLetter", "FARM");
    advanceTime(GUESS_COOLDOWN_MS + 1);
    submitGuess(bravo, second.gameId, "fullWord", "EARTH");

    const leaderboard = getLeaderboard();
    const alphaEntry = leaderboard.find((entry) => entry.username === "Alpha");

    expect(alphaEntry?.wins).toBe(1);
    expect(alphaEntry?.gamesPlayed).toBe(2);
    expect(alphaEntry?.averageGuessesPerWin).toBe(3);
  });
});
