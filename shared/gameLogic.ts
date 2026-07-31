import type { AlphabetState } from "./types.js";

export const GAME_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const USERNAME_MAX_LENGTH = 20;
export const SOCIAL_USERNAME_MAX_LENGTH = 20;
export const CHAT_MAX_LENGTH = 300;
export const WAITING_GAME_TTL_MS = 12 * 60 * 60 * 1000;
export const CHAT_COOLDOWN_MS = 800;
export const CHAT_BURST_WINDOW_MS = 30 * 1000;
export const CHAT_BURST_LIMIT = 5;
// Guess pacing. These are anti-spam bounds, not a gameplay mechanic: FourFive
// is a race, so any pace a person can physically type at has to be legal.
//
// The previous values (1200ms cooldown, 5 per 15s) were tighter than ordinary
// play — a steady guess every two seconds was rejected on the fifth guess, and
// the rejection read as the guess silently vanishing. The sustained ceiling is
// what matters: BURST_LIMIT / BURST_WINDOW is now one guess per second, which
// is faster than anyone types a four-letter word plus Enter.
//
// The client submit lock imports GUESS_COOLDOWN_MS directly rather than
// hardcoding its own value — the two drifted apart before (client 400ms vs
// server 1200ms), which opened an 800ms window where the UI accepted a guess
// the server was always going to reject.
export const GUESS_COOLDOWN_MS = 600;
export const GUESS_BURST_WINDOW_MS = 15 * 1000;
export const GUESS_BURST_LIMIT = 15;

type GameDocLike<TGameId extends string = string, TPlayerId extends string = string> = {
  _id: TGameId;
  code: string;
  status: "waiting" | "active" | "completed";
  public: boolean;
  createdAt: number;
  lastActivityAt?: number;
  completedAt?: number;
  winnerId?: TPlayerId;
};

type PlayerDocLike<TPlayerId extends string = string, TUserId extends string = string> = {
  _id: TPlayerId;
  userId?: TUserId;
  username: string;
  secretWord?: string;
  alphabet: Record<string, AlphabetState>;
  totalGuesses: number;
  isBot?: boolean;
};

type GuessDocLike<TGuessId extends string = string, TPlayerId extends string = string> = {
  _id: TGuessId;
  playerId: TPlayerId;
  type: "fourLetter" | "fullWord";
  text: string;
  matchCount: number;
  isCorrect: boolean;
  guessNumber: number;
  createdAt?: number;
};

const BLOCKED_CHAT_PATTERNS = [
  /https?:\/\//i,
  /www\./i,
  /\bdiscord\.gg\b/i,
  /\bf+u+c*k+\b/i,
  /\bs+h+i+t+\b/i,
  /\bb+i+t+c+h+\b/i,
  /\ba+s+s+h+o+l+e+\b/i,
];

function createRandomValues(length: number) {
  const cryptoLike = (globalThis as { crypto?: { getRandomValues(values: Uint8Array): Uint8Array } }).crypto;
  if (cryptoLike?.getRandomValues) {
    return cryptoLike.getRandomValues(new Uint8Array(length));
  }

  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

export function createEmptyAlphabet(): Record<string, AlphabetState> {
  const alphabet: Record<string, AlphabetState> = {};
  for (let i = 65; i <= 90; i += 1) {
    alphabet[String.fromCharCode(i)] = "unknown";
  }
  return alphabet;
}

export function getNextAlphabetState(state: AlphabetState): AlphabetState {
  if (state === "unknown") {
    return "present";
  }

  if (state === "present") {
    return "absent";
  }

  return "unknown";
}

export function calculateMatchCount(guess: string, secret: string): number {
  const guessLetters = new Set(guess.toLowerCase());
  const secretLetters = new Set(secret.toLowerCase());
  let matches = 0;

  for (const letter of guessLetters) {
    if (secretLetters.has(letter)) {
      matches += 1;
    }
  }

  return matches;
}

export function countDiscoveredSecretLetters(
  secretWord: string | undefined,
  opponentAlphabet: Record<string, AlphabetState> | undefined
) {
  if (!secretWord) {
    return 0;
  }

  const secretLetters = new Set(normalizeWord(secretWord).split(""));
  let foundCount = 0;

  for (const letter of secretLetters) {
    if (opponentAlphabet?.[letter] === "present") {
      foundCount += 1;
    }
  }

  return foundCount;
}

export function computeOpponentGreenLetterInsight(
  secretWord: string | undefined,
  opponentAlphabet: Record<string, AlphabetState> | undefined
): {
  correctGreenCount: number;
  revealedGreenLetters: Array<{ letter: string; isCorrect: boolean }> | null;
} | null {
  if (!secretWord || !opponentAlphabet) {
    return null;
  }

  const secretUpper = normalizeWord(secretWord);
  const secretLetterSet = new Set(secretUpper.split(""));
  const presentLetters: string[] = [];

  for (const [letter, state] of Object.entries(opponentAlphabet)) {
    if (state === "present") {
      presentLetters.push(letter.toUpperCase());
    }
  }

  presentLetters.sort();

  const correctGreenCount = presentLetters.filter((l) => secretLetterSet.has(l)).length;
  const revealedGreenLetters =
    presentLetters.length > 0
      ? presentLetters.map((l) => ({ letter: l, isCorrect: secretLetterSet.has(l) }))
      : null;

  return { correctGreenCount, revealedGreenLetters };
}

export function normalizeWord(value: string): string {
  return value.trim().toUpperCase();
}

export function normalizeGameCode(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

export function sanitizeUsername(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, USERNAME_MAX_LENGTH);
}

export function isValidUsername(value: string): boolean {
  return /^[A-Za-z0-9 _-]{2,20}$/.test(value);
}

export function sanitizeSocialUsername(value: string): string {
  return value
    .normalize("NFKD")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, SOCIAL_USERNAME_MAX_LENGTH);
}

export function isValidSocialUsername(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{1,19}$/.test(value);
}

export function generateGameCode(randomValues?: Uint8Array): string {
  const bytes = randomValues ?? createRandomValues(6);

  let code = "";
  for (const byte of bytes) {
    code += GAME_CODE_ALPHABET[byte % GAME_CODE_ALPHABET.length];
  }
  return code;
}

export function isWaitingGameExpired(game: Pick<GameDocLike, "status" | "createdAt">, now = Date.now()): boolean {
  return game.status === "waiting" && now - game.createdAt > WAITING_GAME_TTL_MS;
}

export function sanitizeChatText(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, CHAT_MAX_LENGTH);
}

export function getChatModerationError(value: string): string | null {
  if (value.length === 0) {
    return "Message cannot be empty.";
  }

  if (value.length > CHAT_MAX_LENGTH) {
    return `Message is too long (max ${CHAT_MAX_LENGTH} characters).`;
  }

  if (/(.)\1{8,}/.test(value)) {
    return "Message looks like spam.";
  }

  if (BLOCKED_CHAT_PATTERNS.some((pattern) => pattern.test(value))) {
    return "That message was blocked by chat moderation.";
  }

  return null;
}

export function getChatRateLimitError(messageTimes: number[], now = Date.now()): string | null {
  const sorted = [...messageTimes].sort((a, b) => b - a);

  const recentCount = sorted.filter((timestamp) => now - timestamp < CHAT_BURST_WINDOW_MS).length;
  if (recentCount >= CHAT_BURST_LIMIT) {
    return "Chat rate limit reached. Please wait a few seconds.";
  }

  if (sorted[0] && now - sorted[0] < CHAT_COOLDOWN_MS) {
    return "You're sending messages too quickly. Please slow down.";
  }

  return null;
}

export function getGuessRateLimitError(guessTimes: number[], now = Date.now()): string | null {
  const sorted = [...guessTimes].sort((a, b) => b - a);

  if (sorted[0] !== undefined && now - sorted[0] < GUESS_COOLDOWN_MS) {
    return "You're guessing too quickly. Please wait a moment before trying again.";
  }

  const recentCount = sorted.filter((timestamp) => now - timestamp < GUESS_BURST_WINDOW_MS).length;
  if (recentCount >= GUESS_BURST_LIMIT) {
    return "Guess rate limit reached. Please slow down and try again in a few seconds.";
  }

  return null;
}

export function buildGameStateView<
  TGameId extends string,
  TPlayerId extends string,
  TGuessId extends string,
  TUserId extends string,
>(params: {
  game: GameDocLike<TGameId, TPlayerId>;
  players: PlayerDocLike<TPlayerId, TUserId>[];
  guesses: GuessDocLike<TGuessId, TPlayerId>[];
  viewerUserId: TUserId;
}) {
  const { game, players, guesses, viewerUserId } = params;
  const me = players.find((player) => player.userId === viewerUserId);
  if (!me) {
    return null;
  }

  const opponent = players.find((player) => player._id !== me._id) ?? null;
  const shouldRevealWords = game.status === "completed";
  const myGuesses = guesses
    .filter((guess) => guess.playerId === me._id)
    .sort((a, b) => a.guessNumber - b.guessNumber);
  const opponentGuesses = opponent
    ? guesses
        .filter((guess) => guess.playerId === opponent._id)
        .sort((a, b) => a.guessNumber - b.guessNumber)
    : [];

  return {
    game: {
      _id: game._id,
      code: game.code,
      status: game.status,
      public: game.public,
      createdAt: game.createdAt,
      lastActivityAt: game.lastActivityAt ?? game.createdAt,
      completedAt: game.completedAt,
      winnerId: game.winnerId,
    },
    me: {
      _id: me._id,
      username: me.username,
      alphabet: me.alphabet,
      totalGuesses: me.totalGuesses,
      secretWord: shouldRevealWords ? me.secretWord : undefined,
    },
    opponent: opponent
      ? {
          _id: opponent._id,
          username: opponent.username,
          totalGuesses: opponent.totalGuesses,
          secretWord: shouldRevealWords ? opponent.secretWord : undefined,
          isBot: opponent.isBot ?? false,
        }
      : null,
    myFoundLetterCount: opponent ? countDiscoveredSecretLetters(opponent.secretWord, me.alphabet) : null,
    opponentFoundLetterCount: opponent ? countDiscoveredSecretLetters(me.secretWord, opponent.alphabet) : null,
    opponentGreenLetterInsight: opponent ? computeOpponentGreenLetterInsight(me.secretWord, opponent.alphabet) : null,
    myGuesses,
    opponentGuesses,
  };
}

export function pushRecentResult(results: Array<"W" | "L"> | undefined, result: "W" | "L") {
  return [...(results ?? []), result].slice(-5);
}
