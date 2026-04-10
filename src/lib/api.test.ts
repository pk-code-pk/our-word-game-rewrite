import { describe, expect, it } from "vitest";
import { normalizeGameStateResponse } from "./api";

describe("normalizeGameStateResponse", () => {
  it("fills in safe defaults for legacy game-state payloads missing presence", () => {
    const payload = normalizeGameStateResponse({
      gameState: {
        game: {
          id: "game-1",
          code: "ABC123",
          status: "active",
          public: false,
          createdAt: 1,
          lastActivityAt: 2,
        },
        me: {
          id: "player-1",
          username: "Host",
          alphabet: {
            A: "unknown",
          },
          totalGuesses: 0,
        },
        opponent: {
          id: "player-2",
          username: "Joiner",
          totalGuesses: 0,
        },
        myGuesses: [],
        opponentGuesses: [],
        canChat: true,
      },
    });

    expect(payload.gameState).not.toBeNull();
    expect(payload.gameState?.presence).toEqual({
      me: "offline",
      opponent: "offline",
    });
    expect(payload.gameState?.canChat).toBe(true);
  });

  it("keeps opponent presence null when there is no opponent yet", () => {
    const payload = normalizeGameStateResponse({
      gameState: {
        game: {
          id: "game-2",
          code: "WAIT42",
          status: "waiting",
          public: false,
          createdAt: 1,
          lastActivityAt: 1,
        },
        me: {
          id: "player-1",
          username: "Host",
          totalGuesses: 0,
        },
        opponent: null,
        myGuesses: [],
        opponentGuesses: [],
      },
    });

    expect(payload.gameState?.presence).toEqual({
      me: "offline",
      opponent: null,
    });
    expect(payload.gameState?.canChat).toBe(false);
    expect(payload.gameState?.me.alphabet).toEqual({});
  });
});
