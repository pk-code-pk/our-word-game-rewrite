import type { Request } from "express";
import { db } from "./db.js";

export type AuthThrottleAction = "signup" | "signin" | "anonymous";

export interface AuthThrottleRule {
  limit: number;
  windowMs: number;
  blockMs: number;
  label: string;
}

export interface AuthThrottleDecision {
  allowed: boolean;
  action: AuthThrottleAction;
  ip: string;
  limit: number;
  remaining: number;
  attempts: number;
  resetAt: number;
  retryAfterMs: number;
  retryAfterSeconds: number;
  message: string;
}

export interface AuthThrottleOptions {
  now?: () => number;
  overrides?: Partial<Record<AuthThrottleAction, Partial<AuthThrottleRule>>>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_ROW_TTL_MS = 30 * DAY_MS;

const DEFAULT_RULES: Record<AuthThrottleAction, AuthThrottleRule> = {
  signup: {
    limit: 5,
    windowMs: 15 * 60 * 1000,
    blockMs: 30 * 60 * 1000,
    label: "sign up",
  },
  signin: {
    limit: 10,
    windowMs: 15 * 60 * 1000,
    blockMs: 15 * 60 * 1000,
    label: "sign in",
  },
  anonymous: {
    limit: 6,
    windowMs: 15 * 60 * 1000,
    blockMs: 15 * 60 * 1000,
    label: "continue anonymously",
  },
};

function ensureAuthThrottleTable() {
  return db.exec(`
    CREATE TABLE IF NOT EXISTS auth_route_throttle (
      action TEXT NOT NULL,
      ip TEXT NOT NULL,
      window_started_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL,
      blocked_until INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (action, ip)
    );

    CREATE INDEX IF NOT EXISTS idx_auth_route_throttle_updated_at
      ON auth_route_throttle(updated_at);
  `);
}

let authThrottleTableInitPromise: Promise<void> | null = null;

async function ensureAuthThrottleTableAsync() {
  if (!authThrottleTableInitPromise) {
    authThrottleTableInitPromise = Promise.resolve(ensureAuthThrottleTable());
  }

  await authThrottleTableInitPromise;
}

function nowFrom(options: AuthThrottleOptions) {
  return options.now?.() ?? Date.now();
}

function resolveClientIp(req: Request) {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }
  if (Array.isArray(forwardedFor) && forwardedFor.length > 0) {
    return forwardedFor[0].split(",")[0].trim();
  }
  if (typeof req.ip === "string" && req.ip.trim()) {
    return req.ip.trim();
  }
  const remoteAddress = req.socket?.remoteAddress;
  if (typeof remoteAddress === "string" && remoteAddress.trim()) {
    return remoteAddress.trim();
  }
  return "unknown";
}

function getRule(action: AuthThrottleAction, overrides?: AuthThrottleOptions["overrides"]) {
  return {
    ...DEFAULT_RULES[action],
    ...(overrides?.[action] ?? {}),
  };
}

function formatDuration(ms: number) {
  const totalSeconds = Math.max(1, Math.ceil(ms / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds} second${totalSeconds === 1 ? "" : "s"}`;
  }

  const totalMinutes = Math.ceil(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes} minute${totalMinutes === 1 ? "" : "s"}`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0) {
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }

  return `${hours} hour${hours === 1 ? "" : "s"} ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function buildMessage(rule: AuthThrottleRule, retryAfterMs: number) {
  return `Too many ${rule.label} attempts from this IP. Try again in ${formatDuration(retryAfterMs)}.`;
}

function computeWindowStart(now: number, windowMs: number) {
  return Math.floor(now / windowMs) * windowMs;
}

function cleanupStaleThrottleRows(now: number) {
  db.prepare(`DELETE FROM auth_route_throttle WHERE updated_at < ?`).run(now - STALE_ROW_TTL_MS);
}

async function cleanupStaleThrottleRowsAsync(now: number) {
  await db.prepare(`DELETE FROM auth_route_throttle WHERE updated_at < ?`).run(now - STALE_ROW_TTL_MS);
}

export function resetAuthThrottleState() {
  ensureAuthThrottleTable();
  db.prepare(`DELETE FROM auth_route_throttle`).run();
}

export async function resetAuthThrottleStateAsync() {
  await ensureAuthThrottleTableAsync();
  await db.prepare(`DELETE FROM auth_route_throttle`).run();
}

export function checkAuthRouteThrottle(
  req: Request,
  action: AuthThrottleAction,
  options: AuthThrottleOptions = {}
): AuthThrottleDecision {
  ensureAuthThrottleTable();

  const now = nowFrom(options);
  cleanupStaleThrottleRows(now);

  const rule = getRule(action, options.overrides);
  const ip = resolveClientIp(req);
  const windowStartedAt = computeWindowStart(now, rule.windowMs);
  const windowEndsAt = windowStartedAt + rule.windowMs;

  const evaluate = db.transaction(() => {
    const row = db
      .prepare(
        `SELECT window_started_at, attempts, blocked_until
         FROM auth_route_throttle
         WHERE action = ? AND ip = ?`
      )
      .get(action, ip) as
      | {
          window_started_at: number;
          attempts: number;
          blocked_until: number;
        }
      | undefined;

    if (row?.blocked_until && row.blocked_until > now) {
      const retryAfterMs = row.blocked_until - now;
      return {
        allowed: false,
        action,
        ip,
        limit: rule.limit,
        remaining: 0,
        attempts: row.attempts,
        resetAt: row.blocked_until,
        retryAfterMs,
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
        message: buildMessage(rule, retryAfterMs),
      } satisfies AuthThrottleDecision;
    }

    const isNewWindow = !row || row.window_started_at !== windowStartedAt;
    const attempts = isNewWindow ? 0 : row.attempts;
    const blockedUntil = isNewWindow ? 0 : row?.blocked_until ?? 0;

    if (attempts >= rule.limit) {
      const retryAfterMs = Math.max(rule.blockMs, windowEndsAt - now);
      const newBlockedUntil = now + retryAfterMs;
      db.prepare(
        `INSERT INTO auth_route_throttle (action, ip, window_started_at, attempts, blocked_until, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(action, ip) DO UPDATE SET
           window_started_at = excluded.window_started_at,
           attempts = excluded.attempts,
           blocked_until = excluded.blocked_until,
           updated_at = excluded.updated_at`
      ).run(action, ip, windowStartedAt, attempts, newBlockedUntil, now);

      return {
        allowed: false,
        action,
        ip,
        limit: rule.limit,
        remaining: 0,
        attempts,
        resetAt: newBlockedUntil,
        retryAfterMs: retryAfterMs,
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
        message: buildMessage(rule, retryAfterMs),
      } satisfies AuthThrottleDecision;
    }

    const nextAttempts = attempts + 1;
    db.prepare(
      `INSERT INTO auth_route_throttle (action, ip, window_started_at, attempts, blocked_until, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(action, ip) DO UPDATE SET
         window_started_at = excluded.window_started_at,
         attempts = excluded.attempts,
         blocked_until = excluded.blocked_until,
         updated_at = excluded.updated_at`
    ).run(action, ip, windowStartedAt, nextAttempts, blockedUntil, now);

    return {
      allowed: true,
      action,
      ip,
      limit: rule.limit,
      remaining: Math.max(0, rule.limit - nextAttempts),
      attempts: nextAttempts,
      resetAt: windowEndsAt,
      retryAfterMs: 0,
      retryAfterSeconds: 0,
      message: "",
    } satisfies AuthThrottleDecision;
  });

  const decision = evaluate();
  if (decision instanceof Promise) {
    throw new Error("checkAuthRouteThrottle cannot run synchronously against a remote database.");
  }

  return decision;
}

export async function checkAuthRouteThrottleAsync(
  req: Request,
  action: AuthThrottleAction,
  options: AuthThrottleOptions = {}
): Promise<AuthThrottleDecision> {
  await ensureAuthThrottleTableAsync();

  const now = nowFrom(options);
  await cleanupStaleThrottleRowsAsync(now);

  const rule = getRule(action, options.overrides);
  const ip = resolveClientIp(req);
  const windowStartedAt = computeWindowStart(now, rule.windowMs);
  const windowEndsAt = windowStartedAt + rule.windowMs;

  const evaluate = db.transaction(async () => {
    const row = (await db
      .prepare(
        `SELECT window_started_at, attempts, blocked_until
         FROM auth_route_throttle
         WHERE action = ? AND ip = ?`
      )
      .get(action, ip)) as
      | {
          window_started_at: number;
          attempts: number;
          blocked_until: number;
        }
      | undefined;

    if (row?.blocked_until && row.blocked_until > now) {
      const retryAfterMs = row.blocked_until - now;
      return {
        allowed: false,
        action,
        ip,
        limit: rule.limit,
        remaining: 0,
        attempts: row.attempts,
        resetAt: row.blocked_until,
        retryAfterMs,
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
        message: buildMessage(rule, retryAfterMs),
      } satisfies AuthThrottleDecision;
    }

    const isNewWindow = !row || row.window_started_at !== windowStartedAt;
    const attempts = isNewWindow ? 0 : row.attempts;
    const blockedUntil = isNewWindow ? 0 : row?.blocked_until ?? 0;

    if (attempts >= rule.limit) {
      const retryAfterMs = Math.max(rule.blockMs, windowEndsAt - now);
      const newBlockedUntil = now + retryAfterMs;
      await db
        .prepare(
          `INSERT INTO auth_route_throttle (action, ip, window_started_at, attempts, blocked_until, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(action, ip) DO UPDATE SET
             window_started_at = excluded.window_started_at,
             attempts = excluded.attempts,
             blocked_until = excluded.blocked_until,
             updated_at = excluded.updated_at`
        )
        .run(action, ip, windowStartedAt, attempts, newBlockedUntil, now);

      return {
        allowed: false,
        action,
        ip,
        limit: rule.limit,
        remaining: 0,
        attempts,
        resetAt: newBlockedUntil,
        retryAfterMs,
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
        message: buildMessage(rule, retryAfterMs),
      } satisfies AuthThrottleDecision;
    }

    const nextAttempts = attempts + 1;
    await db
      .prepare(
        `INSERT INTO auth_route_throttle (action, ip, window_started_at, attempts, blocked_until, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(action, ip) DO UPDATE SET
           window_started_at = excluded.window_started_at,
           attempts = excluded.attempts,
           blocked_until = excluded.blocked_until,
           updated_at = excluded.updated_at`
      )
      .run(action, ip, windowStartedAt, nextAttempts, blockedUntil, now);

    return {
      allowed: true,
      action,
      ip,
      limit: rule.limit,
      remaining: Math.max(0, rule.limit - nextAttempts),
      attempts: nextAttempts,
      resetAt: windowEndsAt,
      retryAfterMs: 0,
      retryAfterSeconds: 0,
      message: "",
    } satisfies AuthThrottleDecision;
  });

  return evaluate();
}
