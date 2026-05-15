import { beforeEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import type { AuthUser } from "./types.js";
import { db, initDb } from "./db.js";
import { createApp } from "./app.js";
import {
  acceptGameInvite,
  acceptFriendRequest,
  cancelFriendRequest,
  cancelGameInvite,
  declineFriendRequest,
  declineGameInvite,
  listSocialOverview,
  removeFriend,
  searchUsers,
  sendFriendRequest,
  sendGameInvite,
  sendGameInviteByUsername,
} from "./friends.js";
import { createGame, getGameState } from "./gameService.js";

function makeUser(id: string, email: string, username = email.split("@")[0] ?? id): AuthUser {
  return {
    id,
    email,
    username,
    isAnonymous: false,
    createdAt: Date.now(),
  };
}

function seedUser(user: AuthUser) {
  db.prepare(
    `INSERT INTO users (id, email, username, password_hash, is_anonymous, created_at) VALUES (?, ?, ?, NULL, ?, ?)`
  ).run(user.id, user.email, user.username, user.isAnonymous ? 1 : 0, user.createdAt);
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

describe("friends service", () => {
  beforeEach(() => {
    initDb();
    db.exec(`
      PRAGMA foreign_keys = OFF;
      DELETE FROM game_invites;
      DELETE FROM friendships;
      DELETE FROM friend_requests;
      DELETE FROM player_presence;
      DELETE FROM chat_messages;
      DELETE FROM guesses;
      DELETE FROM players;
      DELETE FROM games;
      DELETE FROM sessions;
      DELETE FROM user_stats;
      DELETE FROM users;
      PRAGMA foreign_keys = ON;
    `);
    vi.restoreAllMocks();
  });

  it("supports the friend request lifecycle and social overview", async () => {
    const alpha = makeUser("user-alpha", "alpha@example.com", "alpha");
    const bravo = makeUser("user-bravo", "bravo@example.com", "bravo");
    seedUser(alpha);
    seedUser(bravo);

    const search = await searchUsers(alpha, "bravo");
    expect(search).toHaveLength(1);
    expect(search[0]?.username).toBe("bravo");
    expect(search[0]?.relationship).toBe("none");

    const sent = await sendFriendRequest(alpha, "bravo");
    expect(sent.status).toBe("pending");

    const alphaOverview = await listSocialOverview(alpha);
    const bravoOverview = await listSocialOverview(bravo);
    expect(alphaOverview.outgoingRequests).toHaveLength(1);
    expect(bravoOverview.incomingRequests).toHaveLength(1);

    await acceptFriendRequest(bravo, sent.requestId);

    const updatedAlphaOverview = await listSocialOverview(alpha);
    const updatedBravoOverview = await listSocialOverview(bravo);
    expect(updatedAlphaOverview.friends).toHaveLength(1);
    expect(updatedBravoOverview.friends).toHaveLength(1);
    expect(updatedAlphaOverview.outgoingRequests).toHaveLength(0);
    expect(updatedBravoOverview.incomingRequests).toHaveLength(0);
  });

  it("auto-accepts a reverse pending friend request", async () => {
    const alpha = makeUser("user-alpha", "alpha@example.com", "alpha");
    const bravo = makeUser("user-bravo", "bravo@example.com", "bravo");
    seedUser(alpha);
    seedUser(bravo);

    const first = await sendFriendRequest(alpha, bravo.username);
    const second = await sendFriendRequest(bravo, alpha.username);

    expect(first.requestId).toBe(second.requestId);
    expect(second.becameFriends).toBe(true);
    expect((await listSocialOverview(alpha)).friends).toHaveLength(1);
    expect((await listSocialOverview(bravo)).friends).toHaveLength(1);
  });

  it("supports declining and canceling friend requests", async () => {
    const alpha = makeUser("user-alpha", "alpha@example.com");
    const bravo = makeUser("user-bravo", "bravo@example.com");
    seedUser(alpha);
    seedUser(bravo);

    const request = await sendFriendRequest(alpha, bravo.id);
    await declineFriendRequest(bravo, request.requestId);

    expect((await listSocialOverview(alpha)).outgoingRequests).toHaveLength(0);
    expect((await listSocialOverview(bravo)).incomingRequests).toHaveLength(0);
    expect((await listSocialOverview(alpha)).friends).toHaveLength(0);

    const secondRequest = await sendFriendRequest(alpha, bravo.id);
    await cancelFriendRequest(alpha, secondRequest.requestId);

    expect((await listSocialOverview(alpha)).outgoingRequests).toHaveLength(0);
    expect((await listSocialOverview(bravo)).incomingRequests).toHaveLength(0);
    expect((await listSocialOverview(alpha)).friends).toHaveLength(0);
  });

  it("rejects accepting a friend request that is no longer pending", async () => {
    const alpha = makeUser("user-alpha", "alpha@example.com");
    const bravo = makeUser("user-bravo", "bravo@example.com");
    seedUser(alpha);
    seedUser(bravo);

    const request = await sendFriendRequest(alpha, bravo.username);
    db.prepare(`UPDATE friend_requests SET status = 'declined', responded_at = ?, acted_by_user_id = ? WHERE id = ?`).run(
      Date.now(),
      bravo.id,
      request.requestId
    );

    await expect(acceptFriendRequest(bravo, request.requestId)).rejects.toThrow("Friend request not found.");
    expect((await listSocialOverview(alpha)).friends).toHaveLength(0);
  });

  it("removes friends by username and clears pending game invites", async () => {
    const alpha = makeUser("user-alpha", "alpha@example.com", "alpha");
    const bravo = makeUser("user-bravo", "bravo@example.com", "bravo");
    seedUser(alpha);
    seedUser(bravo);

    const request = await sendFriendRequest(alpha, bravo.username);
    await acceptFriendRequest(bravo, request.requestId);

    const created = await createGame(alpha, "Alpha", "CRANE", false);
    await sendGameInvite(alpha, created.gameId, bravo.id);

    await removeFriend(alpha, bravo.id);

    const alphaOverview = await listSocialOverview(alpha);
    const bravoOverview = await listSocialOverview(bravo);
    expect(alphaOverview.friends).toHaveLength(0);
    expect(bravoOverview.friends).toHaveLength(0);
    expect(alphaOverview.outgoingGameInvites).toHaveLength(0);
    expect(bravoOverview.incomingGameInvites).toHaveLength(0);
  });

  it("lets friends invite each other into a waiting lobby and accept from the inbox", async () => {
    const alpha = makeUser("user-alpha", "alpha@example.com", "alpha");
    const bravo = makeUser("user-bravo", "bravo@example.com", "bravo");
    seedUser(alpha);
    seedUser(bravo);

    const request = await sendFriendRequest(alpha, bravo.username);
    await acceptFriendRequest(bravo, request.requestId);

    const created = await createGame(alpha, "Alpha", "CRANE", false);
    const invite = await sendGameInvite(alpha, created.gameId, bravo.id);

    const bravoOverview = await listSocialOverview(bravo);
    expect(bravoOverview.incomingGameInvites).toHaveLength(1);
    expect(bravoOverview.incomingGameInvites[0]?.inviteId).toBe(invite.inviteId);

    const accepted = await acceptGameInvite(bravo, invite.inviteId, "Bravo", "LIGHT");
    expect(accepted.gameId).toBe(created.gameId);

    const state = await getGameState(alpha, created.gameId);
    expect(state?.game.status).toBe("active");
    expect(state?.opponent?.username).toBe("Bravo");
    expect((await listSocialOverview(alpha)).outgoingGameInvites).toHaveLength(0);
  });

  it("rejects invites to expired waiting lobbies and removes them from social views", async () => {
    const alpha = makeUser("user-alpha", "alpha@example.com", "alpha");
    const bravo = makeUser("user-bravo", "bravo@example.com", "bravo");
    seedUser(alpha);
    seedUser(bravo);

    const request = await sendFriendRequest(alpha, bravo.username);
    await acceptFriendRequest(bravo, request.requestId);

    const created = await createGame(alpha, "Alpha", "CRANE", false);
    db.prepare(`UPDATE games SET created_at = ? WHERE id = ?`).run(Date.now() - 13 * 60 * 60 * 1000, created.gameId);

    expect((await listSocialOverview(alpha)).invitableGames).toHaveLength(0);
    await expect(sendGameInvite(alpha, created.gameId, bravo.id)).rejects.toThrow("Waiting game not found.");
  });

  it("supports declining and canceling game invites", async () => {
    const alpha = makeUser("user-alpha", "alpha@example.com", "alpha");
    const bravo = makeUser("user-bravo", "bravo@example.com", "bravo");
    seedUser(alpha);
    seedUser(bravo);

    const request = await sendFriendRequest(alpha, bravo.username);
    await acceptFriendRequest(bravo, request.requestId);

    const created = await createGame(alpha, "Alpha", "CRANE", false);

    const declinedInvite = await sendGameInvite(alpha, created.gameId, bravo.id);
    await declineGameInvite(bravo, declinedInvite.inviteId);

    expect((await listSocialOverview(alpha)).outgoingGameInvites).toHaveLength(0);
    expect((await listSocialOverview(bravo)).incomingGameInvites).toHaveLength(0);
    expect((await getGameState(alpha, created.gameId))?.game.status).toBe("waiting");

    const canceledInvite = await sendGameInvite(alpha, created.gameId, bravo.id);
    await cancelGameInvite(alpha, canceledInvite.inviteId);

    expect((await listSocialOverview(alpha)).outgoingGameInvites).toHaveLength(0);
    expect((await listSocialOverview(bravo)).incomingGameInvites).toHaveLength(0);
    expect((await getGameState(alpha, created.gameId))?.game.status).toBe("waiting");
  });

  it("rejects accepting a game invite that is no longer pending", async () => {
    const alpha = makeUser("user-alpha", "alpha@example.com", "alpha");
    const bravo = makeUser("user-bravo", "bravo@example.com", "bravo");
    seedUser(alpha);
    seedUser(bravo);

    const request = await sendFriendRequest(alpha, bravo.username);
    await acceptFriendRequest(bravo, request.requestId);

    const created = await createGame(alpha, "Alpha", "CRANE", false);
    const invite = await sendGameInvite(alpha, created.gameId, bravo.id);
    db.prepare(`UPDATE game_invites SET status = 'canceled', responded_at = ? WHERE id = ?`).run(Date.now(), invite.inviteId);

    await expect(acceptGameInvite(bravo, invite.inviteId, "Bravo", "LIGHT")).rejects.toThrow("Game invite not found.");
    expect((await getGameState(alpha, created.gameId))?.game.status).toBe("waiting");
  });

  it("removing a friend cancels pending game invites between them", async () => {
    const alpha = makeUser("user-alpha", "alpha@example.com");
    const bravo = makeUser("user-bravo", "bravo@example.com");
    seedUser(alpha);
    seedUser(bravo);

    const request = await sendFriendRequest(alpha, bravo.id);
    await acceptFriendRequest(bravo, request.requestId);

    const created = await createGame(alpha, "Alpha", "CRANE", false);
    await sendGameInvite(alpha, created.gameId, bravo.id);

    await removeFriend(alpha, bravo.username);

    const alphaOverview = await listSocialOverview(alpha);
    const bravoOverview = await listSocialOverview(bravo);
    expect(alphaOverview.friends).toHaveLength(0);
    expect(bravoOverview.friends).toHaveLength(0);
    expect(alphaOverview.outgoingGameInvites).toHaveLength(0);
    expect(bravoOverview.incomingGameInvites).toHaveLength(0);
  });

  it("lets an anonymous sender invite a registered user by username", async () => {
    const anonSender: AuthUser = {
      id: "anon-1",
      email: null,
      username: "anon-3f9a8c",
      isAnonymous: true,
      createdAt: Date.now(),
    };
    seedUser(anonSender);

    const registeredReceiver = makeUser("reg-1", "alpha@example.com", "alpha");
    seedUser(registeredReceiver);

    const created = await createGame(anonSender, "GuestName", "crane", false);
    const result = await sendGameInviteByUsername(anonSender, created.gameId, "alpha");

    expect(result.inviteId).toBeTruthy();
    expect(result.receiverDisplayName).toBe("alpha");

    const receiverOverview = await listSocialOverview(registeredReceiver);
    expect(receiverOverview.incomingGameInvites).toHaveLength(1);
    expect(receiverOverview.incomingGameInvites[0].sender.userId).toBe(anonSender.id);
  });

  it("returns unauthorized for unauthenticated social routes", async () => {
    await withAppServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/social`);
      const body = (await response.json()) as { error?: string };

      expect(response.status).toBe(401);
      expect(body.error).toBe("You must be signed in.");
    });
  });
});
