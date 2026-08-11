import { afterEach, describe, expect, it } from "vitest";
import { clearActiveGame, createDefaultPlayState, normalizePlayState, readStoredPlayState, resetPlayState, writeStoredPlayState } from "./playState";

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
  it("drops the secret word when leaving a game so the lobby box starts empty", () => {
    const state = normalizePlayState(
      {
        username: "ArenaName",
        secretWord: "CRANE",
        currentGameId: "game-123",
        gamePhase: "playing",
      },
      { username: "AccountName" }
    );

    // Every route back to the lobby goes through here, and a finished game has
    // revealed both words — carrying the old secret forward let a player start
    // the next game with a word the opponent had already seen.
    expect(clearActiveGame(state)).toEqual({
      username: "ArenaName",
      secretWord: "",
      currentGameId: "",
      gamePhase: "setup",
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

// The suite runs in node with no DOM, so stub just the storage surface
// playState.ts touches rather than pulling in jsdom for two assertions.
function useFakeStorage() {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  (globalThis as { window?: unknown }).window = { localStorage };
  return localStorage;
}

describe("the secret word is never persisted", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("does not restore a secret word from storage, including the legacy key", () => {
    const storage = useFakeStorage();
    const userId = "user-1";
    storage.setItem(
      `fourfive.playState.${userId}`,
      JSON.stringify({ username: "ArenaName", secretWord: "CRANE", currentGameId: "", gamePhase: "lobby", lobbyCode: "", isPublic: false })
    );
    // Left behind by builds from before the word stopped being persisted.
    storage.setItem(`fourfive.secretWord.${userId}`, "STOLE");

    expect(readStoredPlayState(userId, { username: "AccountName" }).secretWord).toBe("");
  });

  it("writes an empty secret word and clears the legacy key", () => {
    const storage = useFakeStorage();
    const userId = "user-2";
    storage.setItem(`fourfive.secretWord.${userId}`, "STALE");

    writeStoredPlayState(userId, {
      username: "ArenaName",
      secretWord: "CRANE",
      currentGameId: "",
      gamePhase: "lobby",
      lobbyCode: "",
      isPublic: false,
    });

    expect(storage.getItem(`fourfive.secretWord.${userId}`)).toBeNull();
    expect(JSON.parse(storage.getItem(`fourfive.playState.${userId}`) ?? "{}").secretWord).toBe("");
  });
});
