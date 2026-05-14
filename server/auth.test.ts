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
} from "./auth.js";

function createMockRequest(sessionId?: string) {
  return {
    headers: {},
    cookies: sessionId ? { [getSessionCookieName()]: sessionId } : {},
  } as unknown as Request;
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

  it("rejects creating an account while a guest session is active", async () => {
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
          username: "route-new-account",
          password: "supersecret",
        }),
      });

      const body = (await result.json()) as {
        error?: string;
      };

      expect(result.status).toBe(400);
      expect(body.error).toMatch(/already signed in/i);
    });

    const guestUser = db
      .prepare(`SELECT id, email, username, is_anonymous FROM users WHERE id = ?`)
      .get(guestId) as { id: string; email: string | null; username: string | null; is_anonymous: number } | undefined;
    const activeSession = db
      .prepare(`SELECT id, user_id FROM sessions WHERE user_id = ?`)
      .get(guestId) as { id: string; user_id: string } | undefined;

    expect(guestUser).toMatchObject({
      id: guestId,
      email: null,
      is_anonymous: 1,
    });
    expect(activeSession?.id).toBe(sessionId);
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
