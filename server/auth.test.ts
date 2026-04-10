import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { once } from "node:events";
import { createApp } from "./app.js";
import { db, initDb } from "./db.js";
import {
  clearSession,
  createSession,
  getSessionCookieName,
  getUserFromRequest,
  signIn,
  signInAnonymously,
  signUp,
  upgradeAnonymousAccount,
} from "./auth.js";
import { createGame, getPlayerGames } from "./gameService.js";
import { listSocialOverview } from "./friends.js";
import { v4 as uuid } from "uuid";

function createMockRequest(sessionId?: string) {
  return {
    cookies: sessionId ? { [getSessionCookieName()]: sessionId } : {},
  } as Request;
}

function createMockResponse() {
  const cookie = vi.fn();
  const clearCookie = vi.fn();

  return {
    cookie,
    clearCookie,
  } as unknown as Response & {
    cookie: typeof cookie;
    clearCookie: typeof clearCookie;
  };
}

async function withAppServer<T>(run: (baseUrl: string) => Promise<T>) {
  const server = createApp().listen(0);
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected the test server to bind to a port.");
  }

  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

describe("auth", () => {
  beforeEach(() => {
    initDb();
    db.exec(`
      PRAGMA foreign_keys = OFF;
      DELETE FROM sessions;
      DELETE FROM game_invites;
      DELETE FROM friendships;
      DELETE FROM friend_requests;
      DELETE FROM player_presence;
      DELETE FROM chat_messages;
      DELETE FROM guesses;
      DELETE FROM players;
      DELETE FROM games;
      DELETE FROM users;
      DELETE FROM user_stats;
      PRAGMA foreign_keys = ON;
    `);
  });

  it("rejects empty or malformed signup credentials", async () => {
    await expect(Promise.resolve().then(() => signUp("", ""))).rejects.toThrow("Username must");
    await expect(Promise.resolve().then(() => signUp("hello-player", "short"))).rejects.toThrow("at least");
  });

  it("creates and validates a password account", async () => {
    await signUp("hello-player", "supersecret");

    expect(await signIn("hello-player", "supersecret")).toBeTypeOf("string");
    await expect(Promise.resolve().then(() => signIn("hello-player", "wrong-pass"))).rejects.toThrow(
      "Invalid username or password."
    );
  });

  it("signs in with the stored username and keeps email null", async () => {
    const userId = await signUp("username-login", "supersecret");
    const row = db.prepare(`SELECT username, email FROM users WHERE id = ?`).get(userId) as
      | { username: string | null; email: string | null }
      | undefined;

    expect(row?.username).toBe("username-login");
    expect(row?.email).toBeNull();
    expect(await signIn(row?.username ?? "", "supersecret")).toBe(userId);
  });

  it("uses the chosen username and exposes it through sessions", async () => {
    const userId = await signUp("player", "supersecret");

    const row = db.prepare(`SELECT id, username FROM users WHERE id = ?`).get(userId) as
      | { id: string; username: string }
      | undefined;

    expect(row?.username).toBe("player");

    const response = createMockResponse();
    await createSession(response, userId);
    const sessionId = response.cookie.mock.calls[0]?.[1];
    if (typeof sessionId !== "string") {
      throw new Error("Expected session cookie to be created.");
    }

    expect(await getUserFromRequest(createMockRequest(sessionId))).toMatchObject({
      id: userId,
      username: "player",
      email: null,
    });
  });

  it("rejects creating a second account with the same username", async () => {
    await signUp("player", "supersecret");

    await expect(Promise.resolve().then(() => signUp("player", "supersecret"))).rejects.toThrow("already taken");
  });

  it("upgrades an anonymous guest in place without changing the session", async () => {
    const guestId = await signInAnonymously();
    const response = createMockResponse();
    await createSession(response, guestId);

    const sessionId = response.cookie.mock.calls[0]?.[1];
    if (typeof sessionId !== "string") {
      throw new Error("Expected session cookie to be created.");
    }

    await upgradeAnonymousAccount(guestId, "guest-player", "supersecret");

    const updatedSession = db
      .prepare(`SELECT user_id FROM sessions WHERE id = ?`)
      .get(sessionId) as { user_id: string } | undefined;
    const upgradedUser = db
      .prepare(`SELECT id, email, username, is_anonymous, password_hash FROM users WHERE id = ?`)
      .get(guestId) as
      | {
          id: string;
          email: string | null;
          username: string | null;
          is_anonymous: number;
          password_hash: string | null;
        }
      | undefined;
    const requestUser = await getUserFromRequest(createMockRequest(sessionId));
    const sessionCount = db
      .prepare(`SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?`)
      .get(guestId) as { count: number } | undefined;

    expect(updatedSession?.user_id).toBe(guestId);
    expect(upgradedUser).toMatchObject({
      id: guestId,
      email: null,
      username: "guest-player",
      is_anonymous: 0,
    });
    expect(upgradedUser?.password_hash).toEqual(expect.any(String));
    expect(requestUser).toMatchObject({
      id: guestId,
      email: null,
      username: "guest-player",
      isAnonymous: false,
    });
    expect(requestUser?.createdAt).toEqual(expect.any(Number));
    expect(sessionCount?.count ?? 0).toBe(1);
  });

  it("keeps guest social and game history attached after upgrade", async () => {
    const guestId = await signInAnonymously();
    const response = createMockResponse();
    await createSession(response, guestId);

    const sessionId = response.cookie.mock.calls[0]?.[1];
    if (typeof sessionId !== "string") {
      throw new Error("Expected session cookie to be created.");
    }

    const guestUser = await getUserFromRequest(createMockRequest(sessionId));
    if (!guestUser) {
      throw new Error("Expected guest user to resolve from the session.");
    }

    const friendId = await signUp("friend-player", "supersecret");
    const friendGame = await createGame(guestUser, "Guest", "CRANE", false);
    db.prepare(
      `INSERT INTO friendships (id, user_one_id, user_two_id, created_at, request_id) VALUES (?, ?, ?, ?, NULL)`
    ).run(uuid(), guestId, friendId, Date.now());

    await upgradeAnonymousAccount(guestId, "guest-upgrade", "supersecret");

    const upgradedUser = await getUserFromRequest(createMockRequest(sessionId));
    if (!upgradedUser) {
      throw new Error("Expected upgraded user to resolve from the session.");
    }

    const social = await listSocialOverview(upgradedUser);
    const games = await getPlayerGames(upgradedUser);

    expect(upgradedUser).toMatchObject({
      id: guestId,
      email: null,
      username: "guest-upgrade",
      isAnonymous: false,
    });
    expect(social.friends).toHaveLength(1);
    expect(social.friends[0]?.userId).toBe(friendId);
    expect(games.some((game) => game.gameId === friendGame.gameId)).toBe(true);
  });

  it("rejects upgrading a guest to a username that already exists", async () => {
    await signUp("taken-name", "supersecret");
    const guestId = await signInAnonymously();

    await expect(
      Promise.resolve().then(() => upgradeAnonymousAccount(guestId, "taken-name", "supersecret"))
    ).rejects.toThrow("already taken");
  });

  it("rotates the session when upgrading an anonymous guest through the signup route", async () => {
    const guestId = await signInAnonymously();
    const response = createMockResponse();
    await createSession(response, guestId);

    const sessionId = response.cookie.mock.calls[0]?.[1];
    if (typeof sessionId !== "string") {
      throw new Error("Expected session cookie to be created.");
    }

    await withAppServer(async (baseUrl) => {
      const result = await fetch(`${baseUrl}/api/auth/signup`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${getSessionCookieName()}=${sessionId}`,
        },
        body: JSON.stringify({
          username: "route-guest",
          password: "supersecret",
        }),
      });

      const body = (await result.json()) as {
        ok: boolean;
        user?: { id: string; email: string | null; username: string; isAnonymous: boolean };
      };

      expect(result.status).toBe(200);
      expect(body.user).toMatchObject({
        id: guestId,
        email: null,
        username: "route-guest",
        isAnonymous: false,
      });
    });

    const upgradedUser = db
      .prepare(`SELECT id, email, username, is_anonymous FROM users WHERE id = ?`)
      .get(guestId) as { id: string; email: string | null; username: string | null; is_anonymous: number } | undefined;
    const rotatedSession = db
      .prepare(`SELECT id, user_id FROM sessions WHERE user_id = ?`)
      .get(guestId) as { id: string; user_id: string } | undefined;

    expect(upgradedUser).toMatchObject({
      id: guestId,
      email: null,
      username: "route-guest",
      is_anonymous: 0,
    });
    expect(rotatedSession?.id).toBeTruthy();
    expect(rotatedSession?.id).not.toBe(sessionId);
    expect(db.prepare(`SELECT id FROM sessions WHERE id = ?`).get(sessionId)).toBeUndefined();
  });

  it("accepts a username on the signin route and creates a live session", async () => {
    const userId = await signUp("route-signin", "supersecret");

    await withAppServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/auth/signin`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          identifier: "route-signin",
          password: "supersecret",
        }),
      });
      const body = (await response.json()) as {
        ok: boolean;
        user?: { id: string; email: string | null; username: string; isAnonymous: boolean };
      };

      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toContain(getSessionCookieName());
      expect(body.user).toMatchObject({
        id: userId,
        email: null,
        username: "route-signin",
        isAnonymous: false,
      });
    });
  });

  it("cleans up expired sessions when resolving the current user", async () => {
    const userId = await signUp("session-player", "supersecret");
    const response = createMockResponse();
    await createSession(response, userId);

    const sessionId = response.cookie.mock.calls[0]?.[1];
    if (typeof sessionId !== "string") {
      throw new Error("Expected session cookie to be created.");
    }

    db.prepare(`UPDATE sessions SET expires_at = ? WHERE id = ?`).run(Date.now() - 1000, sessionId);

    expect(await getUserFromRequest(createMockRequest(sessionId))).toBeNull();
    expect(db.prepare(`SELECT id FROM sessions WHERE id = ?`).get(sessionId)).toBeUndefined();
  });

  it("clears the session cookie and deletes the backing session row", async () => {
    const userId = await signUp("logout-player", "supersecret");
    const createResponse = createMockResponse();
    await createSession(createResponse, userId);

    const sessionId = createResponse.cookie.mock.calls[0]?.[1];
    if (typeof sessionId !== "string") {
      throw new Error("Expected session cookie to be created.");
    }

    const req = createMockRequest(sessionId);
    const clearResponse = createMockResponse();

    await clearSession(req, clearResponse);

    expect(clearResponse.clearCookie).toHaveBeenCalledWith(
      getSessionCookieName(),
      expect.objectContaining({
        httpOnly: true,
        sameSite: "strict",
      })
    );
    expect(db.prepare(`SELECT id FROM sessions WHERE id = ?`).get(sessionId)).toBeUndefined();
  });
});
