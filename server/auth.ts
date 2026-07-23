import type { Request, Response } from "express";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { v4 as uuid } from "uuid";
import { allocateUniqueUsernameRemote, db } from "./db.js";
import type { AuthUser } from "./types.js";
import { isValidSocialUsername, sanitizeSocialUsername } from "../shared/gameLogic.js";

const SESSION_COOKIE = "fourfive_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 72;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Precomputed once at module load. When a sign-in targets a missing user (or one
// with no password_hash) we still run a bcrypt comparison against this constant so
// the response time is indistinguishable from a real user with a wrong password,
// closing the username-enumeration timing side channel.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync("timing-safe-dummy-password", 10);

type CreateSessionOptions = {
  replaceExistingSessionId?: string | null;
};
type MaybePromise<T> = T | Promise<T>;

function now() {
  return Date.now();
}

function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
  return typeof value === "object" && value !== null && "then" in value;
}

function flatMapMaybePromise<T, TResult>(
  value: MaybePromise<T>,
  mapper: (resolved: T) => MaybePromise<TResult>
): MaybePromise<TResult> {
  return isPromiseLike(value) ? value.then(mapper) : mapper(value);
}

function isProduction() {
  return process.env.NODE_ENV === "production";
}

function isCrossOrigin() {
  return Boolean(process.env.ALLOWED_ORIGINS);
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function normalizeAccountUsername(username: string) {
  const normalized = sanitizeSocialUsername(username);

  if (!isValidSocialUsername(normalized)) {
    throw new Error("Username must be 2-20 characters using letters, numbers, hyphens, or underscores.");
  }

  return normalized;
}

function normalizeSignInIdentifier(identifier: string) {
  const trimmed = identifier.trim();
  if (!trimmed) {
    throw new Error("Please enter your username.");
  }

  return trimmed;
}

function assertValidPassword(password: string) {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(`Password must be at most ${MAX_PASSWORD_LENGTH} characters.`);
  }
}

function assertValidCredentials(password: string) {
  assertValidPassword(password);
}

function findUserForSignIn(identifier: string): MaybePromise<{ id: string; password_hash: string | null } | undefined> {
  const normalizedIdentifier = normalizeSignInIdentifier(identifier);
  const normalizedEmail = normalizeEmail(normalizedIdentifier);

  if (EMAIL_PATTERN.test(normalizedEmail)) {
    return db
      .prepare(`SELECT id, password_hash FROM users WHERE LOWER(email) = LOWER(?)`)
      .get(normalizedEmail) as MaybePromise<{ id: string; password_hash: string | null } | undefined>;
  }

  const normalizedUsername = sanitizeSocialUsername(normalizedIdentifier);
  if (!normalizedUsername) {
    return undefined;
  }

  return db
    .prepare(`SELECT id, password_hash FROM users WHERE LOWER(username) = LOWER(?)`)
    .get(normalizedUsername) as MaybePromise<{ id: string; password_hash: string | null } | undefined>;
}

function assertUsernameAvailable(normalizedUsername: string, userIdToIgnore?: string): MaybePromise<void> {
  const existing = (userIdToIgnore
    ? db
        .prepare(`SELECT id FROM users WHERE LOWER(username) = LOWER(CAST(? AS TEXT)) AND id != CAST(? AS TEXT)`)
        .get(normalizedUsername, userIdToIgnore)
    : db.prepare(`SELECT id FROM users WHERE LOWER(username) = LOWER(CAST(? AS TEXT))`).get(normalizedUsername)) as MaybePromise<
    { id: string } | undefined
  >;

  return flatMapMaybePromise(existing, (row) => {
    if (row) {
      throw new Error("That username is already taken.");
    }
  });
}

function isUsernameConflictError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = (error as { code?: string }).code;
  return (
    code === "23505" ||
    error.message.includes("UNIQUE constraint failed: users.username") ||
    error.message.includes("idx_users_username")
  );
}

export function getSessionCookieName() {
  return SESSION_COOKIE;
}

export function getUserById(userId: string): MaybePromise<AuthUser | null> {
  const row = db
    .prepare(
      `SELECT users.id, users.email, users.username, users.is_anonymous, users.created_at
       FROM users
       WHERE users.id = ?`
    )
    .get(userId) as MaybePromise<
    | { id: string; email: string | null; username: string | null; is_anonymous: number; created_at: number }
    | undefined
  >;

  return flatMapMaybePromise(row, (resolvedRow) => {
    if (!resolvedRow) {
      return null;
    }

    return {
      id: resolvedRow.id,
      email: resolvedRow.email,
      username: resolvedRow.username ?? "",
      isAnonymous: Boolean(resolvedRow.is_anonymous),
      createdAt: resolvedRow.created_at,
    };
  });
}

export function cleanupExpiredSessions(): MaybePromise<void> {
  return flatMapMaybePromise(db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(now()), () => undefined);
}

function deleteSession(sessionId: string | null | undefined): MaybePromise<void> {
  if (!sessionId) {
    return;
  }

  return flatMapMaybePromise(db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId), () => undefined);
}

export function createSession(res: Response, userId: string, options?: CreateSessionOptions): MaybePromise<string> {
  const sessionId = crypto.randomBytes(32).toString("hex");
  return flatMapMaybePromise(cleanupExpiredSessions(), () =>
    flatMapMaybePromise(deleteSession(options?.replaceExistingSessionId), () =>
      flatMapMaybePromise(
        db
          .prepare(`INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
          .run(sessionId, userId, now(), now() + SESSION_TTL_MS),
        () => {
          res.cookie(SESSION_COOKIE, sessionId, {
            httpOnly: true,
            sameSite: isCrossOrigin() ? "none" : "strict",
            // SameSite=None legally requires Secure, so cross-origin deployments must
            // set it even outside production (e.g. a non-prod NODE_ENV behind HTTPS).
            secure: isProduction() || isCrossOrigin(),
            maxAge: SESSION_TTL_MS,
          });
          return sessionId;
        }
      )
    )
  );
}

export function clearSession(req: Request, res: Response): MaybePromise<void> {
  const bearerToken = parseBearerToken(req.headers?.authorization);
  const sessionId = bearerToken ?? req.cookies?.[SESSION_COOKIE];
  return flatMapMaybePromise(deleteSession(sessionId), () => {
    res.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      sameSite: isCrossOrigin() ? "none" : "strict",
      // Mirror the attributes used when the cookie was set so the browser matches
      // and actually clears it (SameSite=None requires Secure).
      secure: isProduction() || isCrossOrigin(),
    });
  });
}

export function getUserFromSessionId(sessionId: string | null | undefined): MaybePromise<AuthUser | null> {
  if (!sessionId) {
    return null;
  }

  const session = db
    .prepare(`SELECT user_id, expires_at FROM sessions WHERE id = ?`)
    .get(sessionId) as MaybePromise<{ user_id: string; expires_at: number } | undefined>;

  return flatMapMaybePromise(session, (resolvedSession) => {
    if (!resolvedSession || resolvedSession.expires_at <= now()) {
      return flatMapMaybePromise(db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId), () => null);
    }

    return flatMapMaybePromise(getUserById(resolvedSession.user_id), (user) => {
      if (user) {
        return user;
      }

      return flatMapMaybePromise(db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId), () => null);
    });
  });
}

function parseBearerToken(authHeader: string | undefined | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  return token || null;
}

export function getUserFromRequest(req: Request): MaybePromise<AuthUser | null> {
  const bearerToken = parseBearerToken(req.headers?.authorization);
  return getUserFromSessionId(bearerToken ?? req.cookies?.[SESSION_COOKIE]);
}

export function parseSessionIdFromCookieHeader(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) {
    return null;
  }

  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === SESSION_COOKIE && rawValue.length > 0) {
      return decodeURIComponent(rawValue.join("="));
    }
  }

  return null;
}

export function getLoggedInUser(user: AuthUser | null): AuthUser | null {
  return user;
}

export function requireUser(req: Request): MaybePromise<AuthUser> {
  return flatMapMaybePromise(getUserFromRequest(req), (user) => {
    if (!user) {
      throw new Error("You must be signed in.");
    }
    return user;
  });
}

export function signUp(username: string, password: string): MaybePromise<string> {
  const normalizedUsername = normalizeAccountUsername(username);
  assertValidCredentials(password);
  const userId = uuid();
  const passwordHash = bcrypt.hashSync(password, 10);

  return flatMapMaybePromise(assertUsernameAvailable(normalizedUsername), () => {
    let result: MaybePromise<unknown>;

    try {
      result = db
        .prepare(
          `INSERT INTO users (id, email, username, password_hash, is_anonymous, created_at) VALUES (?, NULL, ?, ?, 0, ?)`
        )
        .run(userId, normalizedUsername, passwordHash, now());
    } catch (error) {
      if (isUsernameConflictError(error)) {
        throw new Error("That username is already taken.");
      }
      throw error;
    }

    if (isPromiseLike(result)) {
      return result.then(
        () => userId,
        (error) => {
          if (isUsernameConflictError(error)) {
            throw new Error("That username is already taken.");
          }
          throw error;
        }
      );
    }

    return userId;
  });
}

export function signIn(identifier: string, password: string): MaybePromise<string> {
  assertValidPassword(password);
  return flatMapMaybePromise(findUserForSignIn(identifier), (user) => {
    if (!user?.password_hash) {
      // Burn an equivalent bcrypt comparison so a missing user (or one without a
      // password) takes the same time as a real user with a wrong password.
      bcrypt.compareSync(password, DUMMY_PASSWORD_HASH);
      throw new Error("Invalid username or password.");
    }

    const valid = bcrypt.compareSync(password, user.password_hash);
    if (!valid) {
      throw new Error("Invalid username or password.");
    }

    return user.id;
  });
}

export function changePassword(userId: string, currentPassword: string, newPassword: string): MaybePromise<void> {
  assertValidPassword(newPassword);

  // In Postgres mode every db call returns a Promise; flatMapMaybePromise keeps
  // the same code path working synchronously under SQLite. The previous version
  // was a plain sync function, so in production `row` was a Promise and this
  // always threw "not supported for this account type".
  return flatMapMaybePromise(
    db.prepare(`SELECT password_hash FROM users WHERE id = ?`).get(userId) as MaybePromise<
      { password_hash: string | null } | undefined
    >,
    (row) => {
      if (!row?.password_hash) {
        throw new Error("Password changes are not supported for this account type.");
      }

      if (!bcrypt.compareSync(currentPassword, row.password_hash)) {
        throw new Error("Current password is incorrect.");
      }

      return flatMapMaybePromise(
        db
          .prepare(`UPDATE users SET password_hash = ? WHERE id = ?`)
          .run(bcrypt.hashSync(newPassword, 10), userId),
        () =>
          // Force a fresh sign-in everywhere: a password change should revoke every
          // existing session (including any an attacker may hold), not just the caller's.
          flatMapMaybePromise(
            db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId),
            () => undefined
          )
      );
    }
  );
}

export function upgradeAnonymousAccount(
  userId: string,
  username: string,
  password: string
): MaybePromise<AuthUser> {
  const normalizedUsername = normalizeAccountUsername(username);
  assertValidCredentials(password);
  const passwordHash = bcrypt.hashSync(password, 10);

  return flatMapMaybePromise(
    db.prepare(`SELECT id, is_anonymous FROM users WHERE id = ?`).get(userId) as MaybePromise<
      { id: string; is_anonymous: number } | undefined
    >,
    (row) => {
      if (!row) {
        throw new Error("Account not found.");
      }
      if (!row.is_anonymous) {
        throw new Error("This account is already registered.");
      }

      // Upgrade in place on the SAME row so the user's games and stats (keyed by
      // this id) are preserved.
      return flatMapMaybePromise(assertUsernameAvailable(normalizedUsername, userId), () => {
        const resolveUser = () =>
          flatMapMaybePromise(getUserById(userId), (user) => {
            if (!user) {
              throw new Error("Account not found.");
            }
            return user;
          });

        let result: MaybePromise<unknown>;
        try {
          result = db
            .prepare(`UPDATE users SET username = ?, password_hash = ?, is_anonymous = 0 WHERE id = ?`)
            .run(normalizedUsername, passwordHash, userId);
        } catch (error) {
          if (isUsernameConflictError(error)) {
            throw new Error("That username is already taken.");
          }
          throw error;
        }

        if (isPromiseLike(result)) {
          return result.then(resolveUser, (error) => {
            if (isUsernameConflictError(error)) {
              throw new Error("That username is already taken.");
            }
            throw error;
          });
        }

        return resolveUser();
      });
    }
  );
}

export function signInAnonymously(): MaybePromise<string> {
  const userId = uuid();
  return flatMapMaybePromise(
    allocateUniqueUsernameRemote(`anon-${crypto.randomBytes(4).toString("hex")}`),
    (username) =>
      flatMapMaybePromise(
        db
          .prepare(
            `INSERT INTO users (id, email, username, password_hash, is_anonymous, created_at) VALUES (?, NULL, ?, NULL, 1, ?)`
          )
          .run(userId, username, now()),
        () => userId
      )
  );
}
