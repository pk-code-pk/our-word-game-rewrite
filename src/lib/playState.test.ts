import { describe, expect, it } from "vitest";
import { clearActiveGame, createDefaultPlayState, normalizePlayState, resetPlayState } from "./playState";

describe("normalizePlayState", () => {
  it("falls back to the account username and derives lobby phase from a saved word", () => {
    expect(
      normalizePlayState(
        {
          secretWord: "crane",
        },
        { username: "AccountName" }
      )
    ).toEqual({
      username: "AccountName",
      secretWord: "CRANE",
      gamePhase: "lobby",
      currentGameId: "",
      lobbyCode: "",
      isPublic: false,
    });
  });

  it("keeps a saved active game when present", () => {
    expect(
      normalizePlayState(
        {
          username: "ArenaName",
          secretWord: "SLATE",
          currentGameId: "game-123",
          gamePhase: "playing",
          lobbyCode: "abc123",
          isPublic: true,
        },
        { username: "AccountName" }
      )
    ).toEqual({
      username: "ArenaName",
      secretWord: "SLATE",
      gamePhase: "playing",
      currentGameId: "game-123",
      lobbyCode: "ABC123",
      isPublic: true,
    });
  });

  it("drops an invalid playing phase back to setup or lobby when no game is selected", () => {
    expect(normalizePlayState({ gamePhase: "playing" }, { username: "AccountName" }).gamePhase).toBe("setup");
    expect(normalizePlayState({ gamePhase: "playing", secretWord: "CRANE" }, { username: "AccountName" }).gamePhase).toBe("lobby");
  });
});

describe("playState helpers", () => {
  it("returns to the lobby after leaving a game when a secret word is still set", () => {
    const state = normalizePlayState(
      {
        username: "ArenaName",
        secretWord: "CRANE",
        currentGameId: "game-123",
        gamePhase: "playing",
      },
      { username: "AccountName" }
    );

    expect(clearActiveGame(state)).toEqual({
      username: "ArenaName",
      secretWord: "CRANE",
      currentGameId: "",
      gamePhase: "lobby",
      lobbyCode: "",
      isPublic: false,
    });
  });

  it("fully clears the secret-word flow only when explicitly reset", () => {
    const state = normalizePlayState(
      {
        username: "ArenaName",
        secretWord: "CRANE",
        currentGameId: "game-123",
        gamePhase: "playing",
        lobbyCode: "ROOM42",
        isPublic: true,
      },
      { username: "AccountName" }
    );

    expect(resetPlayState(state)).toEqual({
      username: "ArenaName",
      secretWord: "",
      currentGameId: "",
      gamePhase: "setup",
      lobbyCode: "",
      isPublic: false,
    });
  });

  it("creates a sane default state for a new account", () => {
    expect(createDefaultPlayState({ username: "AccountName" })).toEqual({
      username: "AccountName",
      secretWord: "",
      gamePhase: "setup",
      currentGameId: "",
      lobbyCode: "",
      isPublic: false,
    });
  });
});
