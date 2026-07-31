// Bot opponent reasoning. Pure, isomorphic, and deliberately blind.
//
// FAIRNESS INVARIANT: nothing in this module ever receives the opponent's
// secret word. `chooseMove` takes only the bot's own guess history — the same
// information a human player has. That is enforced by the type signature and
// asserted in botBrain.test.ts. Do not add a secret parameter here; if the bot
// ever needs to look stronger, turn the difficulty knobs instead.
//
// The solver is a Mastermind-style constraint filter. Because both word lists
// are free of repeated letters, a word is fully described by the set of letters
// it contains, so each word encodes losslessly as a 26-bit mask and a match
// count is a single popcount:
//
//     matchCount(guess, secret) === popcount(mask(guess) & mask(secret))
//
// Filtering the 8,079 candidates against a constraint is therefore 8,079
// popcounts — microseconds. Scoring every probe against every candidate would
// be 4,269 x 8,079 = 34.5M popcounts, which is too slow to sit inside a request,
// so probe selection samples (see DifficultyConfig).

import type { AlphabetState } from "./types.js";
import { BOT_SECRET_WORDS, FIVE_LETTER_WORDS, FOUR_LETTER_WORDS } from "./wordLists.js";

export type BotDifficulty = "easy" | "medium" | "hard";

export const BOT_DIFFICULTIES: readonly BotDifficulty[] = ["easy", "medium", "hard"];

export function isBotDifficulty(value: unknown): value is BotDifficulty {
  return typeof value === "string" && (BOT_DIFFICULTIES as readonly string[]).includes(value);
}

/** One of the bot's own past guesses, with the result the server returned. */
export type BotFeedback = {
  type: "fourLetter" | "fullWord";
  text: string;
  matchCount: number;
  isCorrect: boolean;
};

export type BotMove = {
  type: "fourLetter" | "fullWord";
  /** Uppercase, matching the normalized form the game service expects. */
  text: string;
};

type DifficultyConfig = {
  /** Probes scored per move. 0 means "pick at random" — no lookahead at all. */
  probeSampleSize: number;
  /** Candidates scored against each probe. Caps the worst-case cost per move. */
  candidateSampleSize: number;
  /**
   * Score every probe (not just a sample) once the field is this small. Cost is
   * probes x candidates, so this is only affordable in the endgame.
   */
  fullScanCandidateLimit: number;
  /**
   * Attempt a solve once the candidate set is this small or smaller.
   *
   * Counter-intuitively, higher is stronger. With k candidates left, guessing
   * costs (k+1)/2 attempts on average, while probing costs a guaranteed turn
   * and only then a solve. Gambling at two or three candidates beats probing
   * for certainty, so the sharpest bot is the one most willing to commit.
   */
  solveThreshold: number;
  /** Probability of forfeiting a turn entirely. */
  skipChance: number;
  minDelayMs: number;
  maxDelayMs: number;
};

// Measured over 60 random secrets: easy solves in ~14.7 guesses, medium ~9.0,
// hard ~8.7. Medium and hard are close on purpose — a 4-letter probe yields
// about 2.2 bits and identifying one of 8,079 words needs ~13, so roughly seven
// guesses is the floor and no amount of cleverness beats it by much.
//
// The difficulty gradient is therefore PACE, not accuracy. Expected time to
// solve is what the human actually races: ~7 minutes on easy (slower moves plus
// skipped turns), ~2 minutes on medium, ~80 seconds on hard. Tune the delays
// here to rebalance; tuning solveThreshold barely moves the needle.
//
// Delays also stay clear of the guess rate limits in gameLogic.ts (1.2s
// cooldown, 5 per 15s) — even the fastest bot lands at most 3 in a window.
export const BOT_DIFFICULTY_CONFIG: Record<BotDifficulty, DifficultyConfig> = {
  easy: {
    probeSampleSize: 0,
    candidateSampleSize: 600,
    fullScanCandidateLimit: 0,
    solveThreshold: 1,
    skipChance: 0.3,
    minDelayMs: 14_000,
    maxDelayMs: 26_000,
  },
  medium: {
    probeSampleSize: 300,
    candidateSampleSize: 1_200,
    fullScanCandidateLimit: 0,
    solveThreshold: 2,
    skipChance: 0,
    minDelayMs: 9_000,
    maxDelayMs: 18_000,
  },
  hard: {
    probeSampleSize: 800,
    candidateSampleSize: 1_500,
    fullScanCandidateLimit: 400,
    solveThreshold: 3,
    skipChance: 0,
    minDelayMs: 6_000,
    maxDelayMs: 12_000,
  },
};

export const BOT_DISPLAY_NAMES: Record<BotDifficulty, string> = {
  easy: "Rookie Bot",
  medium: "Sharp Bot",
  hard: "Ruthless Bot",
};

function wordToMask(word: string): number {
  let mask = 0;
  const normalized = word.toLowerCase();
  for (let index = 0; index < normalized.length; index += 1) {
    const bit = normalized.charCodeAt(index) - 97;
    if (bit >= 0 && bit < 26) {
      mask |= 1 << bit;
    }
  }
  return mask;
}

function popcount(value: number): number {
  let x = value - ((value >> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  x = (x + (x >> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >> 24;
}

// Built once, lazily, so importing this module stays free for callers that
// never run the bot (the frontend imports the difficulty labels).
let probeMaskCache: Int32Array | null = null;
let candidateMaskCache: Int32Array | null = null;

function getProbeMasks(): Int32Array {
  if (!probeMaskCache) {
    probeMaskCache = Int32Array.from(FOUR_LETTER_WORDS, wordToMask);
  }
  return probeMaskCache;
}

function getCandidateMasks(): Int32Array {
  if (!candidateMaskCache) {
    candidateMaskCache = Int32Array.from(FIVE_LETTER_WORDS, wordToMask);
  }
  return candidateMaskCache;
}

/**
 * Every dictionary word still consistent with the feedback so far, as indices
 * into FIVE_LETTER_WORDS.
 */
export function filterCandidateIndices(feedback: BotFeedback[]): number[] {
  const masks = getCandidateMasks();
  const constraints: Array<{ mask: number; count: number }> = [];
  const ruledOut = new Set<string>();

  for (const entry of feedback) {
    if (entry.type === "fourLetter") {
      constraints.push({ mask: wordToMask(entry.text), count: entry.matchCount });
      continue;
    }

    // A missed full-word guess carries NO overlap information: the game service
    // records match_count 0 for every wrong solve regardless of how many
    // letters actually matched. Treating that 0 as a real constraint would
    // wrongly eliminate most of the dictionary. All a miss rules out is the
    // exact word that was tried.
    if (!entry.isCorrect) {
      ruledOut.add(entry.text.toLowerCase());
    }
  }

  const result: number[] = [];

  outer: for (let index = 0; index < masks.length; index += 1) {
    if (ruledOut.size > 0 && ruledOut.has(FIVE_LETTER_WORDS[index])) {
      continue;
    }

    const candidateMask = masks[index];
    for (const constraint of constraints) {
      if (popcount(candidateMask & constraint.mask) !== constraint.count) {
        continue outer;
      }
    }

    result.push(index);
  }

  return result;
}

/**
 * Whether any probe could still separate the remaining candidates.
 *
 * A match count only ever reveals a letter *set*, so two candidates built from
 * the same letters are permanently indistinguishable — "SNAKE" and "SNEAK"
 * return identical counts for every possible probe, forever. A bot that waits
 * for the field to reach exactly one candidate would probe until it ran out of
 * dictionary. Once the field collapses to a single letter set, guessing is the
 * only move left.
 */
function hasDistinguishableCandidates(candidates: number[]): boolean {
  if (candidates.length <= 1) {
    return false;
  }

  const masks = getCandidateMasks();
  const first = masks[candidates[0]];
  for (let index = 1; index < candidates.length; index += 1) {
    if (masks[candidates[index]] !== first) {
      return true;
    }
  }
  return false;
}

function sampleIndices(source: number[], size: number, random: () => number): number[] {
  if (source.length <= size) {
    return source;
  }

  // Partial Fisher-Yates: shuffle only the prefix we intend to keep.
  const pool = source.slice();
  for (let index = 0; index < size; index += 1) {
    const swapWith = index + Math.floor(random() * (pool.length - index));
    const held = pool[index];
    pool[index] = pool[swapWith];
    pool[swapWith] = held;
  }
  return pool.slice(0, size);
}

function entropy(buckets: number[], total: number): number {
  if (total === 0) {
    return 0;
  }

  let score = 0;
  for (const count of buckets) {
    if (count === 0) {
      continue;
    }
    const probability = count / total;
    score -= probability * Math.log2(probability);
  }
  return score;
}

function pickRandom<T>(items: T[], random: () => number): T {
  return items[Math.floor(random() * items.length)] ?? items[0];
}

/**
 * The probe that splits the candidate set most evenly, i.e. the one whose
 * answer we can predict least well and therefore learn the most from.
 */
function pickProbeIndex(params: {
  candidates: number[];
  config: DifficultyConfig;
  alreadyProbed: Set<string>;
  random: () => number;
}): number | null {
  const { candidates, config, alreadyProbed, random } = params;

  const available: number[] = [];
  for (let index = 0; index < FOUR_LETTER_WORDS.length; index += 1) {
    if (!alreadyProbed.has(FOUR_LETTER_WORDS[index])) {
      available.push(index);
    }
  }

  if (available.length === 0) {
    return null;
  }

  // No lookahead configured, or nothing left to discriminate between.
  if (config.probeSampleSize === 0 || candidates.length <= 1) {
    return pickRandom(available, random);
  }

  const probeMasks = getProbeMasks();
  const candidateMasks = getCandidateMasks();

  // In the endgame the field is small enough to score exhaustively, which picks
  // a genuinely optimal splitter instead of the best of a sample.
  const fullScan = candidates.length <= config.fullScanCandidateLimit;
  const scoringCandidates = fullScan ? candidates : sampleIndices(candidates, config.candidateSampleSize, random);
  const scoringProbes = fullScan ? available : sampleIndices(available, config.probeSampleSize, random);

  // A 4-letter probe against a 5-letter secret can overlap in 0..4 letters.
  const buckets = new Array<number>(5).fill(0);
  let bestIndex = scoringProbes[0];
  let bestScore = -1;

  for (const probeIndex of scoringProbes) {
    const probeMask = probeMasks[probeIndex];
    buckets.fill(0);

    for (const candidateIndex of scoringCandidates) {
      buckets[popcount(probeMask & candidateMasks[candidateIndex])] += 1;
    }

    const score = entropy(buckets, scoringCandidates.length);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = probeIndex;
    }
  }

  // Nothing in the sample splits the field. The candidates are distinguishable
  // in principle (hasDistinguishableCandidates was checked first), so widen to
  // every remaining probe before giving up — by this point the candidate set is
  // small, so a full scan is cheap.
  if (bestScore <= 0 && !fullScan) {
    for (const probeIndex of available) {
      const probeMask = probeMasks[probeIndex];
      buckets.fill(0);

      for (const candidateIndex of candidates) {
        buckets[popcount(probeMask & candidateMasks[candidateIndex])] += 1;
      }

      const score = entropy(buckets, candidates.length);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = probeIndex;
      }
    }
  }

  // No dictionary probe separates the survivors. Probing further burns turns
  // for nothing — tell the caller to solve instead.
  if (bestScore <= 0) {
    return null;
  }

  return bestIndex;
}

/**
 * The bot's next move, or null when it decides to sit this turn out.
 *
 * Takes the bot's own guess history and nothing else. See the fairness
 * invariant at the top of this file.
 */
export function chooseMove(params: {
  difficulty: BotDifficulty;
  feedback: BotFeedback[];
  random?: () => number;
}): BotMove | null {
  const { difficulty, feedback, random = Math.random } = params;
  const config = BOT_DIFFICULTY_CONFIG[difficulty];

  if (config.skipChance > 0 && random() < config.skipChance) {
    return null;
  }

  const candidates = filterCandidateIndices(feedback);

  // Solve when the field is small enough for this difficulty, or when probing
  // can no longer tell the survivors apart and guessing is all that is left.
  if (candidates.length > 0 && (candidates.length <= config.solveThreshold || !hasDistinguishableCandidates(candidates))) {
    return { type: "fullWord", text: FIVE_LETTER_WORDS[pickRandom(candidates, random)].toUpperCase() };
  }

  const alreadyProbed = new Set(
    feedback.filter((entry) => entry.type === "fourLetter").map((entry) => entry.text.toLowerCase())
  );

  const probeIndex = pickProbeIndex({ candidates, config, alreadyProbed, random });
  if (probeIndex !== null) {
    return { type: "fourLetter", text: FOUR_LETTER_WORDS[probeIndex].toUpperCase() };
  }

  // Every probe in the dictionary has been tried. Unreachable in a real game
  // (that is 4,269 guesses), but solve with whatever is left rather than stall.
  const fallback = candidates.length > 0 ? pickRandom(candidates, random) : 0;
  return { type: "fullWord", text: FIVE_LETTER_WORDS[fallback].toUpperCase() };
}

/**
 * The bot's alphabet marks, derived honestly from what it has actually deduced.
 *
 * This is not cosmetic: the opponent-insight readout in gameLogic.ts reports how
 * many letters the opponent has marked correctly, so a bot that never marks
 * leaves that whole pressure mechanic dead in bot games.
 *
 * A letter shared by every remaining candidate is known-present; one that
 * appears in none is known-absent. Both fall out of an AND and an OR over the
 * candidate masks.
 */
export function deriveAlphabetFromCandidates(candidateIndices: number[]): Record<string, AlphabetState> {
  const alphabet: Record<string, AlphabetState> = {};
  for (let code = 65; code <= 90; code += 1) {
    alphabet[String.fromCharCode(code)] = "unknown";
  }

  if (candidateIndices.length === 0) {
    return alphabet;
  }

  const masks = getCandidateMasks();
  let sharedByAll = ~0;
  let presentInAny = 0;

  for (const index of candidateIndices) {
    sharedByAll &= masks[index];
    presentInAny |= masks[index];
  }

  for (let bit = 0; bit < 26; bit += 1) {
    const letter = String.fromCharCode(65 + bit);
    if (sharedByAll & (1 << bit)) {
      alphabet[letter] = "present";
    } else if (!(presentInAny & (1 << bit))) {
      alphabet[letter] = "absent";
    }
  }

  return alphabet;
}

export function nextMoveDelayMs(difficulty: BotDifficulty, random: () => number = Math.random): number {
  const { minDelayMs, maxDelayMs } = BOT_DIFFICULTY_CONFIG[difficulty];
  return Math.round(minDelayMs + random() * (maxDelayMs - minDelayMs));
}

/**
 * A secret word for the bot to defend.
 *
 * Drawn from BOT_SECRET_WORDS (the most common ~1,500 legal words), not the
 * full 8,079-word dictionary. Solving is only satisfying if the answer is a
 * word you know: the bot searches the whole dictionary, so it cracks an
 * ordinary player word fine, but a player who narrows the field to GLISK or
 * NUGAE has done everything right and still can't finish. See
 * scripts/generate-wordbank.mjs for how the pool is built.
 */
export function pickBotSecretWord(random: () => number = Math.random): string {
  return BOT_SECRET_WORDS[Math.floor(random() * BOT_SECRET_WORDS.length)].toUpperCase();
}
