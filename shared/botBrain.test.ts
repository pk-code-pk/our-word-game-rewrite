import { describe, expect, it } from "vitest";
import {
  BOT_DIFFICULTY_CONFIG,
  chooseMove,
  deriveAlphabetFromCandidates,
  filterCandidateIndices,
  isBotDifficulty,
  nextMoveDelayMs,
  pickBotSecretWord,
  type BotDifficulty,
  type BotFeedback,
} from "./botBrain.js";
import { calculateMatchCount, GUESS_BURST_LIMIT, GUESS_BURST_WINDOW_MS } from "./gameLogic.js";
import { BOT_SECRET_WORDS, FIVE_LETTER_WORDS } from "./wordLists.js";

// Deterministic RNG so every assertion below is reproducible.
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Plays a bot against a fixed secret, scoring exactly the way gameService does.
 * Returns the guesses it took to solve, or null if it never got there.
 */
function playToSolve(secret: string, difficulty: BotDifficulty, random: () => number, maxGuesses = 40) {
  const feedback: BotFeedback[] = [];

  for (let attempt = 0; attempt < maxGuesses; attempt += 1) {
    const move = chooseMove({ difficulty, feedback, random });
    if (!move) {
      continue;
    }

    if (move.type === "fullWord") {
      const isCorrect = move.text === secret;
      if (isCorrect) {
        return { guesses: feedback.length + 1, feedback };
      }
      // Mirrors the server: a wrong solve is recorded with match_count 0.
      feedback.push({ type: "fullWord", text: move.text, matchCount: 0, isCorrect: false });
      continue;
    }

    feedback.push({
      type: "fourLetter",
      text: move.text,
      matchCount: calculateMatchCount(move.text, secret),
      isCorrect: false,
    });
  }

  return null;
}

const SAMPLE_SECRETS = ["CHAIR", "MOUNT", "BLAZE", "QUIRK", "SWORD", "PLANT"];

describe("filterCandidateIndices", () => {
  it("always retains the true secret when feedback is honest", () => {
    const secret = "CHAIR";
    const feedback: BotFeedback[] = ["MOTE", "SLID", "PACK"].map((probe) => ({
      type: "fourLetter" as const,
      text: probe,
      matchCount: calculateMatchCount(probe, secret),
      isCorrect: false,
    }));

    const candidates = filterCandidateIndices(feedback);
    const words = candidates.map((index) => FIVE_LETTER_WORDS[index].toUpperCase());

    expect(words).toContain(secret);
  });

  it("narrows the candidate set with every probe", () => {
    const secret = "MOUNT";
    const feedback: BotFeedback[] = [];
    let previous = filterCandidateIndices(feedback).length;

    expect(previous).toBe(FIVE_LETTER_WORDS.length);

    for (const probe of ["SALE", "TRIP", "MOAN"]) {
      feedback.push({
        type: "fourLetter",
        text: probe,
        matchCount: calculateMatchCount(probe, secret),
        isCorrect: false,
      });
      const next = filterCandidateIndices(feedback).length;
      expect(next).toBeLessThan(previous);
      previous = next;
    }
  });

  it("treats a missed solve as ruling out only that exact word", () => {
    // Regression guard. The server records match_count 0 for every wrong
    // full-word guess, so reading that 0 as "shares no letters" would wrongly
    // eliminate nearly the whole dictionary.
    const baseline = filterCandidateIndices([]);
    const afterMiss = filterCandidateIndices([
      { type: "fullWord", text: "CHAIR", matchCount: 0, isCorrect: false },
    ]);

    expect(afterMiss.length).toBe(baseline.length - 1);
    expect(afterMiss.map((index) => FIVE_LETTER_WORDS[index].toUpperCase())).not.toContain("CHAIR");
  });
});

describe("chooseMove", () => {
  it("is a pure function of its own feedback", () => {
    // The fairness guarantee is structural — chooseMove has no parameter for
    // the opponent's secret, so it cannot consult one. This pins the observable
    // consequence: the move depends on nothing but the feedback and the RNG, so
    // two games whose probes happened to return the same counts play the same.
    const feedback: BotFeedback[] = [
      { type: "fourLetter", text: "MOTE", matchCount: 1, isCorrect: false },
      { type: "fourLetter", text: "SLID", matchCount: 1, isCorrect: false },
    ];

    const first = chooseMove({ difficulty: "hard", feedback, random: seededRandom(99) });
    const second = chooseMove({
      difficulty: "hard",
      feedback: feedback.map((entry) => ({ ...entry })),
      random: seededRandom(99),
    });

    expect(first).toEqual(second);
  });

  it("only ever proposes legal dictionary words", () => {
    const random = seededRandom(7);
    for (const secret of SAMPLE_SECRETS) {
      const result = playToSolve(secret, "medium", random);
      expect(result).not.toBeNull();
      for (const entry of result!.feedback) {
        expect(entry.text).toMatch(/^[A-Z]+$/);
        expect(entry.text.length).toBe(entry.type === "fourLetter" ? 4 : 5);
        expect(new Set(entry.text).size).toBe(entry.text.length);
      }
    }
  });

  it("never repeats a probe it has already tried", () => {
    const random = seededRandom(1234);
    const result = playToSolve("BLAZE", "hard", random);

    expect(result).not.toBeNull();
    const probes = result!.feedback.filter((entry) => entry.type === "fourLetter").map((entry) => entry.text);
    expect(new Set(probes).size).toBe(probes.length);
  });

  it("solves reliably on hard", () => {
    const random = seededRandom(2026);

    for (const secret of SAMPLE_SECRETS) {
      const result = playToSolve(secret, "hard", random);
      expect(result, `hard bot failed to solve ${secret}`).not.toBeNull();
      // Each probe splits the field roughly five ways, so a handful of probes
      // plus the solve is the expected shape. Generous ceiling to keep this
      // from being a flaky benchmark.
      expect(result!.guesses).toBeLessThanOrEqual(15);
    }
  });

  it("is meaningfully weaker on easy than on hard", () => {
    const hardTotal = SAMPLE_SECRETS.reduce((total, secret) => {
      const result = playToSolve(secret, "hard", seededRandom(11));
      return total + (result?.guesses ?? 40);
    }, 0);

    const easyTotal = SAMPLE_SECRETS.reduce((total, secret) => {
      const result = playToSolve(secret, "easy", seededRandom(11), 120);
      return total + (result?.guesses ?? 120);
    }, 0);

    expect(easyTotal).toBeGreaterThan(hardTotal);
  });

  it("skips turns on easy but never on hard", () => {
    const easySkips = Array.from({ length: 200 }, (_, index) =>
      chooseMove({ difficulty: "easy", feedback: [], random: seededRandom(index) })
    ).filter((move) => move === null).length;

    const hardSkips = Array.from({ length: 200 }, (_, index) =>
      chooseMove({ difficulty: "hard", feedback: [], random: seededRandom(index) })
    ).filter((move) => move === null).length;

    expect(easySkips).toBeGreaterThan(0);
    expect(hardSkips).toBe(0);
  });

  it("attempts a solve once the field is narrow enough", () => {
    const secret = "QUIRK";
    const feedback: BotFeedback[] = [];
    const random = seededRandom(5);

    for (let round = 0; round < 30; round += 1) {
      const move = chooseMove({ difficulty: "hard", feedback, random });
      if (!move) continue;
      if (move.type === "fullWord") {
        const remaining = filterCandidateIndices(feedback);
        const letterSets = new Set(remaining.map((index) => [...new Set(FIVE_LETTER_WORDS[index])].sort().join("")));
        // Either the field is small enough to gamble on, or every survivor is
        // built from the same letters and no probe could separate them.
        expect(remaining.length <= BOT_DIFFICULTY_CONFIG.hard.solveThreshold || letterSets.size === 1).toBe(true);
        return;
      }
      feedback.push({
        type: "fourLetter",
        text: move.text,
        matchCount: calculateMatchCount(move.text, secret),
        isCorrect: false,
      });
    }

    throw new Error("hard bot never attempted a solve");
  });
});

describe("deriveAlphabetFromCandidates", () => {
  it("marks a fully determined word letter by letter", () => {
    const index = FIVE_LETTER_WORDS.indexOf("chair");
    expect(index).toBeGreaterThanOrEqual(0);

    const alphabet = deriveAlphabetFromCandidates([index]);

    for (const letter of "CHAIR") {
      expect(alphabet[letter]).toBe("present");
    }
    expect(alphabet.Z).toBe("absent");
    expect(Object.values(alphabet).filter((state) => state === "present")).toHaveLength(5);
  });

  it("leaves everything unknown before any deduction", () => {
    const alphabet = deriveAlphabetFromCandidates(filterCandidateIndices([]));
    expect(Object.values(alphabet).every((state) => state === "unknown")).toBe(true);
  });

  it("returns a full 26-letter map for an empty candidate set", () => {
    const alphabet = deriveAlphabetFromCandidates([]);
    expect(Object.keys(alphabet)).toHaveLength(26);
    expect(Object.values(alphabet).every((state) => state === "unknown")).toBe(true);
  });
});

describe("pacing and configuration", () => {
  it("keeps every difficulty inside the guess rate limit", () => {
    for (const difficulty of ["easy", "medium", "hard"] as const) {
      const { minDelayMs } = BOT_DIFFICULTY_CONFIG[difficulty];
      const guessesPerBurstWindow = GUESS_BURST_WINDOW_MS / minDelayMs;
      expect(guessesPerBurstWindow).toBeLessThan(GUESS_BURST_LIMIT);
    }
  });

  it("produces delays inside the configured band", () => {
    for (const difficulty of ["easy", "medium", "hard"] as const) {
      const config = BOT_DIFFICULTY_CONFIG[difficulty];
      for (let seed = 0; seed < 50; seed += 1) {
        const delay = nextMoveDelayMs(difficulty, seededRandom(seed));
        expect(delay).toBeGreaterThanOrEqual(config.minDelayMs);
        expect(delay).toBeLessThanOrEqual(config.maxDelayMs);
      }
    }
  });

  it("picks a legal secret word for itself", () => {
    for (let seed = 0; seed < 25; seed += 1) {
      const secret = pickBotSecretWord(seededRandom(seed));
      expect(secret).toMatch(/^[A-Z]{5}$/);
      expect(new Set(secret).size).toBe(5);
      expect(FIVE_LETTER_WORDS).toContain(secret.toLowerCase());
    }
  });

  it("draws its secret only from the common-word pool", () => {
    // Guards the fairness property: the bot searches the whole dictionary when
    // solving, so if it could also *defend* an obscure word the matchup would
    // be one-sided in a way no amount of good play could overcome.
    const pool = new Set(BOT_SECRET_WORDS);
    for (let seed = 0; seed < 200; seed += 1) {
      expect(pool.has(pickBotSecretWord(seededRandom(seed)).toLowerCase())).toBe(true);
    }
  });

  it("keeps the secret pool a legal, non-degenerate subset of the dictionary", () => {
    const dictionary = new Set(FIVE_LETTER_WORDS);
    for (const word of BOT_SECRET_WORDS) {
      expect(dictionary.has(word), `${word} is not a legal game word`).toBe(true);
      expect(new Set(word).size, `${word} repeats a letter`).toBe(5);
    }
    // Big enough that repeats are rare, small enough to stay common.
    expect(BOT_SECRET_WORDS.length).toBeGreaterThan(500);
    expect(BOT_SECRET_WORDS.length).toBeLessThan(FIVE_LETTER_WORDS.length / 2);
    expect(new Set(BOT_SECRET_WORDS).size).toBe(BOT_SECRET_WORDS.length); // no dupes
  });

  it("recognizes only the three difficulty levels", () => {
    expect(isBotDifficulty("easy")).toBe(true);
    expect(isBotDifficulty("medium")).toBe(true);
    expect(isBotDifficulty("hard")).toBe(true);
    expect(isBotDifficulty("impossible")).toBe(false);
    expect(isBotDifficulty(null)).toBe(false);
  });
});
