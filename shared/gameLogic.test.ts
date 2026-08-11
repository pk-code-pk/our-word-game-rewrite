import { describe, expect, it } from "vitest";
import {
  buildGameStateView,
  calculateMatchCount,
  computeOpponentGreenLetterInsight,
  countDiscoveredSecretLetters,
  createEmptyAlphabet,
  getNextAlphabetState,
  getChatModerationError,
  getChatRateLimitError,
  getGuessRateLimitError,
  isWaitingGameExpired,
  GUESS_BURST_LIMIT,
  GUESS_BURST_WINDOW_MS,
  GUESS_COOLDOWN_MS,
  GUESS_SUBMIT_LOCK_MS,
  pushRecentResult,
  sanitizeChatText,
} from "./gameLogic.js";
import { getWordValidationReason, isAllowedGameWord } from "./wordBank.js";

describe("word bank", () => {
  it("accepts known local words and rejects invalid ones", () => {
    expect(isAllowedGameWord("crane", 5)).toBe(true);
    expect(isAllowedGameWord("card", 4)).toBe(true);
    expect(isAllowedGameWord("zzzzz", 5)).toBe(false);
    expect(getWordValidationReason("crane", 5)).toBe("");
    expect(getWordValidationReason("apple", 5)).toContain("Duplicate");
  });
});

describe("game helpers", () => {
  it("creates a complete alphabet board", () => {
    const alphabet = createEmptyAlphabet();
    expect(Object.keys(alphabet)).toHaveLength(26);
    expect(alphabet.A).toBe("unknown");
    expect(alphabet.Z).toBe("unknown");
  });

  it("cycles alphabet states in the expected order", () => {
    expect(getNextAlphabetState("unknown")).toBe("present");
    expect(getNextAlphabetState("present")).toBe("absent");
    expect(getNextAlphabetState("absent")).toBe("unknown");
  });

  it("counts overlapping letters correctly", () => {
    expect(calculateMatchCount("CARD", "CRANE")).toBe(3);
    expect(calculateMatchCount("QUIZ", "BLEND")).toBe(0);
  });

  it("counts only correctly identified letters from the opponent alphabet", () => {
    const opponentAlphabet = createEmptyAlphabet();
    opponentAlphabet.C = "present";
    opponentAlphabet.R = "present";
    opponentAlphabet.Z = "present";
    opponentAlphabet.A = "absent";

    expect(countDiscoveredSecretLetters("CRANE", opponentAlphabet)).toBe(2);
  });

  it("computes green letter insight with 4 present marks", () => {
    const alpha = createEmptyAlphabet();
    alpha.C = "present";
    alpha.R = "present";
    alpha.A = "present";
    alpha.Z = "present";

    const result = computeOpponentGreenLetterInsight("CRANE", alpha);
    expect(result?.correctGreenCount).toBe(3);
    expect(result?.revealedGreenLetters).toEqual([
      { letter: "A", isCorrect: true },
      { letter: "C", isCorrect: true },
      { letter: "R", isCorrect: true },
      { letter: "Z", isCorrect: false },
    ]);
  });

  it("computes green letter insight with 5 present marks", () => {
    const alpha = createEmptyAlphabet();
    alpha.C = "present";
    alpha.R = "present";
    alpha.A = "present";
    alpha.Z = "present";
    alpha.X = "present";

    const result = computeOpponentGreenLetterInsight("CRANE", alpha);
    expect(result?.correctGreenCount).toBe(3);
    expect(result?.revealedGreenLetters).toEqual([
      { letter: "A", isCorrect: true },
      { letter: "C", isCorrect: true },
      { letter: "R", isCorrect: true },
      { letter: "X", isCorrect: false },
      { letter: "Z", isCorrect: false },
    ]);
  });

  it("redacts secret words until the game is complete", () => {
    const opponentAlphabet = createEmptyAlphabet();
    opponentAlphabet.C = "present";
    opponentAlphabet.R = "present";
    opponentAlphabet.A = "absent";

    const baseGame = {
      _id: "game_1" as const,
      code: "ABC123",
      status: "active" as const,
      public: false,
      createdAt: 1,
      lastActivityAt: 2,
      winnerId: undefined,
    };
    const players = [
      {
        _id: "player_me" as const,
        userId: "user_me" as const,
        username: "Me",
        secretWord: "CRANE",
        alphabet: createEmptyAlphabet(),
        totalGuesses: 1,
      },
      {
        _id: "player_you" as const,
        userId: "user_you" as const,
        username: "You",
        secretWord: "LIGHT",
        alphabet: opponentAlphabet,
        totalGuesses: 2,
      },
    ];
    const guesses = [
      {
        _id: "guess_1" as const,
        playerId: "player_me" as const,
        type: "fourLetter" as const,
        text: "CARD",
        matchCount: 3,
        isCorrect: false,
        guessNumber: 1,
      },
    ];

    const activeView = buildGameStateView({
      game: baseGame,
      players,
      guesses,
      viewerUserId: "user_me",
    });
    expect(activeView?.me.secretWord).toBeUndefined();
    expect(activeView?.opponent?.secretWord).toBeUndefined();
    expect(activeView?.opponentFoundLetterCount).toBe(2);
    expect(activeView?.myGuesses).toHaveLength(1);
    expect(activeView?.opponentGuesses).toHaveLength(0);
    expect(activeView?.opponentGreenLetterInsight).toEqual({
      correctGreenCount: 2,
      revealedGreenLetters: [
        { letter: "C", isCorrect: true },
        { letter: "R", isCorrect: true },
      ],
    });

    const completeView = buildGameStateView({
      game: { ...baseGame, status: "completed", winnerId: "player_me" },
      players,
      guesses,
      viewerUserId: "user_me",
    });
    expect(completeView?.me.secretWord).toBe("CRANE");
    expect(completeView?.opponent?.secretWord).toBe("LIGHT");
    expect(completeView?.opponentFoundLetterCount).toBe(2);
  });

  it("sanitizes and moderates chat", () => {
    expect(sanitizeChatText(" hello   there \n\n\nfriend ")).toBe("hello there\n\nfriend");
    expect(getChatModerationError("visit https://example.com")).toContain("blocked");
    expect(getChatModerationError("aaaaaaaaaa")).toContain("spam");
  });

  it("enforces chat cooldown and burst limits", () => {
    expect(getChatRateLimitError([1000], 1500)).toContain("quickly");
    expect(getChatRateLimitError([0, 1000, 2000, 3000, 4000], 4500)).toContain("rate limit");
    expect(getChatRateLimitError([0], 5000)).toBeNull();
  });

  it("tracks recent results and waiting expiry", () => {
    expect(pushRecentResult(["W", "L", "W", "W", "L"], "W")).toEqual(["L", "W", "W", "L", "W"]);
    expect(
      isWaitingGameExpired(
        { status: "waiting", createdAt: 0 },
        12 * 60 * 60 * 1000 + 1
      )
    ).toBe(true);
  });
});

// The disappearing-guess bug was a disagreement between the pace the client
// permits and the pace the server allows. It has recurred once already: the
// first fix relaxed the cooldown and rederived the client lock from it, but
// left the burst bound at a stricter sustained rate, so steady fast play was
// still rejected after ~16 guesses. These pin both bounds against the client
// lock so relaxing one without the other fails here rather than in play.
describe("guess pacing bounds agree with the client submit lock", () => {
  it("holds the client lock looser than the server's gap bound", () => {
    expect(GUESS_SUBMIT_LOCK_MS).toBeGreaterThan(GUESS_COOLDOWN_MS);
  });

  it("holds the client lock looser than the server's sustained rate bound", () => {
    const sustainedGapMs = GUESS_BURST_WINDOW_MS / GUESS_BURST_LIMIT;
    expect(GUESS_SUBMIT_LOCK_MS).toBeGreaterThan(sustainedGapMs);
  });

  it("accepts a full burst window of guesses at exactly the client's pace", () => {
    // Replay what a player typing at the client's own lock produces: one guess
    // every GUESS_SUBMIT_LOCK_MS, for longer than the burst window. Every one
    // must be legal, including the guesses past GUESS_BURST_LIMIT.
    const now = 1_000_000;
    const guessCount = Math.ceil((GUESS_BURST_WINDOW_MS * 2) / GUESS_SUBMIT_LOCK_MS);
    const times: number[] = [];

    for (let i = 0; i < guessCount; i += 1) {
      const at = now + i * GUESS_SUBMIT_LOCK_MS;
      expect(getGuessRateLimitError(times, at)).toBeNull();
      times.push(at);
    }

    expect(times.length).toBeGreaterThan(GUESS_BURST_LIMIT);
  });

  it("still rejects a pace faster than the client would ever send", () => {
    const now = 1_000_000;
    expect(getGuessRateLimitError([now - 10], now)).not.toBeNull();

    const machineGunned = Array.from({ length: GUESS_BURST_LIMIT }, (_, i) => now - i * 100);
    expect(getGuessRateLimitError(machineGunned, now)).not.toBeNull();
  });
});
