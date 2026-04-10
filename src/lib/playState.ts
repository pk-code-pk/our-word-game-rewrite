import type { AuthUser } from "../../shared/types";

export type GamePhase = "setup" | "lobby" | "playing";

export interface PlayState {
  username: string;
  secretWord: string;
  gamePhase: GamePhase;
  currentGameId: string;
  lobbyCode: string;
  isPublic: boolean;
}

const MAX_USERNAME_LENGTH = 20;
const MAX_GAME_ID_LENGTH = 120;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sanitizeUsername(value: unknown) {
  return typeof value === "string" ? value.slice(0, MAX_USERNAME_LENGTH) : "";
}

function sanitizeSecretWord(value: unknown) {
  return typeof value === "string" ? value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 5) : "";
}

function sanitizeGameId(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, MAX_GAME_ID_LENGTH) : "";
}

function sanitizeLobbyCode(value: unknown) {
  return typeof value === "string" ? value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6) : "";
}

function normalizePhase(rawPhase: unknown, options: { hasSecretWord: boolean; hasCurrentGame: boolean }): GamePhase {
  if (rawPhase === "setup" || rawPhase === "lobby" || rawPhase === "playing") {
    if (rawPhase === "playing" && !options.hasCurrentGame) {
      return options.hasSecretWord ? "lobby" : "setup";
    }
    if (rawPhase === "lobby" && !options.hasSecretWord) {
      return "setup";
    }
    return rawPhase;
  }

  if (options.hasCurrentGame) {
    return "playing";
  }
  if (options.hasSecretWord) {
    return "lobby";
  }
  return "setup";
}

export function createDefaultPlayState(user?: Pick<AuthUser, "username"> | null): PlayState {
  return {
    username: sanitizeUsername(user?.username ?? ""),
    secretWord: "",
    gamePhase: "setup",
    currentGameId: "",
    lobbyCode: "",
    isPublic: false,
  };
}

export function normalizePlayState(raw: unknown, user?: Pick<AuthUser, "username"> | null): PlayState {
  if (!isRecord(raw)) {
    return createDefaultPlayState(user);
  }

  const username = sanitizeUsername(raw.username) || sanitizeUsername(user?.username ?? "");
  const secretWord = sanitizeSecretWord(raw.secretWord);
  const currentGameId = sanitizeGameId(raw.currentGameId);
  const lobbyCode = sanitizeLobbyCode(raw.lobbyCode);
  const isPublic = Boolean(raw.isPublic);
  const gamePhase = normalizePhase(raw.gamePhase, {
    hasSecretWord: Boolean(secretWord),
    hasCurrentGame: Boolean(currentGameId),
  });

  return {
    username,
    secretWord,
    gamePhase,
    currentGameId,
    lobbyCode,
    isPublic,
  };
}

export function readStoredPlayState(userId: string, user?: Pick<AuthUser, "username"> | null): PlayState {
  if (typeof window === "undefined") {
    return createDefaultPlayState(user);
  }

  const playStateKey = `fourfive.playState.${userId}`;
  const legacyUsernameKey = `fourfive.username.${userId}`;
  const legacySecretWordKey = `fourfive.secretWord.${userId}`;
  const legacyGameIdKey = `fourfive.currentGameId.${userId}`;

  let parsedState: unknown = null;
  const stored = window.localStorage.getItem(playStateKey);
  if (stored) {
    try {
      parsedState = JSON.parse(stored) as unknown;
    } catch {
      parsedState = null;
    }
  }

  const legacyState = {
    ...(isRecord(parsedState) ? parsedState : {}),
    username: window.localStorage.getItem(legacyUsernameKey) ?? (isRecord(parsedState) ? parsedState.username : undefined),
    secretWord:
      window.localStorage.getItem(legacySecretWordKey) ?? (isRecord(parsedState) ? parsedState.secretWord : undefined),
    currentGameId:
      window.localStorage.getItem(legacyGameIdKey) ?? (isRecord(parsedState) ? parsedState.currentGameId : undefined),
  };

  return normalizePlayState(legacyState, user);
}

export function writeStoredPlayState(userId: string, playState: PlayState) {
  if (typeof window === "undefined") {
    return;
  }

  const playStateKey = `fourfive.playState.${userId}`;
  const legacyUsernameKey = `fourfive.username.${userId}`;
  const legacySecretWordKey = `fourfive.secretWord.${userId}`;
  const legacyGameIdKey = `fourfive.currentGameId.${userId}`;

  window.localStorage.setItem(playStateKey, JSON.stringify(playState));

  if (playState.username.trim()) {
    window.localStorage.setItem(legacyUsernameKey, playState.username);
  } else {
    window.localStorage.removeItem(legacyUsernameKey);
  }

  if (playState.secretWord.trim()) {
    window.localStorage.setItem(legacySecretWordKey, playState.secretWord);
  } else {
    window.localStorage.removeItem(legacySecretWordKey);
  }

  if (playState.currentGameId.trim()) {
    window.localStorage.setItem(legacyGameIdKey, playState.currentGameId);
  } else {
    window.localStorage.removeItem(legacyGameIdKey);
  }

  // Clean up an old cross-account key from early builds.
  if (window.localStorage.getItem("fourfive.username") !== null) {
    window.localStorage.removeItem("fourfive.username");
  }
}

export function clearActiveGame(playState: PlayState): PlayState {
  return {
    ...playState,
    currentGameId: "",
    gamePhase: playState.secretWord ? "lobby" : "setup",
  };
}

export function resetPlayState(playState: PlayState): PlayState {
  return {
    ...playState,
    secretWord: "",
    gamePhase: "setup",
    currentGameId: "",
    lobbyCode: "",
    isPublic: false,
  };
}
