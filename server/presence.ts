import { databaseProvider, db } from "./db.js";
import type { PresenceState } from "../shared/types.js";

export const PLAYER_PRESENCE_OFFLINE_TTL_MS = 45 * 1000;

type PlayerPresenceRow = {
  player_id: string;
  game_id: string;
  user_id: string;
  presence_state: PresenceState;
  last_seen_at: number;
  created_at: number;
  updated_at: number;
};

type MaybePromise<T> = T | Promise<T>;
type DbRunner = Pick<typeof db, "prepare" | "exec">;

function now() {
  return Date.now();
}

function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
  return typeof value === "object" && value !== null && "then" in value;
}

function runPresenceUpsert(runner: DbRunner, params: { playerId: string; gameId: string; userId: string; state: PresenceState; at: number }) {
  return runner.prepare(
    `INSERT INTO player_presence (
      player_id, game_id, user_id, presence_state, last_seen_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(player_id) DO UPDATE SET
      game_id = excluded.game_id,
      user_id = excluded.user_id,
      presence_state = excluded.presence_state,
      last_seen_at = excluded.last_seen_at,
      updated_at = excluded.updated_at`
  ).run(params.playerId, params.gameId, params.userId, params.state, params.at, params.at, params.at);
}

export function ensurePresenceStore(): MaybePromise<void> {
  return db.exec(`
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
  `);
}

function normalizePresenceState(state: PresenceState, lastSeenAt: number, nowMs: number): PresenceState {
  if (state === "offline") {
    return "offline";
  }

  return nowMs - lastSeenAt > PLAYER_PRESENCE_OFFLINE_TTL_MS ? "offline" : "online";
}

export function upsertPlayerPresence(params: {
  playerId: string;
  gameId: string;
  userId: string;
  state?: PresenceState;
  at?: number;
}, runner: DbRunner = db): MaybePromise<void> {
  const at = params.at ?? now();
  const state = params.state ?? "online";

  if (runner !== db) {
    const result = runPresenceUpsert(runner, {
      playerId: params.playerId,
      gameId: params.gameId,
      userId: params.userId,
      state,
      at,
    });
    return isPromiseLike(result) ? result.then(() => undefined) : undefined;
  }

  if (databaseProvider === "sqlite") {
    runPresenceUpsert(runner, {
      playerId: params.playerId,
      gameId: params.gameId,
      userId: params.userId,
      state,
      at,
    });
    return;
  }

  return Promise.resolve(ensurePresenceStore()).then(() =>
    Promise.resolve(
      runPresenceUpsert(runner, {
        playerId: params.playerId,
        gameId: params.gameId,
        userId: params.userId,
        state,
        at,
      })
    ).then(() => undefined)
  );
}

export function getGamePresence(gameId: string, nowMs = now(), runner: DbRunner = db): MaybePromise<Map<string, PresenceState>> {
  const buildPresence = (rows: PlayerPresenceRow[]) => {
    const presenceByPlayerId = new Map<string, PresenceState>();
    for (const row of rows) {
      presenceByPlayerId.set(row.player_id, normalizePresenceState(row.presence_state, row.last_seen_at, nowMs));
    }
    return presenceByPlayerId;
  };

  const selectRows = () =>
    runner
      .prepare(
        `SELECT player_id, game_id, user_id, presence_state, last_seen_at, created_at, updated_at
         FROM player_presence
         WHERE game_id = ?`
      )
      .all(gameId) as MaybePromise<PlayerPresenceRow[]>;

  if (runner !== db || databaseProvider === "sqlite") {
    const rows = selectRows();
    return isPromiseLike(rows) ? rows.then(buildPresence) : buildPresence(rows);
  }

  return Promise.resolve(ensurePresenceStore()).then(() => {
    const rows = selectRows();
    return isPromiseLike(rows) ? rows.then(buildPresence) : buildPresence(rows);
  });
}

export function touchPlayerPresence(
  params: { playerId: string; gameId: string; userId: string; at?: number },
  runner: DbRunner = db
): MaybePromise<void> {
  return upsertPlayerPresence({
    playerId: params.playerId,
    gameId: params.gameId,
    userId: params.userId,
    state: "online",
    at: params.at,
  }, runner);
}

export function markPlayerOffline(
  params: { playerId: string; gameId: string; userId: string; at?: number },
  runner: DbRunner = db
): MaybePromise<void> {
  return upsertPlayerPresence({
    playerId: params.playerId,
    gameId: params.gameId,
    userId: params.userId,
    state: "offline",
    at: params.at ?? now(),
  }, runner);
}
