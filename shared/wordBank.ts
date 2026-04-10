import type { WordValidationResult } from "./types";
import { FIVE_LETTER_WORDS, FOUR_LETTER_WORDS } from "./wordLists";

const FOUR_LETTER_SET = new Set<string>(FOUR_LETTER_WORDS);
const FIVE_LETTER_SET = new Set<string>(FIVE_LETTER_WORDS);
const ALL_GAME_WORDS = new Set<string>([...FOUR_LETTER_WORDS, ...FIVE_LETTER_WORDS]);

function normalizeDictionaryWord(word: string) {
  return word.trim().toLowerCase();
}

export function isAllowedGameWord(word: string, expectedLength?: 4 | 5): boolean {
  const normalized = normalizeDictionaryWord(word);

  if (expectedLength === 4) {
    return FOUR_LETTER_SET.has(normalized);
  }

  if (expectedLength === 5) {
    return FIVE_LETTER_SET.has(normalized);
  }

  return ALL_GAME_WORDS.has(normalized);
}

export function getWordValidationReason(word: string, expectedLength?: 4 | 5): string {
  const normalized = normalizeDictionaryWord(word);

  if (expectedLength && normalized.length !== expectedLength) {
    return `Word must be exactly ${expectedLength} letters long.`;
  }

  if (!expectedLength && normalized.length !== 4 && normalized.length !== 5) {
    return "Word must be exactly 4 or 5 letters long.";
  }

  if (!/^[a-z]+$/.test(normalized)) {
    return "Word must only contain letters A-Z.";
  }

  if (new Set(normalized).size !== normalized.length) {
    return "Duplicate letters are not allowed.";
  }

  if (!isAllowedGameWord(normalized, expectedLength)) {
    return "Word is not in the local game dictionary.";
  }

  return "";
}

export function validateGameWord(word: string, expectedLength?: 4 | 5): WordValidationResult {
  const normalizedWord = normalizeDictionaryWord(word).toUpperCase();
  const reason = getWordValidationReason(word, expectedLength);

  return {
    valid: reason.length === 0,
    normalizedWord,
    reason,
    expectedLength,
  };
}

export function getWordBankStats() {
  return {
    fourLetterCount: FOUR_LETTER_WORDS.length,
    fiveLetterCount: FIVE_LETTER_WORDS.length,
  };
}
