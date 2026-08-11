import crypto from "node:crypto";
import { v4 as uuid } from "uuid";
import { databaseProvider, db } from "./db.js";
import {
  buildGameStateView,
  calculateMatchCount,
  createEmptyAlphabet,
  generateGameCode,
  getChatModerationError,
  getChatRateLimitError,
  getGuessRateLimitError,
  isValidUsername,
  isWaitingGameExpired,
  normalizeGameCode,
  normalizeWord,
  pushRecentResult,
  sanitizeChatText,
  sanitizeUsername,
} from "../shared/gameLogic.js";
import {
  BOT_DISPLAY_NAMES,
  isBotDifficulty,
  nextMoveDelayMs,
  pickBotSecretWord,
  type BotDifficulty,
} from "../shared/botBrain.js";
import { getWordValidationReason } from "../shared/wordBank.js";
import type {
  AlphabetState,
  AuthUser,
  ChatMessageView,
  GameStateView,
  GuessType,
  PublicLobby,
  RecentGameSummary,
} from "./types.js";
import { getGamePresence, markPlayerOffline, touchPlayerPresence, upsertPlayerPresence } from "./presence.js";
import { broadcastGameSignal } from "./realtime.js";

const WAITING_GAME_LIMIT = 100;

type MaybePromise<T> = T | Promise<T>;
type DbRunner = Pick<typeof db, "prepare" | "exec">;

type GameStatePlayerRow = {
  id: string;
  user_id: string;
  username: string;
  secret_word: string;
  alphabet_json: string;
  total_guesses: number;
  is_bot: number;
};

type GameStateGuessRow = {
  id: string;
  player_id: string;
  type: GuessType;
  text: string;
  match_count: number;
  is_correct: number;
  guess_number: number;
  created_at: number;
};

type ChatMessageRow = {
  id: string;
  game_id: string;
  player_id: string;
  username: string;
  text: string;
  created_at: number;
};

type UserStatsRow = {
  wins: number;
  losses: number;
  total_guesses: number;
  total_win_guesses: number;
  games_played: number;
  current_win_streak: number;
  recent_results_json: string;
  best_win_guesses: number | null;
};

export type WaitingGameRow = {
  id: string;
  status: "waiting" | "active" | "completed";
  created_at: number;
};

function now() {
  return Date.now();
}

function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
  return typeof value === "object" && value !== null && "then" in value;
}

function encodeSecretWord(word: string) {
  return crypto.createHash("sha256").update(word).digest("hex");
}

function parseAlphabet(alphabetJson: string): Record<string, AlphabetState> {
  return JSON.parse(alphabetJson) as Record<string, AlphabetState>;
}

function parseRecentResults(value: string): Array<"W" | "L"> {
  return JSON.parse(value) as Array<"W" | "L">;
}

function assertValidDictionaryWord(word: string, expectedLength?: 4 | 5) {
  const reason = getWordValidationReason(word, expectedLength);
  if (reason) {
    throw new Error(reason);
  }
}

function assertValidGuessType(type: GuessType): GuessType {
  if (type !== "fourLetter" && type !== "fullWord") {
    throw new Error("Guess type is invalid.");
  }
  return type;
}

function assertValidAlphabetState(state: AlphabetState): AlphabetState {
  if (state !== "present" && state !== "absent" && state !== "unknown") {
    throw new Error("Alphabet state is invalid.");
  }
  return state;
}

function ensureUniqueCode(): MaybePromise<string> {
  if (databaseProvider === "sqlite") {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const code = generateGameCode(crypto.randomBytes(6));
      const existing = db.prepare(`SELECT id FROM games WHERE code = ?`).get(code) as { id: string } | undefined;
      if (!existing) {
        return code;
      }
    }
    throw new Error("Unable to generate a unique game code.");
  }

  return (async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const code = generateGameCode(crypto.randomBytes(6));
      const existing = (await db.prepare(`SELECT id FROM games WHERE code = ?`).get(code)) as { id: string } | undefined;
      if (!existing) {
        return code;
      }
    }
    throw new Error("Unable to generate a unique game code.");
  })();
}

function getPlayerInGameFrom(runner: DbRunner, gameId: string, userId: string) {
  const query = runner
    .prepare(
      `SELECT id, game_id, user_id, username, secret_word, alphabet_json, total_guesses, is_bot, bot_difficulty
       FROM players
       WHERE game_id = ?
       ORDER BY created_at ASC`
    )
    .all(gameId) as MaybePromise<Array<{
      id: string;
      game_id: string;
      user_id: string;
      username: string;
      secret_word: string;
      alphabet_json: string;
      total_guesses: number;
      is_bot: number;
      bot_difficulty: string | null;
    }>>;

  const resolvePlayers = (players: Array<{
    id: string;
    game_id: string;
    user_id: string;
    username: string;
    secret_word: string;
    alphabet_json: string;
    total_guesses: number;
    is_bot: number;
    bot_difficulty: string | null;
  }>) => {
    const player = players.find((entry) => entry.user_id === userId);
    if (!player) {
      throw new Error("You are not a participant in this game.");
    }

    return {
      player,
      players,
    };
  };

  return isPromiseLike(query) ? query.then(resolvePlayers) : resolvePlayers(query);
}

/**
 * Bot games are practice, not ranked play: they never touch user_stats, so the
 * leaderboard stays a record of games against real people and cannot be farmed
 * by grinding the easy bot.
 */
function gameHasBot(players: Array<{ is_bot?: number }>): boolean {
  return players.some((entry) => Boolean(entry.is_bot));
}

function getGameStatus(gameId: string) {
  return db.prepare(`SELECT status FROM games WHERE id = ?`).get(gameId) as MaybePromise<
    { status: "waiting" | "active" | "completed" } | undefined
  >;
}

// Reads the game row inside a transaction, taking a row lock on Postgres
// (SELECT ... FOR UPDATE) so concurrent guesses on the same game serialize.
// FOR UPDATE is Postgres-only, so it is omitted for SQLite (where BEGIN
// IMMEDIATE already serializes writers).
function lockGameForGuess(runner: DbRunner, gameId: string) {
  const forUpdate = databaseProvider === "postgres" ? " FOR UPDATE" : "";
  return runner.prepare(`SELECT id, status FROM games WHERE id = ?${forUpdate}`).get(gameId) as MaybePromise<
    { id: string; status: "waiting" | "active" | "completed" } | undefined
  >;
}

export type JoinWaitingGameParams = {
  game: WaitingGameRow;
  user: AuthUser;
  username: string;
  secretWord: string;
  createdAt: number;
  playerId: string;
};

export function performJoinWaitingGameWithRunner(runner: DbRunner, params: JoinWaitingGameParams) {
  const runJoin = async () => {
    const game = ((await runner
      .prepare(
        `SELECT id, status, created_at
         FROM games
         WHERE id = ?`
      )
      .get(params.game.id)) as WaitingGameRow | undefined) ?? params.game;

    if (isWaitingGameExpired({ status: game.status, createdAt: game.created_at })) {
      throw new Error("Game not found.");
    }
    if (game.status !== "waiting") {
      throw new Error("Game already started or completed.");
    }

    const existingPlayers = (await runner
      .prepare(`SELECT user_id FROM players WHERE game_id = ? ORDER BY created_at ASC`)
      .all(game.id)) as Array<{ user_id: string }>;

    if (existingPlayers.some((player) => player.user_id === params.user.id)) {
      throw new Error("You can't join your own game from the same account.");
    }
    if (existingPlayers.length >= 2) {
      throw new Error("Game is full.");
    }

    await runner
      .prepare(
        `INSERT INTO players (id, game_id, user_id, username, secret_word_hash, secret_word, alphabet_json, total_guesses, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
      )
      .run(
        params.playerId,
        game.id,
        params.user.id,
        params.username,
        encodeSecretWord(params.secretWord),
        params.secretWord,
        JSON.stringify(createEmptyAlphabet()),
        params.createdAt
      );
    await upsertPlayerPresence(
      {
        playerId: params.playerId,
        gameId: game.id,
        userId: params.user.id,
        state: "online",
        at: params.createdAt,
      },
      runner
    );
    await runner.prepare(`UPDATE games SET status = 'active', last_activity_at = ? WHERE id = ?`).run(params.createdAt, game.id);

    return { gameId: game.id };
  };

  if (databaseProvider === "sqlite") {
    if (isWaitingGameExpired({ status: params.game.status, createdAt: params.game.created_at })) {
      throw new Error("Game not found.");
    }
    if (params.game.status !== "waiting") {
      throw new Error("Game already started or completed.");
    }

    const existingPlayers = runner
      .prepare(`SELECT user_id FROM players WHERE game_id = ? ORDER BY created_at ASC`)
      .all(params.game.id) as Array<{ user_id: string }>;

    if (existingPlayers.some((player) => player.user_id === params.user.id)) {
      throw new Error("You can't join your own game from the same account.");
    }
    if (existingPlayers.length >= 2) {
      throw new Error("Game is full.");
    }

    runner
      .prepare(
        `INSERT INTO players (id, game_id, user_id, username, secret_word_hash, secret_word, alphabet_json, total_guesses, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
      )
      .run(
        params.playerId,
        params.game.id,
        params.user.id,
        params.username,
        encodeSecretWord(params.secretWord),
        params.secretWord,
        JSON.stringify(createEmptyAlphabet()),
        params.createdAt
      );
    upsertPlayerPresence(
      {
        playerId: params.playerId,
        gameId: params.game.id,
        userId: params.user.id,
        state: "online",
        at: params.createdAt,
      },
      runner
    );
    runner.prepare(`UPDATE games SET status = 'active', last_activity_at = ? WHERE id = ?`).run(params.createdAt, params.game.id);
    return { gameId: params.game.id };
  }

  return runJoin();
}

export function cleanupExpiredWaitingGames(): number;
export function cleanupExpiredWaitingGames(): any {
  const threshold = now() - 12 * 60 * 60 * 1000;
  // Abandoned ACTIVE games (no guess/chat/presence touch in 6h) are reaped too,
  // so they stop showing as live and their players stop waiting on them.
  const activeThreshold = now() - 6 * 60 * 60 * 1000;

  if (databaseProvider === "sqlite") {
    const expiredGames = db
      .prepare(`SELECT id FROM games WHERE status = 'waiting' AND created_at < ?`)
      .all(threshold) as Array<{ id: string }>;

    for (const game of expiredGames) {
      db.prepare(`DELETE FROM games WHERE id = ?`).run(game.id);
    }

    db.prepare(
      `UPDATE games SET status = 'completed', winner_player_id = NULL, completed_at = ?
       WHERE status = 'active' AND last_activity_at < ?`
    ).run(now(), activeThreshold);

    return expiredGames.length;
  }

  return (async () => {
    const result = (await db
      .prepare(`DELETE FROM games WHERE status = 'waiting' AND created_at < ?`)
      .run(threshold)) as { changes: number };

    await db
      .prepare(
        `UPDATE games SET status = 'completed', winner_player_id = NULL, completed_at = ?
         WHERE status = 'active' AND last_activity_at < ?`
      )
      .run(now(), activeThreshold);

    return result.changes ?? 0;
  })();
}

export function performJoinWaitingGame(params: JoinWaitingGameParams): { gameId: string };
export function performJoinWaitingGame(params: JoinWaitingGameParams): any {
  return performJoinWaitingGameWithRunner(db, params);
}

export function getLoggedInUser(user: AuthUser | null) {
  return user;
}

export function createGame(
  user: AuthUser,
  usernameInput: string,
  secretWordInput: string,
  isPublic: boolean
): { gameId: string; code: string };
export function createGame(
  user: AuthUser,
  usernameInput: string,
  secretWordInput: string,
  isPublic: boolean
): any {
  const username = sanitizeUsername(usernameInput);
  const secretWord = normalizeWord(secretWordInput);

  if (!isValidUsername(username)) {
    throw new Error("Username must be 2-20 characters and only use letters, numbers, spaces, hyphens, or underscores.");
  }

  assertValidDictionaryWord(secretWord, 5);

  if (databaseProvider === "sqlite") {
    cleanupExpiredWaitingGames();

    const gameId = uuid();
    const playerId = uuid();
    const createdAt = now();
    const code = ensureUniqueCode() as string;

    db.prepare(
      `INSERT INTO games (id, code, status, public, created_at, last_activity_at)
       VALUES (?, ?, 'waiting', ?, ?, ?)`
    ).run(gameId, code, isPublic ? 1 : 0, createdAt, createdAt);

    db.prepare(
      `INSERT INTO players (id, game_id, user_id, username, secret_word_hash, secret_word, alphabet_json, total_guesses, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
    ).run(
      playerId,
      gameId,
      user.id,
      username,
      encodeSecretWord(secretWord),
      secretWord,
      JSON.stringify(createEmptyAlphabet()),
      createdAt
    );
    upsertPlayerPresence({
      playerId,
      gameId,
      userId: user.id,
      state: "online",
      at: createdAt,
    });

    return { gameId, code };
  }

  return (async () => {
    await cleanupExpiredWaitingGames();

    const gameId = uuid();
    const playerId = uuid();
    const createdAt = now();
    const code = await ensureUniqueCode();

    await db.transaction(async (tx) => {
      await tx
        .prepare(
          `INSERT INTO games (id, code, status, public, created_at, last_activity_at)
           VALUES (?, ?, 'waiting', ?, ?, ?)`
        )
        .run(gameId, code, isPublic ? 1 : 0, createdAt, createdAt);

      await tx
        .prepare(
          `INSERT INTO players (id, game_id, user_id, username, secret_word_hash, secret_word, alphabet_json, total_guesses, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
        )
        .run(
          playerId,
          gameId,
          user.id,
          username,
          encodeSecretWord(secretWord),
          secretWord,
          JSON.stringify(createEmptyAlphabet()),
          createdAt
        );

      await upsertPlayerPresence(
        {
          playerId,
          gameId,
          userId: user.id,
          state: "online",
          at: createdAt,
        },
        tx
      );
    })();

    return { gameId, code };
  })();
}

/**
 * One shared account per difficulty rather than one per game. Bot results never
 * reach user_stats (see gameHasBot), so nothing accumulates on these rows.
 */
export const BOT_USER_IDS: Record<BotDifficulty, string> = {
  easy: "bot-easy",
  medium: "bot-medium",
  hard: "bot-hard",
};

// users.username feeds the social-handle uniqueness index, so a bot account
// occupies that namespace whether we want it to or not. These names contain a
// "." on purpose: isValidSocialUsername is /^[a-z0-9][a-z0-9_-]{1,19}$/, so no
// human can ever register one, which makes the account unsquattable.
//
// That matters because the failure was severe: with a registerable name, a
// single signup as "rookie-bot" took the row the bot needed, and from then on
// EVERY user's easy-mode bot game failed with "Unable to set up the bot
// opponent" — permanently, since retrying can't free the name.
//
// These are internal identifiers only. The name players actually see comes
// from players.username (BOT_DISPLAY_NAMES).
const BOT_ACCOUNT_USERNAMES: Record<BotDifficulty, string> = {
  easy: "bot.easy",
  medium: "bot.medium",
  hard: "bot.hard",
};

async function ensureBotUser(difficulty: BotDifficulty): Promise<string> {
  const userId = BOT_USER_IDS[difficulty];

  const existing = (await db.prepare(`SELECT id FROM users WHERE id = ?`).get(userId)) as { id: string } | undefined;
  if (existing) {
    return userId;
  }

  try {
    await db
      .prepare(
        `INSERT INTO users (id, email, username, password_hash, is_anonymous, is_bot, created_at)
         VALUES (?, NULL, ?, NULL, 0, 1, ?)`
      )
      .run(userId, BOT_ACCOUNT_USERNAMES[difficulty], now());
  } catch {
    // Two requests can race to seed the same bot account. Losing that race is
    // fine as long as the row exists afterwards, which the recheck confirms.
  }

  const confirmed = (await db.prepare(`SELECT id FROM users WHERE id = ?`).get(userId)) as { id: string } | undefined;
  if (!confirmed) {
    throw new Error("Unable to set up the bot opponent. Please try again.");
  }

  return userId;
}

/**
 * Starts a game against the bot. Unlike a normal game this opens already
 * `active` with both seats filled — there is nobody to wait for, so there is no
 * lobby stage.
 *
 * Written async-only rather than in the two-branch style used elsewhere in this
 * file: every statement here goes through the shared `db` interface, and
 * awaiting SQLite's synchronous results is harmless.
 */
export async function createBotGame(
  user: AuthUser,
  usernameInput: string,
  secretWordInput: string,
  difficultyInput: string
): Promise<{ gameId: string; code: string; botName: string }> {
  const username = sanitizeUsername(usernameInput);
  const secretWord = normalizeWord(secretWordInput);

  if (!isValidUsername(username)) {
    throw new Error("Username must be 2-20 characters and only use letters, numbers, spaces, hyphens, or underscores.");
  }

  assertValidDictionaryWord(secretWord, 5);

  if (!isBotDifficulty(difficultyInput)) {
    throw new Error("Choose a bot difficulty of easy, medium, or hard.");
  }

  const difficulty = difficultyInput;
  const botUserId = await ensureBotUser(difficulty);
  const botSecretWord = pickBotSecretWord();

  const gameId = uuid();
  const humanPlayerId = uuid();
  const botPlayerId = uuid();
  const createdAt = now();
  const code = await ensureUniqueCode();

  const insertPlayerSql = `INSERT INTO players (
      id, game_id, user_id, username, secret_word_hash, secret_word, alphabet_json,
      total_guesses, is_bot, bot_difficulty, bot_next_move_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`;

  await db.transaction(async (tx) => {
    await tx
      .prepare(
        `INSERT INTO games (id, code, status, public, created_at, last_activity_at)
         VALUES (?, ?, 'active', 0, ?, ?)`
      )
      .run(gameId, code, createdAt, createdAt);

    await tx
      .prepare(insertPlayerSql)
      .run(
        humanPlayerId,
        gameId,
        user.id,
        username,
        encodeSecretWord(secretWord),
        secretWord,
        JSON.stringify(createEmptyAlphabet()),
        0,
        null,
        null,
        createdAt
      );

    await tx
      .prepare(insertPlayerSql)
      .run(
        botPlayerId,
        gameId,
        botUserId,
        BOT_DISPLAY_NAMES[difficulty],
        encodeSecretWord(botSecretWord),
        botSecretWord,
        JSON.stringify(createEmptyAlphabet()),
        1,
        difficulty,
        createdAt + nextMoveDelayMs(difficulty),
        createdAt
      );

    await upsertPlayerPresence(
      { playerId: humanPlayerId, gameId, userId: user.id, state: "online", at: createdAt },
      tx
    );
    await upsertPlayerPresence(
      { playerId: botPlayerId, gameId, userId: botUserId, state: "online", at: createdAt },
      tx
    );
  })();

  return { gameId, code, botName: BOT_DISPLAY_NAMES[difficulty] };
}

export function joinGame(
  user: AuthUser,
  codeInput: string,
  usernameInput: string,
  secretWordInput: string
): { gameId: string };
export function joinGame(
  user: AuthUser,
  codeInput: string,
  usernameInput: string,
  secretWordInput: string
): any {
  const code = normalizeGameCode(codeInput);
  const username = sanitizeUsername(usernameInput);
  const secretWord = normalizeWord(secretWordInput);

  if (!isValidUsername(username)) {
    throw new Error("Username must be 2-20 characters and only use letters, numbers, spaces, hyphens, or underscores.");
  }

  if (code.length !== 6) {
    throw new Error("Game codes must be 6 characters.");
  }

  assertValidDictionaryWord(secretWord, 5);

  if (databaseProvider === "sqlite") {
    cleanupExpiredWaitingGames();

    const game = db
      .prepare(`SELECT id, status, created_at FROM games WHERE code = ?`)
      .get(code) as WaitingGameRow | undefined;
    if (!game || isWaitingGameExpired({ status: game.status, createdAt: game.created_at })) {
      throw new Error("Game not found.");
    }

    const createdAt = now();
    const playerId = uuid();
    performJoinWaitingGame({
      game,
      user,
      username,
      secretWord,
      createdAt,
      playerId,
    });

    void broadcastGameSignal(game.id, "updated");

    return { gameId: game.id };
  }

  return (async () => {
    await cleanupExpiredWaitingGames();

    const createdAt = now();
    const playerId = uuid();

    const result = await db.transaction(async (tx) => {
      const reservedGame = (await tx
        .prepare(
          `SELECT id, status, created_at
           FROM games
           WHERE code = ?
           FOR UPDATE`
        )
        .get(code)) as WaitingGameRow | undefined;

      if (!reservedGame || isWaitingGameExpired({ status: reservedGame.status, createdAt: reservedGame.created_at })) {
        throw new Error("Game not found.");
      }

      return performJoinWaitingGameWithRunner(tx, {
        game: reservedGame,
        user,
        username,
        secretWord,
        createdAt,
        playerId,
      });
    })();

    void broadcastGameSignal(result.gameId, "updated");

    return result;
  })();
}

export function listPublicLobbies(): {
  openLobbies: PublicLobby[];
  activeGamesCount: number;
  waitingPublicCount: number;
};
export function listPublicLobbies(): any {
  const mapResult = (
    lobbies: Array<{ code: string; created_at: number; host: string | null; players: number }>,
    activeGamesCount: number
  ) => {
    const openLobbies = lobbies
      .filter((lobby) => lobby.players < 2)
      .map((lobby) => ({
        code: lobby.code,
        host: lobby.host ?? "Unknown",
        createdAt: lobby.created_at,
        players: lobby.players,
      }));

    return {
      openLobbies,
      activeGamesCount,
      waitingPublicCount: openLobbies.length,
    };
  };

  if (databaseProvider === "sqlite") {
    cleanupExpiredWaitingGames();

    const lobbies = db
      .prepare(
        `SELECT games.code, games.created_at,
                (
                  SELECT players.username
                  FROM players
                  WHERE players.game_id = games.id
                  ORDER BY players.created_at ASC
                  LIMIT 1
                ) AS host,
                (SELECT COUNT(*) FROM players p2 WHERE p2.game_id = games.id) AS players
         FROM games
         WHERE games.public = 1 AND games.status = 'waiting'
         ORDER BY games.created_at DESC
         LIMIT ?`
      )
      .all(WAITING_GAME_LIMIT) as Array<{ code: string; created_at: number; host: string | null; players: number }>;

    const activeGamesCount = (
      db.prepare(`SELECT COUNT(*) AS count FROM games WHERE status = 'active'`).get() as { count: number }
    ).count;

    return mapResult(lobbies, activeGamesCount);
  }

  return (async () => {
    await cleanupExpiredWaitingGames();

    const lobbies = (await db
      .prepare(
        `WITH lobby_hosts AS (
           SELECT DISTINCT ON (players.game_id)
             players.game_id,
             players.username
           FROM players
           ORDER BY players.game_id, players.created_at ASC
         ),
         lobby_counts AS (
           SELECT players.game_id, COUNT(*)::int AS players
           FROM players
           GROUP BY players.game_id
         )
         SELECT games.code,
                games.created_at,
                lobby_hosts.username AS host,
                COALESCE(lobby_counts.players, 0)::int AS players
         FROM games
         LEFT JOIN lobby_hosts ON lobby_hosts.game_id = games.id
         LEFT JOIN lobby_counts ON lobby_counts.game_id = games.id
         WHERE games.public = 1 AND games.status = 'waiting'
         ORDER BY games.created_at DESC
         LIMIT ?`
      )
      .all(WAITING_GAME_LIMIT)) as Array<{ code: string; created_at: number; host: string | null; players: number }>;

    const activeGamesCount = (
      (await db.prepare(`SELECT COUNT(*) AS count FROM games WHERE status = 'active'`).get()) as { count: number }
    ).count;

    return mapResult(lobbies, activeGamesCount);
  })();
}

// A concurrent player may have filled or started the lobby we picked between our
// SELECT and our join. Those are transient contention errors: matchmaking should
// pick another lobby (or create one), not surface the failure to the caller.
function isMatchmakeContentionError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /already started|already completed|game is full|game not found/i.test(error.message);
}

function selectWaitingLobbyForMatchmake(userId: string, excludedGameIds: string[]) {
  const exclusionPlaceholders = excludedGameIds.map(() => "?").join(", ");
  const exclusionClause = excludedGameIds.length ? ` AND games.id NOT IN (${exclusionPlaceholders})` : "";
  return db
    .prepare(
      `SELECT games.id, games.code FROM games
       WHERE games.public = 1 AND games.status = 'waiting'
       AND games.id NOT IN (SELECT game_id FROM players WHERE user_id = ?)${exclusionClause}
       ORDER BY games.created_at ASC LIMIT 1`
    )
    .get(userId, ...excludedGameIds) as MaybePromise<{ id: string; code: string } | undefined>;
}

export function matchmake(
  user: AuthUser,
  usernameInput: string,
  secretWordInput: string
): { gameId: string; code: string };
export function matchmake(
  user: AuthUser,
  usernameInput: string,
  secretWordInput: string
): any {
  if (databaseProvider === "sqlite") {
    cleanupExpiredWaitingGames();

    const excludedGameIds: string[] = [];
    for (;;) {
      const row = selectWaitingLobbyForMatchmake(user.id, excludedGameIds) as
        | { id: string; code: string }
        | undefined;

      if (!row) {
        return createGame(user, usernameInput, secretWordInput, true);
      }

      try {
        joinGame(user, row.code, usernameInput, secretWordInput);
        return { gameId: row.id, code: row.code };
      } catch (error) {
        if (isMatchmakeContentionError(error)) {
          excludedGameIds.push(row.id);
          continue;
        }
        throw error;
      }
    }
  }

  return (async () => {
    await cleanupExpiredWaitingGames();

    const excludedGameIds: string[] = [];
    for (;;) {
      const row = (await selectWaitingLobbyForMatchmake(user.id, excludedGameIds)) as
        | { id: string; code: string }
        | undefined;

      if (!row) {
        return createGame(user, usernameInput, secretWordInput, true);
      }

      try {
        await joinGame(user, row.code, usernameInput, secretWordInput);
        return { gameId: row.id, code: row.code };
      } catch (error) {
        if (isMatchmakeContentionError(error)) {
          excludedGameIds.push(row.id);
          continue;
        }
        throw error;
      }
    }
  })();
}

export function getPlayerGames(user: AuthUser): RecentGameSummary[];
export function getPlayerGames(user: AuthUser): any {
  const mapRows = async (
    rows: Array<{
      game_id: string;
      code: string;
      status: "waiting" | "active" | "completed";
      public: number;
      created_at: number;
      last_activity_at: number;
      completed_at: number | null;
      player_id: string;
    }>
  ) =>
    Promise.all(
      rows.map(async (row) => {
        const opponent = databaseProvider === "sqlite"
          ? (db.prepare(`SELECT username FROM players WHERE game_id = ? AND id != ? LIMIT 1`).get(row.game_id, row.player_id) as
              | { username: string }
              | undefined)
          : ((await db
              .prepare(`SELECT username FROM players WHERE game_id = ? AND id != ? LIMIT 1`)
              .get(row.game_id, row.player_id)) as { username: string } | undefined);

        const isExpired = row.status === "waiting" && isWaitingGameExpired({ status: row.status, createdAt: row.created_at });

        return {
          gameId: row.game_id,
          code: row.code,
          status: row.status,
          public: Boolean(row.public),
          createdAt: row.created_at,
          lastActivityAt: row.last_activity_at,
          completedAt: row.completed_at ?? undefined,
          opponentName: opponent?.username,
          isMyTurnToWait: row.status === "waiting",
          isExpired,
        };
      })
    );

  if (databaseProvider === "sqlite") {
    cleanupExpiredWaitingGames();

    const rows = db
      .prepare(
        `SELECT games.id AS game_id, games.code, games.status, games.public, games.created_at, games.last_activity_at, games.completed_at,
                me.id AS player_id
         FROM players me
         JOIN games ON games.id = me.game_id
         WHERE me.user_id = ?
         ORDER BY games.last_activity_at DESC`
      )
      .all(user.id) as Array<{
        game_id: string;
        code: string;
        status: "waiting" | "active" | "completed";
        public: number;
        created_at: number;
        last_activity_at: number;
        completed_at: number | null;
        player_id: string;
      }>;

    let result: RecentGameSummary[] = [];
    void mapRows(rows).then((value) => {
      result = value;
    });
    return rows.map((row) => {
      const opponent = db.prepare(`SELECT username FROM players WHERE game_id = ? AND id != ? LIMIT 1`).get(row.game_id, row.player_id) as
        | { username: string }
        | undefined;
      const isExpired = row.status === "waiting" && isWaitingGameExpired({ status: row.status, createdAt: row.created_at });

      return {
        gameId: row.game_id,
        code: row.code,
        status: row.status,
        public: Boolean(row.public),
        createdAt: row.created_at,
        lastActivityAt: row.last_activity_at,
        completedAt: row.completed_at ?? undefined,
        opponentName: opponent?.username,
        isMyTurnToWait: row.status === "waiting",
        isExpired,
      };
    });
  }

  return (async () => {
    await cleanupExpiredWaitingGames();

    const rows = (await db
      .prepare(
        `SELECT games.id AS game_id, games.code, games.status, games.public, games.created_at, games.last_activity_at, games.completed_at,
                me.id AS player_id
         FROM players me
         JOIN games ON games.id = me.game_id
         WHERE me.user_id = ?
         ORDER BY games.last_activity_at DESC`
      )
      .all(user.id)) as Array<{
      game_id: string;
      code: string;
      status: "waiting" | "active" | "completed";
      public: number;
      created_at: number;
      last_activity_at: number;
      completed_at: number | null;
      player_id: string;
    }>;

    return mapRows(rows);
  })();
}

export function getGameState(user: AuthUser, gameId: string): GameStateView | null;
export function getGameState(user: AuthUser, gameId: string): any {
  if (databaseProvider === "sqlite") {
    cleanupExpiredWaitingGames();

    const game = db
      .prepare(
        `SELECT id, code, status, public, created_at, last_activity_at, completed_at, winner_player_id
         FROM games
         WHERE id = ?`
      )
      .get(gameId) as
      | {
          id: string;
          code: string;
          status: "waiting" | "active" | "completed";
          public: number;
          created_at: number;
          last_activity_at: number;
          completed_at: number | null;
          winner_player_id: string | null;
        }
      | undefined;

    if (!game) {
      return null;
    }

    const players = db
      .prepare(
        `SELECT id, user_id, username, secret_word, alphabet_json, total_guesses, is_bot
         FROM players
         WHERE game_id = ?
         ORDER BY created_at ASC`
      )
      .all(gameId) as GameStatePlayerRow[];
    const viewerPlayer = players.find((player) => player.user_id === user.id);
    if (!viewerPlayer) {
      return null;
    }

    touchPlayerPresence({
      playerId: viewerPlayer.id,
      gameId,
      userId: user.id,
    });

    const guesses = db
      .prepare(
        `SELECT id, player_id, type, text, match_count, is_correct, guess_number, created_at
         FROM guesses
         WHERE game_id = ?
         ORDER BY guess_number ASC, created_at ASC`
      )
      .all(gameId) as GameStateGuessRow[];

    const view = buildGameStateView({
      game: {
        _id: game.id,
        code: game.code,
        status: game.status,
        public: Boolean(game.public),
        createdAt: game.created_at,
        lastActivityAt: game.last_activity_at,
        completedAt: game.completed_at ?? undefined,
        winnerId: game.winner_player_id ?? undefined,
      },
      players: players.map((player) => ({
        _id: player.id,
        userId: player.user_id,
        username: player.username,
        secretWord: player.secret_word,
        alphabet: parseAlphabet(player.alphabet_json),
        totalGuesses: player.total_guesses,
        isBot: Boolean(player.is_bot),
      })),
      guesses: guesses.map((guess) => ({
        _id: guess.id,
        playerId: guess.player_id,
        type: guess.type,
        text: guess.text,
        matchCount: guess.match_count,
        isCorrect: Boolean(guess.is_correct),
        guessNumber: guess.guess_number,
        createdAt: guess.created_at,
      })),
      viewerUserId: user.id,
    });

    if (!view) {
      return null;
    }

    const presenceByPlayerId = getGamePresence(gameId) as Map<string, "online" | "offline">;
    const resolvePresence = (playerId: string) => presenceByPlayerId.get(playerId) ?? "offline";

    return {
      game: {
        id: view.game._id,
        code: view.game.code,
        status: view.game.status,
        public: view.game.public,
        createdAt: view.game.createdAt,
        lastActivityAt: view.game.lastActivityAt,
        completedAt: view.game.completedAt,
        winnerId: view.game.winnerId,
      },
      me: {
        id: view.me._id,
        username: view.me.username,
        alphabet: view.me.alphabet,
        totalGuesses: view.me.totalGuesses,
        secretWord: view.me.secretWord,
      },
      opponent: view.opponent
        ? {
            id: view.opponent._id,
            username: view.opponent.username,
            totalGuesses: view.opponent.totalGuesses,
            secretWord: view.opponent.secretWord,
            isBot: view.opponent.isBot,
          }
        : null,
      myGuesses: view.myGuesses.map((guess) => ({
        id: guess._id,
        playerId: guess.playerId,
        type: guess.type,
        text: guess.text,
        matchCount: guess.matchCount,
        isCorrect: guess.isCorrect,
        guessNumber: guess.guessNumber,
        createdAt: (guess as { createdAt?: number }).createdAt ?? 0,
      })),
      opponentGuesses: view.opponentGuesses.map((guess) => ({
        id: guess._id,
        playerId: guess.playerId,
        type: guess.type,
        text: guess.text,
        matchCount: guess.matchCount,
        isCorrect: guess.isCorrect,
        guessNumber: guess.guessNumber,
        createdAt: (guess as { createdAt?: number }).createdAt ?? 0,
      })),
      myFoundLetterCount: view.myFoundLetterCount,
      opponentFoundLetterCount: view.opponentFoundLetterCount,
      opponentGreenLetterInsight: view.opponentGreenLetterInsight ?? null,
      presence: {
        me: resolvePresence(view.me._id),
        // A bot never disconnects, so it is not subject to the presence TTL —
        // otherwise it would flicker offline between its slower moves.
        opponent: view.opponent ? (view.opponent.isBot ? "online" : resolvePresence(view.opponent._id)) : null,
      },
    };
  }

  return (async () => {
    await cleanupExpiredWaitingGames();

    const game = (await db
      .prepare(
        `SELECT id, code, status, public, created_at, last_activity_at, completed_at, winner_player_id
         FROM games
         WHERE id = ?`
      )
      .get(gameId)) as
      | {
          id: string;
          code: string;
          status: "waiting" | "active" | "completed";
          public: number;
          created_at: number;
          last_activity_at: number;
          completed_at: number | null;
          winner_player_id: string | null;
        }
      | undefined;

    if (!game) {
      return null;
    }

    const players = (await db
      .prepare(
        `SELECT id, user_id, username, secret_word, alphabet_json, total_guesses, is_bot
         FROM players
         WHERE game_id = ?
         ORDER BY created_at ASC`
      )
      .all(gameId)) as GameStatePlayerRow[];
    const viewerPlayer = players.find((player) => player.user_id === user.id);
    if (!viewerPlayer) {
      return null;
    }

    await touchPlayerPresence({
      playerId: viewerPlayer.id,
      gameId,
      userId: user.id,
    });

    const guesses = (await db
      .prepare(
        `SELECT id, player_id, type, text, match_count, is_correct, guess_number, created_at
         FROM guesses
         WHERE game_id = ?
         ORDER BY guess_number ASC, created_at ASC`
      )
      .all(gameId)) as GameStateGuessRow[];

    const view = buildGameStateView({
      game: {
        _id: game.id,
        code: game.code,
        status: game.status,
        public: Boolean(game.public),
        createdAt: game.created_at,
        lastActivityAt: game.last_activity_at,
        completedAt: game.completed_at ?? undefined,
        winnerId: game.winner_player_id ?? undefined,
      },
      players: players.map((player) => ({
        _id: player.id,
        userId: player.user_id,
        username: player.username,
        secretWord: player.secret_word,
        alphabet: parseAlphabet(player.alphabet_json),
        totalGuesses: player.total_guesses,
        isBot: Boolean(player.is_bot),
      })),
      guesses: guesses.map((guess) => ({
        _id: guess.id,
        playerId: guess.player_id,
        type: guess.type,
        text: guess.text,
        matchCount: guess.match_count,
        isCorrect: Boolean(guess.is_correct),
        guessNumber: guess.guess_number,
        createdAt: guess.created_at,
      })),
      viewerUserId: user.id,
    });

    if (!view) {
      return null;
    }

    const presenceByPlayerId = await getGamePresence(gameId);
    const resolvePresence = (playerId: string) => presenceByPlayerId.get(playerId) ?? "offline";

    return {
      game: {
        id: view.game._id,
        code: view.game.code,
        status: view.game.status,
        public: view.game.public,
        createdAt: view.game.createdAt,
        lastActivityAt: view.game.lastActivityAt,
        completedAt: view.game.completedAt,
        winnerId: view.game.winnerId,
      },
      me: {
        id: view.me._id,
        username: view.me.username,
        alphabet: view.me.alphabet,
        totalGuesses: view.me.totalGuesses,
        secretWord: view.me.secretWord,
      },
      opponent: view.opponent
        ? {
            id: view.opponent._id,
            username: view.opponent.username,
            totalGuesses: view.opponent.totalGuesses,
            secretWord: view.opponent.secretWord,
            isBot: view.opponent.isBot,
          }
        : null,
      myGuesses: view.myGuesses.map((guess) => ({
        id: guess._id,
        playerId: guess.playerId,
        type: guess.type,
        text: guess.text,
        matchCount: guess.matchCount,
        isCorrect: guess.isCorrect,
        guessNumber: guess.guessNumber,
        createdAt: (guess as { createdAt?: number }).createdAt ?? 0,
      })),
      opponentGuesses: view.opponentGuesses.map((guess) => ({
        id: guess._id,
        playerId: guess.playerId,
        type: guess.type,
        text: guess.text,
        matchCount: guess.matchCount,
        isCorrect: guess.isCorrect,
        guessNumber: guess.guessNumber,
        createdAt: (guess as { createdAt?: number }).createdAt ?? 0,
      })),
      myFoundLetterCount: view.myFoundLetterCount,
      opponentFoundLetterCount: view.opponentFoundLetterCount,
      opponentGreenLetterInsight: view.opponentGreenLetterInsight ?? null,
      presence: {
        me: resolvePresence(view.me._id),
        // A bot never disconnects, so it is not subject to the presence TTL —
        // otherwise it would flicker offline between its slower moves.
        opponent: view.opponent ? (view.opponent.isBot ? "online" : resolvePresence(view.opponent._id)) : null,
      },
    };
  })();
}

function updateUserStatsWithRunner(runner: DbRunner, userId: string, won: boolean, guesses: number, username: string): MaybePromise<void> {
  const upsertStats = async () => {
    const existing = (await runner
      .prepare(
        `SELECT wins, losses, total_guesses, total_win_guesses, games_played, current_win_streak, recent_results_json, best_win_guesses
         FROM user_stats
         WHERE user_id = ?`
      )
      .get(userId)) as UserStatsRow | undefined;

    const updatedAt = now();
    if (!existing) {
      await runner
        .prepare(
          `INSERT INTO user_stats (
            user_id, wins, losses, total_guesses, total_win_guesses, games_played, most_recent_username, current_win_streak,
            recent_results_json, best_win_guesses, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          userId,
          won ? 1 : 0,
          won ? 0 : 1,
          guesses,
          won ? guesses : 0,
          1,
          username,
          won ? 1 : 0,
          JSON.stringify(pushRecentResult([], won ? "W" : "L")),
          won ? guesses : null,
          updatedAt
        );
      return;
    }

    const recentResults = pushRecentResult(parseRecentResults(existing.recent_results_json), won ? "W" : "L");
    const bestWinGuesses =
      won && existing.best_win_guesses !== null
        ? Math.min(existing.best_win_guesses, guesses)
        : won
          ? guesses
          : existing.best_win_guesses;

    await runner
      .prepare(
        `UPDATE user_stats
         SET wins = ?, losses = ?, total_guesses = ?, total_win_guesses = ?, games_played = ?, most_recent_username = ?,
             current_win_streak = ?, recent_results_json = ?, best_win_guesses = ?, updated_at = ?
         WHERE user_id = ?`
      )
      .run(
        existing.wins + (won ? 1 : 0),
        existing.losses + (won ? 0 : 1),
        existing.total_guesses + guesses,
        existing.total_win_guesses + (won ? guesses : 0),
        existing.games_played + 1,
        username,
        won ? existing.current_win_streak + 1 : 0,
        JSON.stringify(recentResults),
        bestWinGuesses,
        updatedAt,
        userId
      );
  };

  if (databaseProvider === "sqlite") {
    const existing = db
      .prepare(
        `SELECT wins, losses, total_guesses, total_win_guesses, games_played, current_win_streak, recent_results_json, best_win_guesses
         FROM user_stats
         WHERE user_id = ?`
      )
      .get(userId) as UserStatsRow | undefined;

    const updatedAt = now();
    if (!existing) {
      db.prepare(
        `INSERT INTO user_stats (
          user_id, wins, losses, total_guesses, total_win_guesses, games_played, most_recent_username, current_win_streak,
          recent_results_json, best_win_guesses, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        userId,
        won ? 1 : 0,
        won ? 0 : 1,
        guesses,
        won ? guesses : 0,
        1,
        username,
        won ? 1 : 0,
        JSON.stringify(pushRecentResult([], won ? "W" : "L")),
        won ? guesses : null,
        updatedAt
      );
      return;
    }

    const recentResults = pushRecentResult(parseRecentResults(existing.recent_results_json), won ? "W" : "L");
    const bestWinGuesses =
      won && existing.best_win_guesses !== null
        ? Math.min(existing.best_win_guesses, guesses)
        : won
          ? guesses
          : existing.best_win_guesses;

    db.prepare(
      `UPDATE user_stats
       SET wins = ?, losses = ?, total_guesses = ?, total_win_guesses = ?, games_played = ?, most_recent_username = ?,
           current_win_streak = ?, recent_results_json = ?, best_win_guesses = ?, updated_at = ?
       WHERE user_id = ?`
    ).run(
      existing.wins + (won ? 1 : 0),
      existing.losses + (won ? 0 : 1),
      existing.total_guesses + guesses,
      existing.total_win_guesses + (won ? guesses : 0),
      existing.games_played + 1,
      username,
      won ? existing.current_win_streak + 1 : 0,
      JSON.stringify(recentResults),
      bestWinGuesses,
      updatedAt,
      userId
    );
    return;
  }

  return upsertStats();
}

export function submitGuess(
  user: AuthUser,
  gameId: string,
  type: GuessType,
  textInput: string
): { matchCount: number; isCorrect: boolean; guessNumber: number; gameStatus: "active" | "completed" };
export function submitGuess(user: AuthUser, gameId: string, type: GuessType, textInput: string): any {
  const normalizedType = assertValidGuessType(type);

  if (databaseProvider === "sqlite") {
    const game = db
      .prepare(`SELECT id, status FROM games WHERE id = ?`)
      .get(gameId) as { id: string; status: "waiting" | "active" | "completed" } | undefined;
    if (!game || game.status !== "active") {
      throw new Error("Game is not active.");
    }

    const { player, players } = getPlayerInGameFrom(db, gameId, user.id) as ReturnType<typeof getPlayerInGameFrom> extends Promise<infer T>
      ? never
      : { player: GameStatePlayerRow; players: GameStatePlayerRow[] };
    touchPlayerPresence({
      playerId: player.id,
      gameId,
      userId: user.id,
    });
    const opponent = players.find((entry) => entry.id !== player.id);
    if (!opponent) {
      throw new Error("Opponent not found.");
    }

    const text = normalizeWord(textInput);
    assertValidDictionaryWord(text, normalizedType === "fourLetter" ? 4 : 5);

    const isCorrect = normalizedType === "fullWord" && text === opponent.secret_word;
    const matchCount = normalizedType === "fullWord" ? (isCorrect ? 5 : 0) : calculateMatchCount(text, opponent.secret_word);

    const guessId = uuid();
    const submittedAt = now();

    // BEGIN IMMEDIATE (see db.transaction) serializes writers so concurrent
    // guesses on the same game can't both pass the active check and both write
    // a winner. Re-assert status and compute guessNumber inside the txn.
    const guessNumber = db.transaction((tx) => {
      const lockedGame = lockGameForGuess(tx, gameId) as { id: string; status: "waiting" | "active" | "completed" } | undefined;
      if (!lockedGame || lockedGame.status !== "active") {
        throw new Error("Game is not active.");
      }

      // Under the lock, matching the Postgres branch. Correct here either way
      // because the synchronous driver can't interleave two requests, but the
      // two branches drifting apart is what let the Postgres race exist
      // unnoticed — the SQLite tests passed.
      const guessTimes = tx
        .prepare(
          `SELECT created_at
           FROM guesses
           WHERE game_id = ? AND player_id = ?
           ORDER BY created_at DESC
           LIMIT 25`
        )
        .all(gameId, player.id) as Array<{ created_at: number }>;
      const rateLimitError = getGuessRateLimitError(guessTimes.map((row) => row.created_at));
      if (rateLimitError) {
        throw new Error(rateLimitError);
      }

      const nextGuessNumber =
        ((tx.prepare(`SELECT COUNT(*) AS count FROM guesses WHERE player_id = ?`).get(player.id) as { count: number }).count ?? 0) + 1;

      tx.prepare(
        `INSERT INTO guesses (id, game_id, player_id, type, text, match_count, is_correct, guess_number, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(guessId, gameId, player.id, normalizedType, text, matchCount, isCorrect ? 1 : 0, nextGuessNumber, submittedAt);

      tx.prepare(`UPDATE players SET total_guesses = ? WHERE id = ?`).run(nextGuessNumber, player.id);

      if (isCorrect) {
        tx.prepare(
          `UPDATE games SET status = 'completed', winner_player_id = ?, completed_at = ?, last_activity_at = ? WHERE id = ?`
        ).run(player.id, submittedAt, submittedAt, gameId);
        if (!gameHasBot(players)) {
          updateUserStatsWithRunner(tx, user.id, true, nextGuessNumber, player.username);
          updateUserStatsWithRunner(tx, opponent.user_id, false, opponent.total_guesses, opponent.username);
        }
      } else {
        tx.prepare(`UPDATE games SET last_activity_at = ? WHERE id = ?`).run(submittedAt, gameId);
      }

      return nextGuessNumber;
    })() as number;

    void broadcastGameSignal(gameId, "updated");

    return {
      matchCount,
      isCorrect,
      guessNumber,
      gameStatus: (isCorrect ? "completed" : "active") as "active" | "completed",
    };
  }

  return (async () => {
    const game = (await db
      .prepare(`SELECT id, status FROM games WHERE id = ?`)
      .get(gameId)) as { id: string; status: "waiting" | "active" | "completed" } | undefined;
    if (!game || game.status !== "active") {
      throw new Error("Game is not active.");
    }

    const { player, players } = (await getPlayerInGameFrom(db, gameId, user.id)) as {
      player: GameStatePlayerRow;
      players: GameStatePlayerRow[];
    };
    await touchPlayerPresence({
      playerId: player.id,
      gameId,
      userId: user.id,
    });
    const opponent = players.find((entry) => entry.id !== player.id);
    if (!opponent) {
      throw new Error("Opponent not found.");
    }

    const text = normalizeWord(textInput);
    assertValidDictionaryWord(text, normalizedType === "fourLetter" ? 4 : 5);

    const isCorrect = normalizedType === "fullWord" && text === opponent.secret_word;
    const matchCount = normalizedType === "fullWord" ? (isCorrect ? 5 : 0) : calculateMatchCount(text, opponent.secret_word);

    const guessId = uuid();
    const submittedAt = now();

    // Take a row lock on the games row and re-read status INSIDE the txn so two
    // simultaneous correct guesses (or a double-click) can't both pass the
    // active check and both write status=completed/winner. guessNumber is also
    // computed under the lock so it can't collide.
    const guessNumber = (await db.transaction(async (tx) => {
      const lockedGame = (await lockGameForGuess(tx, gameId)) as
        | { id: string; status: "waiting" | "active" | "completed" }
        | undefined;
      if (!lockedGame || lockedGame.status !== "active") {
        throw new Error("Game is not active.");
      }

      // The pacing check reads the player's own guess history, so it has to run
      // under the same lock as the insert. Outside it, two overlapping requests
      // both read a history without the other's guess in it, both pass, and
      // both insert — a double-submit landed twice on Postgres while SQLite hid
      // it behind its synchronous driver.
      const guessTimes = (await tx
        .prepare(
          `SELECT created_at
           FROM guesses
           WHERE game_id = ? AND player_id = ?
           ORDER BY created_at DESC
           LIMIT 25`
        )
        .all(gameId, player.id)) as Array<{ created_at: number }>;
      const rateLimitError = getGuessRateLimitError(guessTimes.map((row) => row.created_at));
      if (rateLimitError) {
        throw new Error(rateLimitError);
      }

      const nextGuessNumber =
        ((((await tx.prepare(`SELECT COUNT(*) AS count FROM guesses WHERE player_id = ?`).get(player.id)) as { count: number }).count ?? 0) + 1);

      await tx
        .prepare(
          `INSERT INTO guesses (id, game_id, player_id, type, text, match_count, is_correct, guess_number, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(guessId, gameId, player.id, normalizedType, text, matchCount, isCorrect ? 1 : 0, nextGuessNumber, submittedAt);

      await tx.prepare(`UPDATE players SET total_guesses = ? WHERE id = ?`).run(nextGuessNumber, player.id);

      if (isCorrect) {
        await tx
          .prepare(
            `UPDATE games SET status = 'completed', winner_player_id = ?, completed_at = ?, last_activity_at = ? WHERE id = ?`
          )
          .run(player.id, submittedAt, submittedAt, gameId);
        if (!gameHasBot(players)) {
          await updateUserStatsWithRunner(tx, user.id, true, nextGuessNumber, player.username);
          await updateUserStatsWithRunner(tx, opponent.user_id, false, opponent.total_guesses, opponent.username);
        }
      } else {
        await tx.prepare(`UPDATE games SET last_activity_at = ? WHERE id = ?`).run(submittedAt, gameId);
      }

      return nextGuessNumber;
    })()) as number;

    void broadcastGameSignal(gameId, "updated");

    return {
      matchCount,
      isCorrect,
      guessNumber,
      gameStatus: (isCorrect ? "completed" : "active") as "active" | "completed",
    };
  })();
}

export function forfeitGame(user: AuthUser, gameId: string): { status: "completed"; winnerPlayerId: string };
export function forfeitGame(user: AuthUser, gameId: string): any {
  if (databaseProvider === "sqlite") {
    const game = db
      .prepare(`SELECT id, status FROM games WHERE id = ?`)
      .get(gameId) as { id: string; status: "waiting" | "active" | "completed" } | undefined;
    if (!game || game.status !== "active") {
      throw new Error("Game is not active.");
    }

    const { player, players } = getPlayerInGameFrom(db, gameId, user.id) as {
      player: GameStatePlayerRow & { user_id: string };
      players: Array<GameStatePlayerRow & { user_id: string }>;
    };
    const opponent = players.find((entry) => entry.id !== player.id);
    if (!opponent) {
      throw new Error("Opponent not found.");
    }

    const completedAt = now();

    // BEGIN IMMEDIATE serializes writers; re-assert status under the lock so a
    // forfeit can't race a final guess (or a concurrent forfeit) into a double
    // completion / conflicting winner.
    db.transaction((tx) => {
      const lockedGame = lockGameForGuess(tx, gameId) as
        | { id: string; status: "waiting" | "active" | "completed" }
        | undefined;
      if (!lockedGame || lockedGame.status !== "active") {
        throw new Error("Game is not active.");
      }

      tx.prepare(
        `UPDATE games SET status = 'completed', winner_player_id = ?, completed_at = ?, last_activity_at = ? WHERE id = ?`
      ).run(opponent.id, completedAt, completedAt, gameId);
      if (!gameHasBot(players)) {
        updateUserStatsWithRunner(tx, player.user_id, false, player.total_guesses, player.username);
        updateUserStatsWithRunner(tx, opponent.user_id, true, opponent.total_guesses, opponent.username);
      }
    })();

    void broadcastGameSignal(gameId, "updated");

    return { status: "completed" as const, winnerPlayerId: opponent.id };
  }

  return (async () => {
    const game = (await db
      .prepare(`SELECT id, status FROM games WHERE id = ?`)
      .get(gameId)) as { id: string; status: "waiting" | "active" | "completed" } | undefined;
    if (!game || game.status !== "active") {
      throw new Error("Game is not active.");
    }

    const { player, players } = (await getPlayerInGameFrom(db, gameId, user.id)) as {
      player: GameStatePlayerRow & { user_id: string };
      players: Array<GameStatePlayerRow & { user_id: string }>;
    };
    const opponent = players.find((entry) => entry.id !== player.id);
    if (!opponent) {
      throw new Error("Opponent not found.");
    }

    const completedAt = now();

    await db.transaction(async (tx) => {
      const lockedGame = (await lockGameForGuess(tx, gameId)) as
        | { id: string; status: "waiting" | "active" | "completed" }
        | undefined;
      if (!lockedGame || lockedGame.status !== "active") {
        throw new Error("Game is not active.");
      }

      await tx
        .prepare(
          `UPDATE games SET status = 'completed', winner_player_id = ?, completed_at = ?, last_activity_at = ? WHERE id = ?`
        )
        .run(opponent.id, completedAt, completedAt, gameId);
      if (!gameHasBot(players)) {
        await updateUserStatsWithRunner(tx, player.user_id, false, player.total_guesses, player.username);
        await updateUserStatsWithRunner(tx, opponent.user_id, true, opponent.total_guesses, opponent.username);
      }
    })();

    void broadcastGameSignal(gameId, "updated");

    return { status: "completed" as const, winnerPlayerId: opponent.id };
  })();
}

export function updateAlphabet(user: AuthUser, gameId: string, letterInput: string, state: AlphabetState): Record<string, AlphabetState>;
export function updateAlphabet(user: AuthUser, gameId: string, letterInput: string, state: AlphabetState): any {
  const letter = letterInput.trim().toUpperCase();
  if (!/^[A-Z]$/.test(letter)) {
    throw new Error("Please choose a single letter A-Z.");
  }

  if (databaseProvider === "sqlite") {
    const game = getGameStatus(gameId) as { status: "waiting" | "active" | "completed" } | undefined;
    if (!game || game.status !== "active") {
      throw new Error("Game is not active.");
    }

    const { player } = getPlayerInGameFrom(db, gameId, user.id) as { player: GameStatePlayerRow };
    touchPlayerPresence({
      playerId: player.id,
      gameId,
      userId: user.id,
    });
    const alphabet = parseAlphabet(player.alphabet_json);
    alphabet[letter] = assertValidAlphabetState(state);
    db.prepare(`UPDATE players SET alphabet_json = ? WHERE id = ?`).run(JSON.stringify(alphabet), player.id);
    void broadcastGameSignal(gameId, "updated");
    return alphabet;
  }

  return (async () => {
    const game = (await getGameStatus(gameId)) as { status: "waiting" | "active" | "completed" } | undefined;
    if (!game || game.status !== "active") {
      throw new Error("Game is not active.");
    }

    const { player } = (await getPlayerInGameFrom(db, gameId, user.id)) as { player: GameStatePlayerRow };
    await touchPlayerPresence({
      playerId: player.id,
      gameId,
      userId: user.id,
    });
    // Atomic single-statement update. The old read-modify-write (parse JSON in
    // JS, write the whole blob back) let two concurrent letter updates clobber
    // each other — both read the same base, last write wins, first mark lost.
    // jsonb_set touches only this letter, so concurrent updates to different
    // letters both survive.
    const validState = assertValidAlphabetState(state);
    const rows = (await db
      .prepare(
        `UPDATE players
         SET alphabet_json = jsonb_set(COALESCE(alphabet_json, '{}')::jsonb, ARRAY[?], to_jsonb(?::text))::text
         WHERE id = ?
         RETURNING alphabet_json`
      )
      .all(letter, validState, player.id)) as Array<{ alphabet_json: string }>;
    void broadcastGameSignal(gameId, "updated");
    return parseAlphabet(rows[0]?.alphabet_json ?? "{}");
  })();
}

export function listChatMessages(user: AuthUser, gameId: string): ChatMessageView[];
export function listChatMessages(user: AuthUser, gameId: string): any {
  if (databaseProvider === "sqlite") {
    const { player } = getPlayerInGameFrom(db, gameId, user.id) as { player: GameStatePlayerRow };
    touchPlayerPresence({
      playerId: player.id,
      gameId,
      userId: user.id,
    });
    const rows = db
      .prepare(
        `SELECT id, game_id, player_id, username, text, created_at
         FROM chat_messages
         WHERE game_id = ?
         ORDER BY created_at ASC
         LIMIT 100`
      )
      .all(gameId) as ChatMessageRow[];
    return rows.map((row) => ({
      id: row.id,
      gameId: row.game_id,
      playerId: row.player_id,
      username: row.username,
      text: row.text,
      createdAt: row.created_at,
    }));
  }

  return (async () => {
    const { player } = (await getPlayerInGameFrom(db, gameId, user.id)) as { player: GameStatePlayerRow };
    await touchPlayerPresence({
      playerId: player.id,
      gameId,
      userId: user.id,
    });
    const rows = (await db
      .prepare(
        `SELECT id, game_id, player_id, username, text, created_at
         FROM chat_messages
         WHERE game_id = ?
         ORDER BY created_at ASC
         LIMIT 100`
      )
      .all(gameId)) as ChatMessageRow[];
    return rows.map((row) => ({
      id: row.id,
      gameId: row.game_id,
      playerId: row.player_id,
      username: row.username,
      text: row.text,
      createdAt: row.created_at,
    }));
  })();
}

export function sendChatMessage(user: AuthUser, gameId: string, textInput: string): { messageId: string };
export function sendChatMessage(user: AuthUser, gameId: string, textInput: string): any {
  const text = sanitizeChatText(textInput);
  const moderationError = getChatModerationError(text);
  if (moderationError) {
    throw new Error(moderationError);
  }

  if (databaseProvider === "sqlite") {
    const game = db
      .prepare(`SELECT status FROM games WHERE id = ?`)
      .get(gameId) as { status: "waiting" | "active" | "completed" } | undefined;
    if (!game || game.status !== "active") {
      throw new Error("Chat is only available during active games.");
    }

    const { player } = getPlayerInGameFrom(db, gameId, user.id) as { player: GameStatePlayerRow };
    touchPlayerPresence({
      playerId: player.id,
      gameId,
      userId: user.id,
    });

    const messageTimes = db
      .prepare(`SELECT created_at FROM chat_messages WHERE game_id = ? AND player_id = ? ORDER BY created_at DESC LIMIT 25`)
      .all(gameId, player.id) as Array<{ created_at: number }>;
    const rateLimitError = getChatRateLimitError(messageTimes.map((row) => row.created_at));
    if (rateLimitError) {
      throw new Error(rateLimitError);
    }

    const messageId = uuid();
    const createdAt = now();
    db.prepare(
      `INSERT INTO chat_messages (id, game_id, player_id, username, text, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(messageId, gameId, player.id, player.username, text, createdAt);
    db.prepare(`UPDATE games SET last_activity_at = ? WHERE id = ?`).run(createdAt, gameId);

    return { messageId };
  }

  return (async () => {
    const game = (await db
      .prepare(`SELECT status FROM games WHERE id = ?`)
      .get(gameId)) as { status: "waiting" | "active" | "completed" } | undefined;
    if (!game || game.status !== "active") {
      throw new Error("Chat is only available during active games.");
    }

    const { player } = (await getPlayerInGameFrom(db, gameId, user.id)) as { player: GameStatePlayerRow };
    await touchPlayerPresence({
      playerId: player.id,
      gameId,
      userId: user.id,
    });

    const messageTimes = (await db
      .prepare(`SELECT created_at FROM chat_messages WHERE game_id = ? AND player_id = ? ORDER BY created_at DESC LIMIT 25`)
      .all(gameId, player.id)) as Array<{ created_at: number }>;
    const rateLimitError = getChatRateLimitError(messageTimes.map((row) => row.created_at));
    if (rateLimitError) {
      throw new Error(rateLimitError);
    }

    const messageId = uuid();
    const createdAt = now();
    await db.prepare(
      `INSERT INTO chat_messages (id, game_id, player_id, username, text, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(messageId, gameId, player.id, player.username, text, createdAt);
    await db.prepare(`UPDATE games SET last_activity_at = ? WHERE id = ?`).run(createdAt, gameId);

    return { messageId };
  })();
}

export function cancelWaitingLobby(user: AuthUser, gameId: string): { cancelled: true };
export function cancelWaitingLobby(user: AuthUser, gameId: string): any {
  if (databaseProvider === "sqlite") {
    cleanupExpiredWaitingGames();

    const game = db
      .prepare(`SELECT id, status FROM games WHERE id = ?`)
      .get(gameId) as { id: string; status: "waiting" | "active" | "completed" } | undefined;
    if (!game) {
      throw new Error("Game not found.");
    }
    if (game.status !== "waiting") {
      throw new Error("Only waiting lobbies can be cancelled.");
    }

    getPlayerInGameFrom(db, gameId, user.id);
    db.prepare(`DELETE FROM games WHERE id = ?`).run(gameId);

    void broadcastGameSignal(gameId, "ended");

    return { cancelled: true as const };
  }

  return (async () => {
    await cleanupExpiredWaitingGames();

    const game = (await db
      .prepare(`SELECT id, status FROM games WHERE id = ?`)
      .get(gameId)) as { id: string; status: "waiting" | "active" | "completed" } | undefined;
    if (!game) {
      throw new Error("Game not found.");
    }
    if (game.status !== "waiting") {
      throw new Error("Only waiting lobbies can be cancelled.");
    }

    await getPlayerInGameFrom(db, gameId, user.id);
    await db.prepare(`DELETE FROM games WHERE id = ?`).run(gameId);

    void broadcastGameSignal(gameId, "ended");

    return { cancelled: true as const };
  })();
}

export function markGamePresenceOffline(user: AuthUser, gameId: string): { presence: "offline" };
export function markGamePresenceOffline(user: AuthUser, gameId: string): any {
  if (databaseProvider === "sqlite") {
    const { player } = getPlayerInGameFrom(db, gameId, user.id) as { player: GameStatePlayerRow };
    markPlayerOffline({
      playerId: player.id,
      gameId,
      userId: user.id,
    });

    void broadcastGameSignal(gameId, "updated");

    return { presence: "offline" as const };
  }

  return (async () => {
    const { player } = (await getPlayerInGameFrom(db, gameId, user.id)) as { player: GameStatePlayerRow };
    await markPlayerOffline({
      playerId: player.id,
      gameId,
      userId: user.id,
    });

    void broadcastGameSignal(gameId, "updated");

    return { presence: "offline" as const };
  })();
}
