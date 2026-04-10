import type { Request, Response } from "express";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { v4 as uuid } from "uuid";
import { allocateUniqueUsernameRemote, db } from "./db.js";
import type { AuthUser } from "./types.js";
import { sanitizeSocialUsername } from "../shared/gameLogic.js";

const SESSION_COOKIE = "fourfive_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 72;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function normalizeSignInIdentifier(identifier: string) {
  const trimmed = identifier.trim();
  if (!trimmed) {
    throw new Error("Please enter your email or username.");
  }

  return trimmed;
}

function buildUsernameSeed(value: string) {
  const normalized = sanitizeSocialUsername(value);
  return normalized.length >= 2 ? normalized : "player";
}

function assertValidPassword(password: string) {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(`Password must be at most ${MAX_PASSWORD_LENGTH} characters.`);
  }
}

function assertValidCredentials(email: string, password: string) {
  const normalizedEmail = normalizeEmail(email);

  if (!EMAIL_PATTERN.test(normalizedEmail)) {
    throw new Error("Please enter a valid email address.");
  }

  assertValidPassword(password);
  return normalizedEmail;
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

function assertEmailAvailable(normalizedEmail: string, userIdToIgnore?: string): MaybePromise<void> {
  const existing = (userIdToIgnore
    ? db
        .prepare(`SELECT id FROM users WHERE LOWER(email) = LOWER(CAST(? AS TEXT)) AND id != CAST(? AS TEXT)`)
        .get(normalizedEmail, userIdToIgnore)
    : db.prepare(`SELECT id FROM users WHERE LOWER(email) = LOWER(CAST(? AS TEXT))`).get(normalizedEmail)) as MaybePromise<
    { id: string } | undefined
  >;

  return flatMapMaybePromise(existing, (row) => {
    if (row) {
      throw new Error("An account with that email already exists.");
    }
  });
}

function isEmailConflictError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = (error as { code?: string }).code;
  return code === "23505" || error.message.includes("UNIQUE constraint failed: users.email");
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

export function createSession(res: Response, userId: string, options?: CreateSessionOptions): MaybePromise<void> {
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
            sameSite: "strict",
            secure: isProduction(),
            maxAge: SESSION_TTL_MS,
          });
        }
      )
    )
  );
}

export function clearSession(req: Request, res: Response): MaybePromise<void> {
  const sessionId = req.cookies?.[SESSION_COOKIE];
  return flatMapMaybePromise(deleteSession(sessionId), () => {
    res.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      sameSite: "strict",
      secure: isProduction(),
    });
  });
}

export function getUserFromRequest(req: Request): MaybePromise<AuthUser | null> {
  const sessionId = req.cookies?.[SESSION_COOKIE];
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

export function signUp(email: string, password: string): MaybePromise<string> {
  const normalizedEmail = assertValidCredentials(email, password);
  const userId = uuid();
  const passwordHash = bcrypt.hashSync(password, 10);

  return flatMapMaybePromise(assertEmailAvailable(normalizedEmail), () =>
    flatMapMaybePromise(
      allocateUniqueUsernameRemote(buildUsernameSeed(normalizedEmail.split("@")[0] ?? "player")),
      (username) => {
        try {
          return flatMapMaybePromise(
            db
              .prepare(
                `INSERT INTO users (id, email, username, password_hash, is_anonymous, created_at) VALUES (?, ?, ?, ?, 0, ?)`
              )
              .run(userId, normalizedEmail, username, passwordHash, now()),
            () => userId
          );
        } catch (error) {
          if (isEmailConflictError(error)) {
            throw new Error("An account with that email already exists.");
          }
          throw error;
        }
      }
    )
  );
}

export function upgradeAnonymousAccount(userId: string, email: string, password: string): MaybePromise<void> {
  const normalizedEmail = assertValidCredentials(email, password);
  const passwordHash = bcrypt.hashSync(password, 10);
  const user = db
    .prepare(`SELECT id, is_anonymous FROM users WHERE id = ?`)
    .get(userId) as MaybePromise<{ id: string; is_anonymous: number } | undefined>;

  return flatMapMaybePromise(user, (resolvedUser) => {
    if (!resolvedUser || !resolvedUser.is_anonymous) {
      throw new Error("This guest session can no longer be upgraded.");
    }

    return flatMapMaybePromise(assertEmailAvailable(normalizedEmail, userId), () => {
      const existing = db
        .prepare(`SELECT username FROM users WHERE id = ?`)
        .get(userId) as MaybePromise<{ username: string | null } | undefined>;

      return flatMapMaybePromise(existing, (existingUser) => {
        const usernameSeed = existingUser?.username?.trim()
          ? existingUser.username
          : buildUsernameSeed(normalizedEmail.split("@")[0] ?? "player");

        return flatMapMaybePromise(
          allocateUniqueUsernameRemote(usernameSeed, {
            excludeUserId: userId,
          }),
          (username) => {
            try {
              return flatMapMaybePromise(
                db
                  .prepare(`UPDATE users SET email = ?, username = ?, password_hash = ?, is_anonymous = 0 WHERE id = ?`)
                  .run(normalizedEmail, username, passwordHash, userId),
                () => undefined
              );
            } catch (error) {
              if (isEmailConflictError(error)) {
                throw new Error("An account with that email already exists.");
              }
              throw error;
            }
          }
        );
      });
    });
  });
}

export function signIn(identifier: string, password: string): MaybePromise<string> {
  assertValidPassword(password);
  return flatMapMaybePromise(findUserForSignIn(identifier), (user) => {
    if (!user?.password_hash) {
      throw new Error("Invalid email, username, or password.");
    }

    const valid = bcrypt.compareSync(password, user.password_hash);
    if (!valid) {
      throw new Error("Invalid email, username, or password.");
    }

    return user.id;
  });
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
