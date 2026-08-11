import { describe, expect, it } from "vitest";
import { inferApiErrorMessage, normalizeGameStateResponse } from "./api";

// These payloads omit fields ON PURPOSE — that is what normalizeGameStateResponse
// exists to repair, and what each test asserts. Typing them as the full
// GameStateView would defeat the test, so the legacy shape is cast at the call
// site instead of being padded out with fields a legacy server never sent.
type RawGameStatePayload = Parameters<typeof normalizeGameStateResponse>[0];
const normalizeLegacy = (payload: unknown) => normalizeGameStateResponse(payload as RawGameStatePayload);

describe("normalizeGameStateResponse", () => {
  it("fills in safe defaults for legacy game-state payloads missing presence", () => {
    const payload = normalizeLegacy({
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
      },
    });

    expect(payload.gameState).not.toBeNull();
    expect(payload.gameState?.presence).toEqual({
      me: "offline",
      opponent: "offline",
    });
    expect(payload.gameState?.opponentFoundLetterCount).toBeNull();
  });

  it("preserves the server-derived opponent progress count when present", () => {
    const payload = normalizeLegacy({
      gameState: {
        game: {
          id: "game-3",
          code: "FOUND1",
          status: "active",
          public: false,
          createdAt: 1,
          lastActivityAt: 3,
        },
        me: {
          id: "player-1",
          username: "Host",
          alphabet: {
            A: "unknown",
          },
          totalGuesses: 1,
        },
        opponent: {
          id: "player-2",
          username: "Joiner",
          totalGuesses: 2,
        },
        myGuesses: [],
        opponentFoundLetterCount: 4,
      },
    });

    expect(payload.gameState?.opponentFoundLetterCount).toBe(4);
    expect(payload.gameState?.opponentGuesses).toEqual([]);
  });

  it("keeps opponent presence null when there is no opponent yet", () => {
    const payload = normalizeLegacy({
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
    expect(payload.gameState?.me.alphabet).toEqual({});
    expect(payload.gameState?.opponentFoundLetterCount).toBeNull();
  });
});

describe("inferApiErrorMessage", () => {
  it("detects Vercel deployment protection responses", () => {
    const message = inferApiErrorMessage({
      status: 401,
      statusText: "Unauthorized",
      path: "/api/auth/signin",
      contentType: "text/html; charset=utf-8",
      responseText: "<title>Authentication Required</title><a>Vercel Authentication</a>",
      payload: null,
    });

    expect(message).toContain("Vercel Authentication");
    expect(message).toContain("/api/auth/signin");
  });

  it("prefers API payload errors when JSON is available", () => {
    const message = inferApiErrorMessage({
      status: 400,
      statusText: "Bad Request",
      path: "/api/auth/signup",
      contentType: "application/json; charset=utf-8",
      responseText: "{\"error\":\"Could not sign up.\"}",
      payload: { error: "Could not sign up." },
    });

    expect(message).toBe("Could not sign up.");
  });
});
