import { AsyncLocalStorage } from "node:async_hooks";
import BetterSqlite3 from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { SOCIAL_USERNAME_MAX_LENGTH, sanitizeSocialUsername } from "../shared/gameLogic.js";

export type MaybePromise<T> = T | Promise<T>;
type SqlRow = Record<string, unknown>;
type RunResult = {
  changes: number;
};
type LocalDatabase = InstanceType<typeof BetterSqlite3>;
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

const localDb = usingRemoteDatabase ? null : new BetterSqlite3(databaseFile);
if (localDb) {
  localDb.pragma("journal_mode = WAL");
  localDb.pragma("foreign_keys = ON");
}

let remoteDb: RemoteClient | null = null;
let remoteClientPromise: Promise<RemoteClient> | null = null;

function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
  return typeof value === "object" && value !== null && "then" in value;
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
        max: 1,
        idle_timeout: 20,
        connect_timeout: 10,
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
  return sql.replace(/\?/g, () => `$${++index}`);
}

function normalizeRow<T extends SqlRow>(row: SqlRow | undefined): T | undefined {
  if (!row) {
    return undefined;
  }
  return row as T;
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
    return sqlClient.unsafe(translatedSql, args, { prepare: true });
  }

  return {
    get: async (...args: unknown[]) => {
      const result = await runQuery(args);
      return normalizeRow(result[0]);
    },
    all: async (...args: unknown[]) => {
      const result = await runQuery(args);
      return result as SqlRow[];
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
  const anonymousSeed = isAnonymous ? `anon-${userId.slice(0, 8)}` : "player";
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
      ? (localDb
          .prepare(
            `SELECT id FROM users
             WHERE LOWER(username) = LOWER(?)
               AND (? IS NULL OR id != ?)
             LIMIT 1`
          )
          .get(candidate, options?.excludeUserId ?? null, options?.excludeUserId ?? null) as
          | { id: string }
          | undefined)
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
            client.unsafe(
              translateQueryForPostgres(`SELECT id FROM users
               WHERE LOWER(username) = LOWER(?)
                 AND (? IS NULL OR id != ?)
               LIMIT 1`),
              [candidate, options?.excludeUserId ?? null, options?.excludeUserId ?? null],
              { prepare: true }
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

  const rows = localDb
    .prepare(`SELECT id, email, is_anonymous, username FROM users ORDER BY created_at ASC, id ASC`)
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

  const rows = (await remoteDb.unsafe(
    `SELECT id, email, is_anonymous, username FROM users ORDER BY created_at ASC, id ASC`,
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
      await remoteDb.unsafe(`UPDATE users SET username = ? WHERE id = ?`, [username, row.id], { prepare: true });
    }
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
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        public INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        completed_at INTEGER,
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
        created_at INTEGER NOT NULL,
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
        created_at INTEGER NOT NULL,
        FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
        FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_guesses_game_id ON guesses(game_id);
      CREATE INDEX IF NOT EXISTS idx_guesses_player_id ON guesses(player_id);

      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL,
        player_id TEXT NOT NULL,
        username TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
        FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_chat_messages_game_created ON chat_messages(game_id, created_at);

      CREATE TABLE IF NOT EXISTS player_presence (
        player_id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        presence_state TEXT NOT NULL,
        last_seen_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
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
        updated_at INTEGER NOT NULL,
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
        created_at INTEGER NOT NULL,
        responded_at INTEGER,
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
        created_at INTEGER NOT NULL,
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
        created_at INTEGER NOT NULL,
        responded_at INTEGER,
        FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
        FOREIGN KEY (sender_user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (receiver_user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_game_invites_sender ON game_invites(sender_user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_game_invites_receiver ON game_invites(receiver_user_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_game_invites_pending_target
        ON game_invites(game_id, receiver_user_id)
        WHERE status = 'pending';
    `);

    if (!localDb) {
      return;
    }

    ensureColumnLocal("users", "username", "username TEXT");
    backfillUsernamesSync();
    localDb.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(LOWER(username))`);
    ensureColumnLocal("user_stats", "total_win_guesses", "total_win_guesses INTEGER NOT NULL DEFAULT 0");
    return;
  }

  if (!initPromise) {
    initPromise = (async () => {
      remoteDb = await getRemoteDb();

      await remoteExec(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          email TEXT UNIQUE,
          username TEXT,
          password_hash TEXT,
          is_anonymous INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

        CREATE TABLE IF NOT EXISTS games (
          id TEXT PRIMARY KEY,
          code TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL,
          public INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          last_activity_at INTEGER NOT NULL,
          completed_at INTEGER,
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
          created_at INTEGER NOT NULL,
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
          created_at INTEGER NOT NULL,
          FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
          FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_guesses_game_id ON guesses(game_id);
        CREATE INDEX IF NOT EXISTS idx_guesses_player_id ON guesses(player_id);

        CREATE TABLE IF NOT EXISTS chat_messages (
          id TEXT PRIMARY KEY,
          game_id TEXT NOT NULL,
          player_id TEXT NOT NULL,
          username TEXT NOT NULL,
          text TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
          FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_chat_messages_game_created ON chat_messages(game_id, created_at);

        CREATE TABLE IF NOT EXISTS player_presence (
          player_id TEXT PRIMARY KEY,
          game_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          presence_state TEXT NOT NULL,
          last_seen_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
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
          updated_at INTEGER NOT NULL,
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
          created_at INTEGER NOT NULL,
          responded_at INTEGER,
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
          created_at INTEGER NOT NULL,
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
          created_at INTEGER NOT NULL,
          responded_at INTEGER,
          FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
          FOREIGN KEY (sender_user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (receiver_user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_game_invites_sender ON game_invites(sender_user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_game_invites_receiver ON game_invites(receiver_user_id, created_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_game_invites_pending_target
          ON game_invites(game_id, receiver_user_id)
          WHERE status = 'pending';
      `);

      await ensureColumnRemote("users", "username", "username TEXT");
      await backfillUsernamesRemote();
      await remoteDb.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(LOWER(username))`, [], {
        prepare: false,
      });
      await ensureColumnRemote("user_stats", "total_win_guesses", "total_win_guesses INTEGER NOT NULL DEFAULT 0");
    })();
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
