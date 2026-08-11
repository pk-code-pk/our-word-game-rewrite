import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "module";
// Type-only import — erased at runtime, so the native addon is never loaded in Postgres/serverless mode
import type BetterSqlite3Constructor from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { SOCIAL_USERNAME_MAX_LENGTH, sanitizeSocialUsername } from "../shared/gameLogic.js";

export type MaybePromise<T> = T | Promise<T>;
type SqlRow = Record<string, unknown>;
type RunResult = {
  changes: number;
};
type LocalDatabase = InstanceType<typeof BetterSqlite3Constructor>;
type RemoteQueryResult<T extends SqlRow = SqlRow> = T[] & {
  count?: number;
  command?: string;
};
type RemoteClient = {
  unsafe: (query: string, args?: readonly unknown[], options?: { prepare?: boolean }) => Promise<RemoteQueryResult>;
  begin: <T>(callback: (sql: RemoteClient) => Promise<T>) => Promise<T>;
};

type StatementLike = {
  get: (...args: unknown[]) => MaybePromise<SqlRow | undefined>;
  all: (...args: unknown[]) => MaybePromise<SqlRow[]>;
  run: (...args: unknown[]) => MaybePromise<RunResult>;
};

type DatabaseLike = {
  prepare: (sql: string) => StatementLike;
  exec: (sql: string) => MaybePromise<void>;
};

const remoteDatabaseUrl = process.env.DATABASE_URL ?? "";
const usingRemoteDatabase = Boolean(remoteDatabaseUrl) && process.env.NODE_ENV !== "test";
const transactionStorage = new AsyncLocalStorage<DatabaseLike>();

const dataDir = path.resolve(process.cwd(), "data");
if (!usingRemoteDatabase) {
  fs.mkdirSync(dataDir, { recursive: true });
}

export const databaseFile = process.env.DATABASE_FILE ?? path.join(dataDir, "fourfive.db");
export const databaseProvider = usingRemoteDatabase ? "postgres" : "sqlite";

// Conditionally require better-sqlite3 only in SQLite mode.
// Using createRequire (not a static import) so the native addon is never loaded
// in serverless/Postgres environments where it would cause module initialization failures.
const _require = createRequire(import.meta.url);
let localDb: LocalDatabase | null = null;
if (!usingRemoteDatabase) {
  const Sqlite = _require("better-sqlite3") as { new(filename: string): LocalDatabase };
  localDb = new Sqlite(databaseFile);
  localDb.pragma("journal_mode = WAL");
  localDb.pragma("foreign_keys = ON");
}

let remoteDb: RemoteClient | null = null;
let remoteClientPromise: Promise<RemoteClient> | null = null;

function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
  return typeof value === "object" && value !== null && "then" in value;
}

function normalizeDbValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    return Number(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeDbValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => [key, normalizeDbValue(nestedValue)])
    );
  }

  return value;
}

async function getRemoteDb() {
  if (remoteDb) {
    return remoteDb;
  }

  if (!usingRemoteDatabase) {
    throw new Error("Remote database is not enabled.");
  }

  if (!remoteClientPromise) {
    remoteClientPromise = Promise.resolve().then(() => {
      const client = postgres(remoteDatabaseUrl, {
        // Polling (every 2s for social, every 5s for recent games) plus per-game
        // WebSocket fetches mean even ~20 concurrent users can exhaust a pool of
        // 3 in bursts, so size for headroom. NOTE: this must stay under the
        // connection ceiling of whichever Supabase connection string is in use —
        // the transaction pooler tolerates far more clients than a direct
        // connection does. Override with DATABASE_POOL_MAX if the deployment
        // uses a direct connection.
        max: Number(process.env.DATABASE_POOL_MAX ?? 15),
        idle_timeout: 30,
        connect_timeout: 10,
        types: {
          bigint: postgres.BigInt,
        },
      }) as unknown as RemoteClient;
      remoteDb = client;
      return client;
    });
  }

  return remoteClientPromise;
}

function splitStatements(sql: string) {
  return sql
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function translateQueryForPostgres(sql: string) {
  let index = 0;
  let result = "";
  let inStringLiteral = false;

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];

    if (inStringLiteral) {
      result += char;
      if (char === "'") {
        // A doubled single quote ('') is an escaped quote inside the literal,
        // not the end of the string — consume both and stay inside.
        if (sql[i + 1] === "'") {
          result += "'";
          i += 1;
        } else {
          inStringLiteral = false;
        }
      }
      continue;
    }

    if (char === "'") {
      inStringLiteral = true;
      result += char;
      continue;
    }

    if (char === "?") {
      index += 1;
      result += `$${index}`;
      continue;
    }

    result += char;
  }

  return result;
}

function normalizeRow<T extends SqlRow>(row: SqlRow | undefined): T | undefined {
  if (!row) {
    return undefined;
  }
  return normalizeDbValue(row) as T;
}

function normalizeRows<T extends SqlRow>(rows: SqlRow[]): T[] {
  return rows.map((row) => normalizeDbValue(row) as T);
}

function normalizeRunResult(result: { count?: number; rowsAffected?: number }): RunResult {
  return {
    changes: result.count ?? result.rowsAffected ?? 0,
  };
}

function createLocalStatement(sql: string): StatementLike {
  if (!localDb) {
    throw new Error("Local database is not available.");
  }

  const statement = localDb.prepare(sql);
  return {
    get: (...args: unknown[]) => statement.get(...args) as SqlRow | undefined,
    all: (...args: unknown[]) => statement.all(...args) as SqlRow[],
    run: (...args: unknown[]) => statement.run(...args) as RunResult,
  };
}

function createRemoteStatementFromSql(sqlClient: RemoteClient, sql: string): StatementLike {
  const translatedSql = translateQueryForPostgres(sql);

  async function runQuery(args: unknown[]) {
    return sqlClient.unsafe(translatedSql, args, { prepare: false });
  }

  return {
    get: async (...args: unknown[]) => {
      const result = await runQuery(args);
      return normalizeRow(result[0]);
    },
    all: async (...args: unknown[]) => {
      const result = await runQuery(args);
      return normalizeRows(result as SqlRow[]);
    },
    run: async (...args: unknown[]) => {
      const result = await runQuery(args);
      return normalizeRunResult(result);
    },
  };
}

function createRemoteStatement(sql: string): StatementLike {
  return {
    get: async (...args: unknown[]) => normalizeRow((await createRemoteStatementFromSql(await getRemoteDb(), sql).all(...args))[0]),
    all: (...args: unknown[]) => createRemoteStatementFromSqlPromise(sql).then((statement) => statement.all(...args)),
    run: (...args: unknown[]) => createRemoteStatementFromSqlPromise(sql).then((statement) => statement.run(...args)),
  };
}

async function createRemoteStatementFromSqlPromise(sql: string) {
  return createRemoteStatementFromSql(await getRemoteDb(), sql);
}

function createTransactionContextLocal(connection: LocalDatabase): DatabaseLike {
  return {
    prepare: (sql: string) => {
      const statement = connection.prepare(sql);
      return {
        get: (...args: unknown[]) => statement.get(...args) as SqlRow | undefined,
        all: (...args: unknown[]) => statement.all(...args) as SqlRow[],
        run: (...args: unknown[]) => statement.run(...args) as RunResult,
      };
    },
    exec: (sql: string) => {
      connection.exec(sql);
    },
  };
}

async function createTransactionContextRemote(transaction: RemoteClient): Promise<DatabaseLike> {
  return {
    prepare: (sql: string) => createRemoteStatementFromSql(transaction, sql),
    exec: async (sql: string) => {
      const statements = splitStatements(sql);
      if (statements.length === 0) {
        return;
      }
      await transaction.unsafe(statements[0], [], { prepare: false });
      for (const statement of statements.slice(1)) {
        await transaction.unsafe(statement, [], { prepare: false });
      }
    },
  };
}

function createRemoteExec(sql: string) {
  return getRemoteDb().then(async (client) => {
    const statements = splitStatements(sql);
    for (const statement of statements) {
      await client.unsafe(statement, [], { prepare: false });
    }
  });
}

export const db: DatabaseLike & {
  transaction: <TResult>(
    callback: (tx: DatabaseLike) => MaybePromise<TResult>
  ) => () => MaybePromise<TResult>;
} = {
  prepare(sql: string) {
    const activeTransaction = transactionStorage.getStore();
    if (activeTransaction) {
      return activeTransaction.prepare(sql);
    }

    return usingRemoteDatabase ? createRemoteStatement(sql) : createLocalStatement(sql);
  },
  exec(sql: string) {
    const activeTransaction = transactionStorage.getStore();
    if (activeTransaction) {
      return activeTransaction.exec(sql);
    }

    if (usingRemoteDatabase) {
      return createRemoteExec(sql).then(() => undefined);
    }

    localDb?.exec(sql);
    return;
  },
  transaction<TResult>(callback: (tx: DatabaseLike) => MaybePromise<TResult>) {
    return () => {
      if (usingRemoteDatabase) {
        return getRemoteDb().then((client) =>
          client.begin(async (transaction) => {
            const tx = await createTransactionContextRemote(transaction);
            return transactionStorage.run(tx, () => callback(tx));
          })
        );
      }

      if (!localDb) {
        throw new Error("Local database is not available.");
      }

      localDb.exec("BEGIN IMMEDIATE");
      const tx = createTransactionContextLocal(localDb);

      try {
        const result = transactionStorage.run(tx, () => callback(tx));
        if (isPromiseLike(result)) {
          return result.then(
            (value) => {
              localDb.exec("COMMIT");
              return value;
            },
            (error) => {
              localDb.exec("ROLLBACK");
              throw error;
            }
          );
        }

        localDb.exec("COMMIT");
        return result;
      } catch (error) {
        localDb.exec("ROLLBACK");
        throw error;
      }
    };
  },
};

function buildUsernameSeed(email: string | null, isAnonymous: boolean, userId: string) {
  const emailSeed = email?.split("@")[0] ?? "";
  const anonymousSeed = isAnonymous ? `guest-${userId.slice(0, 4)}` : "player";
  const normalized = sanitizeSocialUsername(emailSeed || anonymousSeed);
  return normalized.length >= 2 ? normalized : sanitizeSocialUsername(anonymousSeed) || "player";
}

function findAvailableUsername(
  preferredBase: string,
  options?: { excludeUserId?: string; reservedUsernames?: Set<string> }
) {
  const reserved = options?.reservedUsernames ?? new Set<string>();
  const base = sanitizeSocialUsername(preferredBase);
  const normalizedBase = base.length >= 2 ? base : "player";

  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
    const maxBaseLength = Math.max(2, SOCIAL_USERNAME_MAX_LENGTH - suffix.length);
    const trimmedBase = normalizedBase.slice(0, maxBaseLength);
    const candidate = attempt === 0 ? trimmedBase : `${trimmedBase}${suffix}`;
    const normalizedCandidate = candidate.toLowerCase();

    if (reserved.has(normalizedCandidate)) {
      continue;
    }

    const existing = localDb
      ? (options?.excludeUserId
          ? (localDb
              .prepare(
                `SELECT id FROM users
                 WHERE LOWER(username) = LOWER(?)
                   AND id != ?
                 LIMIT 1`
              )
              .get(candidate, options.excludeUserId) as { id: string } | undefined)
          : (localDb
              .prepare(
                `SELECT id FROM users
                 WHERE LOWER(username) = LOWER(?)
                 LIMIT 1`
              )
              .get(candidate) as { id: string } | undefined))
      : undefined;

    if (!existing) {
      return candidate;
    }
  }

  throw new Error("Unable to generate a unique username.");
}

async function findAvailableUsernameRemote(
  preferredBase: string,
  options?: { excludeUserId?: string; reservedUsernames?: Set<string> }
) {
  const reserved = options?.reservedUsernames ?? new Set<string>();
  const base = sanitizeSocialUsername(preferredBase);
  const normalizedBase = base.length >= 2 ? base : "player";

  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
    const maxBaseLength = Math.max(2, SOCIAL_USERNAME_MAX_LENGTH - suffix.length);
    const trimmedBase = normalizedBase.slice(0, maxBaseLength);
    const candidate = attempt === 0 ? trimmedBase : `${trimmedBase}${suffix}`;
    const normalizedCandidate = candidate.toLowerCase();

    if (reserved.has(normalizedCandidate)) {
      continue;
    }

    const existing = usingRemoteDatabase
      ? await getRemoteDb()
          .then((client) =>
            options?.excludeUserId
              ? client.unsafe(
                  translateQueryForPostgres(`SELECT id FROM users
                   WHERE LOWER(username) = LOWER(CAST(? AS TEXT))
                     AND id != CAST(? AS TEXT)
                   LIMIT 1`),
                  [candidate, options.excludeUserId],
                  { prepare: false }
                )
              : client.unsafe(
                  translateQueryForPostgres(`SELECT id FROM users
                   WHERE LOWER(username) = LOWER(CAST(? AS TEXT))
                   LIMIT 1`),
                  [candidate],
                  { prepare: false }
                )
          )
          .then((result) => normalizeRow<{ id: string }>(result[0]))
      : undefined;

    if (!existing) {
      return candidate;
    }
  }

  throw new Error("Unable to generate a unique username.");
}

function backfillUsernamesSync() {
  if (!localDb) {
    return;
  }

  // Bot accounts are excluded: their usernames are deliberately outside the
  // human-registerable character set, and findAvailableUsername would sanitize
  // them back into it — handing the reserved name back to the squatters this
  // is meant to protect against.
  const rows = localDb
    .prepare(`SELECT id, email, is_anonymous, username FROM users WHERE is_bot = 0 ORDER BY created_at ASC, id ASC`)
    .all() as Array<{
    id: string;
    email: string | null;
    is_anonymous: number;
    username: string | null;
  }>;

  const reserved = new Set<string>();
  const update = localDb.prepare(`UPDATE users SET username = ? WHERE id = ?`);

  for (const row of rows) {
    const seed = row.username?.trim() ? row.username : buildUsernameSeed(row.email, Boolean(row.is_anonymous), row.id);
    const username = findAvailableUsername(seed, {
      excludeUserId: row.id,
      reservedUsernames: reserved,
    });

    reserved.add(username.toLowerCase());

    if (row.username?.trim() !== username) {
      update.run(username, row.id);
    }
  }
}

async function backfillUsernamesRemote() {
  if (!remoteDb) {
    remoteDb = await getRemoteDb();
  }

  // Bot accounts excluded — see the matching filter in backfillUsernamesSync.
  // This must stay in sync with the SQLite path: when it was missing here, the
  // backfill sanitized "bot.easy" into "bot-easy", which IS registerable, so
  // the squat hole survived on Postgres while every SQLite test passed.
  const rows = (await remoteDb.unsafe(
    `SELECT id, email, is_anonymous, username FROM users WHERE is_bot = 0 ORDER BY created_at ASC, id ASC`,
    [],
    { prepare: false }
  )) as Array<{
    id: string;
    email: string | null;
    is_anonymous: number;
    username: string | null;
  }>;

  const reserved = new Set<string>();

  for (const row of rows) {
    const seed = row.username?.trim() ? row.username : buildUsernameSeed(row.email, Boolean(row.is_anonymous), row.id);
    const username = await findAvailableUsernameRemote(seed, {
      excludeUserId: row.id,
      reservedUsernames: reserved,
    });

    reserved.add(username.toLowerCase());

    if (row.username?.trim() !== username) {
      await remoteDb.unsafe(`UPDATE users SET username = $1 WHERE id = $2`, [username, row.id], { prepare: false });
    }
  }
}

// Bot accounts predate the users.is_bot column and the reserved-username
// scheme, so an already-deployed database has them as ordinary users holding
// human-registerable names. Mark them and move them onto the reserved names,
// which frees "rookie-bot" et al. for real players and makes the accounts
// unsquattable going forward. Keyed on the fixed ids from gameService, which
// are the only rows that were ever created this way.
const BOT_USER_MIGRATIONS: ReadonlyArray<{ id: string; username: string }> = [
  { id: "bot-easy", username: "bot.easy" },
  { id: "bot-medium", username: "bot.medium" },
  { id: "bot-hard", username: "bot.hard" },
];

function markExistingBotUsersLocal() {
  if (!localDb) {
    return;
  }
  const update = localDb.prepare(`UPDATE users SET is_bot = 1, username = ? WHERE id = ?`);
  for (const bot of BOT_USER_MIGRATIONS) {
    update.run(bot.username, bot.id);
  }
}

async function markExistingBotUsersRemote() {
  const client = remoteDb ?? (await getRemoteDb());
  for (const bot of BOT_USER_MIGRATIONS) {
    await client.unsafe(`UPDATE users SET is_bot = 1, username = $1 WHERE id = $2`, [bot.username, bot.id], {
      prepare: false,
    });
  }
}

function localExec(sql: string) {
  if (!localDb) {
    throw new Error("Local database is not available.");
  }

  localDb.exec(sql);
}

async function remoteExec(sql: string) {
  const client = await getRemoteDb();

  const statements = splitStatements(sql);
  for (const statement of statements) {
    await client.unsafe(statement, [], { prepare: false });
  }
}

async function migrateRemoteTimestampColumns() {
  await remoteExec(`
    ALTER TABLE users ALTER COLUMN created_at TYPE BIGINT USING created_at::bigint;
    ALTER TABLE sessions ALTER COLUMN created_at TYPE BIGINT USING created_at::bigint;
    ALTER TABLE sessions ALTER COLUMN expires_at TYPE BIGINT USING expires_at::bigint;
    ALTER TABLE games ALTER COLUMN created_at TYPE BIGINT USING created_at::bigint;
    ALTER TABLE games ALTER COLUMN last_activity_at TYPE BIGINT USING last_activity_at::bigint;
    ALTER TABLE games ALTER COLUMN completed_at TYPE BIGINT USING completed_at::bigint;
    ALTER TABLE players ALTER COLUMN created_at TYPE BIGINT USING created_at::bigint;
    ALTER TABLE guesses ALTER COLUMN created_at TYPE BIGINT USING created_at::bigint;
    ALTER TABLE chat_messages ALTER COLUMN created_at TYPE BIGINT USING created_at::bigint;
    ALTER TABLE player_presence ALTER COLUMN last_seen_at TYPE BIGINT USING last_seen_at::bigint;
    ALTER TABLE player_presence ALTER COLUMN created_at TYPE BIGINT USING created_at::bigint;
    ALTER TABLE player_presence ALTER COLUMN updated_at TYPE BIGINT USING updated_at::bigint;
    ALTER TABLE user_stats ALTER COLUMN updated_at TYPE BIGINT USING updated_at::bigint;
    ALTER TABLE friend_requests ALTER COLUMN created_at TYPE BIGINT USING created_at::bigint;
    ALTER TABLE friend_requests ALTER COLUMN responded_at TYPE BIGINT USING responded_at::bigint;
    ALTER TABLE friendships ALTER COLUMN created_at TYPE BIGINT USING created_at::bigint;
    ALTER TABLE game_invites ALTER COLUMN created_at TYPE BIGINT USING created_at::bigint;
    ALTER TABLE game_invites ALTER COLUMN responded_at TYPE BIGINT USING responded_at::bigint;
  `);
}

export async function keepDbAlive(): Promise<void> {
  if (!usingRemoteDatabase) return;
  try {
    const client = await getRemoteDb();
    await client.unsafe("SELECT 1");
  } catch {
    // ignore — next real query will reconnect
  }
}

let initPromise: Promise<void> | null = null;

export function initDb(): MaybePromise<void> {
  if (process.env.NODE_ENV === "production" && !usingRemoteDatabase) {
    throw new Error("DATABASE_URL is required in production.");
  }

  if (!usingRemoteDatabase) {
    localExec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE,
        username TEXT,
        password_hash TEXT,
        is_anonymous INTEGER NOT NULL DEFAULT 0,
        is_bot INTEGER NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        public INTEGER NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL,
        last_activity_at BIGINT NOT NULL,
        completed_at BIGINT,
        winner_player_id TEXT
      );

      CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        secret_word_hash TEXT NOT NULL,
        secret_word TEXT NOT NULL,
        alphabet_json TEXT NOT NULL,
        total_guesses INTEGER NOT NULL DEFAULT 0,
        is_bot INTEGER NOT NULL DEFAULT 0,
        bot_difficulty TEXT,
        bot_next_move_at BIGINT,
        created_at BIGINT NOT NULL,
        FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_players_game_id ON players(game_id);
      CREATE INDEX IF NOT EXISTS idx_players_user_id ON players(user_id);

      CREATE TABLE IF NOT EXISTS guesses (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL,
        player_id TEXT NOT NULL,
        type TEXT NOT NULL,
        text TEXT NOT NULL,
        match_count INTEGER NOT NULL,
        is_correct INTEGER NOT NULL,
        guess_number INTEGER NOT NULL,
        created_at BIGINT NOT NULL,
        FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
        FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_guesses_game_id ON guesses(game_id);
      CREATE INDEX IF NOT EXISTS idx_guesses_player_id ON guesses(player_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_guesses_player_guessnum ON guesses(player_id, guess_number);

      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL,
        player_id TEXT NOT NULL,
        username TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
        FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_chat_messages_game_created ON chat_messages(game_id, created_at);

      CREATE TABLE IF NOT EXISTS player_presence (
        player_id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        presence_state TEXT NOT NULL,
        last_seen_at BIGINT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE,
        FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_player_presence_game_id ON player_presence(game_id);
      CREATE INDEX IF NOT EXISTS idx_player_presence_user_id ON player_presence(user_id);
      CREATE INDEX IF NOT EXISTS idx_player_presence_last_seen_at ON player_presence(last_seen_at);

      CREATE TABLE IF NOT EXISTS user_stats (
        user_id TEXT PRIMARY KEY,
        wins INTEGER NOT NULL,
        losses INTEGER NOT NULL,
        total_guesses INTEGER NOT NULL,
        total_win_guesses INTEGER NOT NULL DEFAULT 0,
        games_played INTEGER NOT NULL,
        most_recent_username TEXT NOT NULL,
        current_win_streak INTEGER NOT NULL DEFAULT 0,
        recent_results_json TEXT NOT NULL DEFAULT '[]',
        best_win_guesses INTEGER,
        updated_at BIGINT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS friend_requests (
        id TEXT PRIMARY KEY,
        sender_user_id TEXT NOT NULL,
        receiver_user_id TEXT NOT NULL,
        pair_low_user_id TEXT NOT NULL,
        pair_high_user_id TEXT NOT NULL,
        status TEXT NOT NULL,
        acted_by_user_id TEXT,
        created_at BIGINT NOT NULL,
        responded_at BIGINT,
        FOREIGN KEY (sender_user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (receiver_user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (acted_by_user_id) REFERENCES users(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_friend_requests_sender ON friend_requests(sender_user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_friend_requests_receiver ON friend_requests(receiver_user_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_friend_requests_pending_pair
        ON friend_requests(pair_low_user_id, pair_high_user_id)
        WHERE status = 'pending';

      CREATE TABLE IF NOT EXISTS friendships (
        id TEXT PRIMARY KEY,
        user_one_id TEXT NOT NULL,
        user_two_id TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        request_id TEXT,
        FOREIGN KEY (user_one_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (user_two_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (request_id) REFERENCES friend_requests(id) ON DELETE SET NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_friendships_pair ON friendships(user_one_id, user_two_id);
      CREATE INDEX IF NOT EXISTS idx_friendships_user_one ON friendships(user_one_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_friendships_user_two ON friendships(user_two_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS game_invites (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL,
        sender_user_id TEXT NOT NULL,
        receiver_user_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        responded_at BIGINT,
        FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
        FOREIGN KEY (sender_user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (receiver_user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_game_invites_sender ON game_invites(sender_user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_game_invites_receiver ON game_invites(receiver_user_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_game_invites_pending_target
        ON game_invites(game_id, receiver_user_id)
        WHERE status = 'pending';

      CREATE TABLE IF NOT EXISTS rate_limit_hits (
        bucket TEXT NOT NULL,
        identifier TEXT NOT NULL,
        hit_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rate_limit_hits ON rate_limit_hits(bucket, identifier, hit_at);
    `);

    if (!localDb) {
      return;
    }

    ensureColumnLocal("users", "username", "username TEXT");
    ensureColumnLocal("users", "is_bot", "is_bot INTEGER NOT NULL DEFAULT 0");
    markExistingBotUsersLocal();
    backfillUsernamesSync();
    localDb.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(LOWER(username))`);
    ensureColumnLocal("user_stats", "total_win_guesses", "total_win_guesses INTEGER NOT NULL DEFAULT 0");
    ensureColumnLocal("players", "is_bot", "is_bot INTEGER NOT NULL DEFAULT 0");
    ensureColumnLocal("players", "bot_difficulty", "bot_difficulty TEXT");
    ensureColumnLocal("players", "bot_next_move_at", "bot_next_move_at BIGINT");
    localDb.exec(`CREATE INDEX IF NOT EXISTS idx_players_bot_next_move_at ON players(bot_next_move_at)`);
    return;
  }

  if (!initPromise) {
    const promise = (async () => {
      remoteDb = await getRemoteDb();

      await remoteExec(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          email TEXT UNIQUE,
          username TEXT,
          password_hash TEXT,
          is_anonymous INTEGER NOT NULL DEFAULT 0,
          is_bot INTEGER NOT NULL DEFAULT 0,
          created_at BIGINT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          created_at BIGINT NOT NULL,
          expires_at BIGINT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

        CREATE TABLE IF NOT EXISTS games (
          id TEXT PRIMARY KEY,
          code TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL,
          public INTEGER NOT NULL DEFAULT 0,
          created_at BIGINT NOT NULL,
          last_activity_at BIGINT NOT NULL,
          completed_at BIGINT,
          winner_player_id TEXT
        );

        CREATE TABLE IF NOT EXISTS players (
          id TEXT PRIMARY KEY,
          game_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          username TEXT NOT NULL,
          secret_word_hash TEXT NOT NULL,
          secret_word TEXT NOT NULL,
          alphabet_json TEXT NOT NULL,
          total_guesses INTEGER NOT NULL DEFAULT 0,
          is_bot INTEGER NOT NULL DEFAULT 0,
          bot_difficulty TEXT,
          bot_next_move_at BIGINT,
          created_at BIGINT NOT NULL,
          FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_players_game_id ON players(game_id);
        CREATE INDEX IF NOT EXISTS idx_players_user_id ON players(user_id);

        CREATE TABLE IF NOT EXISTS guesses (
          id TEXT PRIMARY KEY,
          game_id TEXT NOT NULL,
          player_id TEXT NOT NULL,
          type TEXT NOT NULL,
          text TEXT NOT NULL,
          match_count INTEGER NOT NULL,
          is_correct INTEGER NOT NULL,
          guess_number INTEGER NOT NULL,
          created_at BIGINT NOT NULL,
          FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
          FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_guesses_game_id ON guesses(game_id);
        CREATE INDEX IF NOT EXISTS idx_guesses_player_id ON guesses(player_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_guesses_player_guessnum ON guesses(player_id, guess_number);

        CREATE TABLE IF NOT EXISTS chat_messages (
          id TEXT PRIMARY KEY,
          game_id TEXT NOT NULL,
          player_id TEXT NOT NULL,
          username TEXT NOT NULL,
          text TEXT NOT NULL,
          created_at BIGINT NOT NULL,
          FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
          FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_chat_messages_game_created ON chat_messages(game_id, created_at);

        CREATE TABLE IF NOT EXISTS player_presence (
          player_id TEXT PRIMARY KEY,
          game_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          presence_state TEXT NOT NULL,
          last_seen_at BIGINT NOT NULL,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL,
          FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE,
          FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_player_presence_game_id ON player_presence(game_id);
        CREATE INDEX IF NOT EXISTS idx_player_presence_user_id ON player_presence(user_id);
        CREATE INDEX IF NOT EXISTS idx_player_presence_last_seen_at ON player_presence(last_seen_at);

        CREATE TABLE IF NOT EXISTS user_stats (
          user_id TEXT PRIMARY KEY,
          wins INTEGER NOT NULL,
          losses INTEGER NOT NULL,
          total_guesses INTEGER NOT NULL,
          total_win_guesses INTEGER NOT NULL DEFAULT 0,
          games_played INTEGER NOT NULL,
          most_recent_username TEXT NOT NULL,
          current_win_streak INTEGER NOT NULL DEFAULT 0,
          recent_results_json TEXT NOT NULL DEFAULT '[]',
          best_win_guesses INTEGER,
          updated_at BIGINT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS friend_requests (
          id TEXT PRIMARY KEY,
          sender_user_id TEXT NOT NULL,
          receiver_user_id TEXT NOT NULL,
          pair_low_user_id TEXT NOT NULL,
          pair_high_user_id TEXT NOT NULL,
          status TEXT NOT NULL,
          acted_by_user_id TEXT,
          created_at BIGINT NOT NULL,
          responded_at BIGINT,
          FOREIGN KEY (sender_user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (receiver_user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (acted_by_user_id) REFERENCES users(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_friend_requests_sender ON friend_requests(sender_user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_friend_requests_receiver ON friend_requests(receiver_user_id, created_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_friend_requests_pending_pair
          ON friend_requests(pair_low_user_id, pair_high_user_id)
          WHERE status = 'pending';

        CREATE TABLE IF NOT EXISTS friendships (
          id TEXT PRIMARY KEY,
          user_one_id TEXT NOT NULL,
          user_two_id TEXT NOT NULL,
          created_at BIGINT NOT NULL,
          request_id TEXT,
          FOREIGN KEY (user_one_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (user_two_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (request_id) REFERENCES friend_requests(id) ON DELETE SET NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_friendships_pair ON friendships(user_one_id, user_two_id);
        CREATE INDEX IF NOT EXISTS idx_friendships_user_one ON friendships(user_one_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_friendships_user_two ON friendships(user_two_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS game_invites (
          id TEXT PRIMARY KEY,
          game_id TEXT NOT NULL,
          sender_user_id TEXT NOT NULL,
          receiver_user_id TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at BIGINT NOT NULL,
          responded_at BIGINT,
          FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
          FOREIGN KEY (sender_user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (receiver_user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_game_invites_sender ON game_invites(sender_user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_game_invites_receiver ON game_invites(receiver_user_id, created_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_game_invites_pending_target
          ON game_invites(game_id, receiver_user_id)
          WHERE status = 'pending';

        CREATE TABLE IF NOT EXISTS rate_limit_hits (
          bucket TEXT NOT NULL,
          identifier TEXT NOT NULL,
          hit_at BIGINT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_rate_limit_hits ON rate_limit_hits(bucket, identifier, hit_at);
      `);

      await ensureColumnRemote("users", "username", "username TEXT");
      // Migration is idempotent; ignore errors from concurrent Lambda cold-starts
      // running the same ALTER TABLE simultaneously.
      await migrateRemoteTimestampColumns().catch(() => undefined);
      await ensureColumnRemote("users", "is_bot", "is_bot INTEGER NOT NULL DEFAULT 0");
      await markExistingBotUsersRemote();
      await backfillUsernamesRemote();
      await remoteDb.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(LOWER(username))`, [], {
        prepare: false,
      });
      await ensureColumnRemote("user_stats", "total_win_guesses", "total_win_guesses INTEGER NOT NULL DEFAULT 0");
      await ensureColumnRemote("players", "is_bot", "is_bot INTEGER NOT NULL DEFAULT 0");
      await ensureColumnRemote("players", "bot_difficulty", "bot_difficulty TEXT");
      await ensureColumnRemote("players", "bot_next_move_at", "bot_next_move_at BIGINT");
      await remoteDb.unsafe(`CREATE INDEX IF NOT EXISTS idx_players_bot_next_move_at ON players(bot_next_move_at)`, [], {
        prepare: false,
      });
    })();

    initPromise = promise;
    // Reset on failure so the next request can retry rather than permanently failing
    promise.catch(() => {
      if (initPromise === promise) {
        initPromise = null;
      }
    });
  }

  return initPromise;
}

function ensureColumnLocal(tableName: string, columnName: string, definition: string) {
  if (!localDb) {
    throw new Error("Local database is not available.");
  }

  const rows = localDb.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  const exists = rows.some((row) => row.name === columnName);
  if (!exists) {
    localDb.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
  }
}

async function ensureColumnRemote(tableName: string, columnName: string, definition: string) {
  const client = remoteDb ?? (await getRemoteDb());
  await client.unsafe(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS ${definition}`, [], {
    prepare: false,
  });
}

export function allocateUniqueUsername(
  preferredBase: string,
  options?: { excludeUserId?: string; reservedUsernames?: Set<string> }
) {
  if (usingRemoteDatabase) {
    throw new Error("allocateUniqueUsername should not be used directly in remote mode.");
  }
  return findAvailableUsername(preferredBase, options);
}

export async function allocateUniqueUsernameRemote(
  preferredBase: string,
  options?: { excludeUserId?: string; reservedUsernames?: Set<string> }
) {
  if (!usingRemoteDatabase) {
    return findAvailableUsername(preferredBase, options);
  }
  return findAvailableUsernameRemote(preferredBase, options);
}
