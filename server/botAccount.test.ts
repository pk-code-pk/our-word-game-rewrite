// Bot accounts are real `users` rows so `players.user_id` can foreign-key to
// them. That made them indistinguishable from people, which produced three
// bugs: a squattable username that could permanently disable a difficulty for
// every user, bot accounts appearing in player search, and friend requests to
// bots hanging forever. These pin all three.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, initDb } from "./db.js";
import { createBotGame } from "./gameService.js";
import { createSocialRouter } from "./friends.js";
import { signUp } from "./auth.js";
import type { AuthUser } from "./types.js";
import { isValidSocialUsername } from "../shared/gameLogic.js";

function makeUser(id: string, email: string, username = email.split("@")[0] ?? id): AuthUser {
  return { id, email, username, isAnonymous: false, createdAt: Date.now() };
}

function seedUser(user: AuthUser) {
  db.prepare(
    `INSERT INTO users (id, email, username, password_hash, is_anonymous, created_at) VALUES (?, ?, ?, NULL, ?, ?)`
  ).run(user.id, user.email, user.username, user.isAnonymous ? 1 : 0, user.createdAt);
}

/** Invoke a route on the social router without standing up an HTTP server. */
async function callSocialRoute(method: "get" | "post", path: string, user: AuthUser, body: unknown = {}) {
  const router = createSocialRouter() as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Function }> } }>;
  };
  const layer = router.stack.find((l) => l.route?.path === path && l.route?.methods[method]);
  if (!layer?.route) throw new Error(`route ${method.toUpperCase()} ${path} not found`);

  const req = { body, query: body, params: {}, headers: {}, cookies: {}, user } as never;
  let captured: unknown;
  let failure: Error | null = null;
  const res = { json: (v: unknown) => { captured = v; } } as never;

  // requireUser reads the session; short-circuit it by stubbing the lookup.
  const auth = await import("./auth.js");
  const spy = vi.spyOn(auth, "requireUser").mockResolvedValue(user);
  try {
    await layer.route.stack[0].handle(req, res, (err?: Error) => { if (err) failure = err; });
  } finally {
    spy.mockRestore();
  }
  if (failure) throw failure;
  return captured;
}

describe("bot accounts", () => {
  beforeEach(() => {
    initDb();
    db.exec(`
      PRAGMA foreign_keys = OFF;
      DELETE FROM game_invites; DELETE FROM friendships; DELETE FROM friend_requests;
      DELETE FROM player_presence; DELETE FROM chat_messages; DELETE FROM guesses;
      DELETE FROM players; DELETE FROM games; DELETE FROM sessions;
      DELETE FROM user_stats; DELETE FROM users;
      PRAGMA foreign_keys = ON;
    `);
  });

  afterEach(() => vi.restoreAllMocks());

  it("uses usernames no human is allowed to register", async () => {
    // This is the whole defense against the squat: the reserved names sit
    // outside the character set the signup validator accepts, so the collision
    // is impossible rather than merely unlikely.
    const human = makeUser("u1", "u1@example.com", "u1");
    seedUser(human);
    await createBotGame(human, "Human", "CHAIR", "easy");

    const botUsernames = (
      db.prepare(`SELECT username FROM users WHERE is_bot = 1`).all() as Array<{ username: string }>
    ).map((r) => r.username);

    expect(botUsernames.length).toBeGreaterThan(0);
    for (const name of botUsernames) {
      expect(isValidSocialUsername(name), `${name} is registerable by a human`).toBe(false);
    }
  });

  it("marks bot accounts with is_bot so they are distinguishable from people", async () => {
    const human = makeUser("u1", "u1@example.com", "u1");
    seedUser(human);
    await createBotGame(human, "Human", "CHAIR", "medium");

    const bot = db.prepare(`SELECT is_bot FROM users WHERE id = 'bot-medium'`).get() as { is_bot: number };
    expect(Number(bot.is_bot)).toBe(1);
    const humanRow = db.prepare(`SELECT is_bot FROM users WHERE id = 'u1'`).get() as { is_bot: number };
    expect(Number(humanRow.is_bot)).toBe(0);
  });

  it("keeps a squatter from disabling a difficulty for everyone", async () => {
    // Previously: registering the bot's name took its row, and from then on
    // every user's game at that difficulty failed permanently.
    const squatter = makeUser("squatter", "squat@example.com", "rookie-bot");
    seedUser(squatter);

    const victim = makeUser("victim", "victim@example.com", "victim");
    seedUser(victim);

    await expect(createBotGame(victim, "Victim", "CHAIR", "easy")).resolves.toMatchObject({
      botName: expect.any(String),
    });
  });

  it("hides bot accounts from player search", async () => {
    const human = makeUser("u1", "u1@example.com", "searcher");
    seedUser(human);
    await createBotGame(human, "Human", "CHAIR", "hard");

    const result = (await callSocialRoute("get", "/search", human, { q: "bot" })) as {
      results: Array<{ userId: string }>;
    };
    expect(result.results.every((r) => !r.userId.startsWith("bot-"))).toBe(true);
  });

  it("refuses a friend request aimed at a bot", async () => {
    const human = makeUser("u1", "u1@example.com", "requester");
    seedUser(human);
    await createBotGame(human, "Human", "CHAIR", "medium");

    // By id and by username — both resolve through the same chokepoint.
    await expect(callSocialRoute("post", "/requests", human, { targetIdentifier: "bot-medium" })).rejects.toThrow();
    await expect(callSocialRoute("post", "/requests", human, { targetIdentifier: "bot.medium" })).rejects.toThrow();

    const pending = db.prepare(`SELECT COUNT(*) AS c FROM friend_requests`).get() as { c: number };
    expect(pending.c).toBe(0);
  });

  it("leaves bot usernames alone when the username backfill runs", async () => {
    const human = makeUser("u1", "u1@example.com", "u1");
    seedUser(human);
    await createBotGame(human, "Human", "CHAIR", "easy");

    const before = db.prepare(`SELECT username FROM users WHERE id = 'bot-easy'`).get() as { username: string };
    initDb(); // re-runs backfillUsernames
    const after = db.prepare(`SELECT username FROM users WHERE id = 'bot-easy'`).get() as { username: string };

    // The backfill sanitizes names into the registerable character set; if it
    // touched bot rows it would strip the "." and hand the name back to humans.
    expect(after.username).toBe(before.username);
    expect(isValidSocialUsername(after.username)).toBe(false);
  });

  it("still lets real players find and befriend each other", async () => {
    const human = makeUser("u1", "u1@example.com", "alice");
    seedUser(human);
    await signUp("bobsmith@example.com", "hunter2hunter2");
    await createBotGame(human, "Human", "CHAIR", "medium");

    const result = (await callSocialRoute("get", "/search", human, { q: "bob" })) as {
      results: Array<{ userId: string }>;
    };
    expect(result.results.length).toBeGreaterThan(0);
  });
});
