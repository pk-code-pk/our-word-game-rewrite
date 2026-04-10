import { Router, type Request, type Response } from "express";
import { v4 as uuid } from "uuid";
import { requireUser } from "./auth.js";
import { db } from "./db.js";
import { isValidUsername, isWaitingGameExpired, normalizeWord, sanitizeUsername } from "../shared/gameLogic.js";
import { getWordValidationReason } from "../shared/wordBank.js";
import { performJoinWaitingGameWithRunner } from "./gameService.js";
import type {
  AuthUser,
  FriendRequestStatus,
  FriendRequestView,
  FriendView,
  GameInviteStatus,
  GameInviteView,
  GameStatus,
  InvitableGameView,
  SocialOverview,
  SocialRelationship,
  SocialSearchResult,
  SocialUserSummary,
} from "./types.js";

type UserRow = {
  id: string;
  email: string | null;
  username: string | null;
  is_anonymous: number;
  created_at: number;
};

type FriendRequestRow = {
  id: string;
  status: FriendRequestStatus;
  created_at: number;
  responded_at: number | null;
  sender_id: string;
  sender_email: string | null;
  sender_username: string | null;
  sender_is_anonymous: number;
  sender_created_at: number;
  receiver_id: string;
  receiver_email: string | null;
  receiver_username: string | null;
  receiver_is_anonymous: number;
  receiver_created_at: number;
};

type GameInviteRow = {
  id: string;
  status: GameInviteStatus;
  created_at: number;
  responded_at: number | null;
  game_id: string;
  game_code: string;
  game_status: GameStatus;
  public: number;
  sender_id: string;
  sender_email: string | null;
  sender_username: string | null;
  sender_is_anonymous: number;
  sender_created_at: number;
  receiver_id: string;
  receiver_email: string | null;
  receiver_username: string | null;
  receiver_is_anonymous: number;
  receiver_created_at: number;
  host_user_id: string;
  host_username: string | null;
};

type DbRunner = Pick<typeof db, "prepare" | "exec">;

function now() {
  return Date.now();
}

function assertValidDictionaryWord(word: string, expectedLength?: 4 | 5) {
  const reason = getWordValidationReason(word, expectedLength);
  if (reason) {
    throw new Error(reason);
  }
}

function getParam(value: string | string[] | undefined) {
  return typeof value === "string" ? value : "";
}

function assertRegisteredUser(user: AuthUser) {
  if (user.isAnonymous) {
    throw new Error("Create a full account to use the friend system.");
  }
}

function sortPair(leftUserId: string, rightUserId: string) {
  return leftUserId < rightUserId
    ? { lowUserId: leftUserId, highUserId: rightUserId }
    : { lowUserId: rightUserId, highUserId: leftUserId };
}

function buildDisplayName(username: string | null, fallback: string | null) {
  if (username && username.trim()) {
    return username.trim();
  }

  if (fallback) {
    return fallback.split("@")[0] || fallback;
  }

  return "Player";
}

function mapUserSummary(row: UserRow): SocialUserSummary {
  return {
    userId: row.id,
    username: row.username?.trim() ?? "",
    displayName: buildDisplayName(row.username, row.email),
    email: row.email,
    isAnonymous: Boolean(row.is_anonymous),
    createdAt: row.created_at,
  };
}

async function getUserById(userId: string) {
  return getUserByIdFrom(db, userId);
}

async function getUserByIdFrom(runner: DbRunner, userId: string) {
  return (await runner
    .prepare(
      `SELECT users.id, users.email, users.username, users.is_anonymous, users.created_at
       FROM users
       WHERE users.id = ?`
    )
    .get(userId)) as UserRow | undefined;
}

async function getUserByUsername(username: string) {
  return getUserByUsernameFrom(db, username);
}

async function getUserByUsernameFrom(runner: DbRunner, username: string) {
  return (await runner
    .prepare(`SELECT id, email, username, is_anonymous, created_at FROM users WHERE LOWER(username) = LOWER(?)`)
    .get(username.trim())) as UserRow | undefined;
}

async function getUserByIdentifier(identifier: string) {
  return getUserByIdentifierFrom(db, identifier);
}

async function getUserByIdentifierFrom(runner: DbRunner, identifier: string) {
  const trimmed = identifier.trim();
  if (!trimmed) {
    throw new Error("Choose a player to add.");
  }

  const byId = await getUserByIdFrom(runner, trimmed);
  if (byId) {
    return byId;
  }

  const byUsername = await getUserByUsernameFrom(runner, trimmed);
  if (byUsername) {
    return byUsername;
  }

  throw new Error("User not found.");
}

async function getRegisteredUserByIdentifier(identifier: string) {
  return getRegisteredUserByIdentifierFrom(db, identifier);
}

async function getRegisteredUserByIdentifierFrom(runner: DbRunner, identifier: string) {
  const user = await getUserByIdentifierFrom(runner, identifier);
  if (user.is_anonymous) {
    throw new Error("Anonymous accounts can't use the friend system.");
  }
  return user;
}

async function getPendingFriendRequestBetween(userId: string, otherUserId: string) {
  return getPendingFriendRequestBetweenFrom(db, userId, otherUserId);
}

async function getPendingFriendRequestBetweenFrom(runner: DbRunner, userId: string, otherUserId: string) {
  const { lowUserId, highUserId } = sortPair(userId, otherUserId);
  return (await runner
    .prepare(
      `SELECT id, sender_user_id, receiver_user_id
       FROM friend_requests
       WHERE pair_low_user_id = ? AND pair_high_user_id = ? AND status = 'pending'
       LIMIT 1`
    )
    .get(lowUserId, highUserId)) as
    | {
        id: string;
        sender_user_id: string;
        receiver_user_id: string;
      }
    | undefined;
}

async function getFriendshipBetweenFrom(runner: DbRunner, userId: string, otherUserId: string) {
  const { lowUserId, highUserId } = sortPair(userId, otherUserId);
  return (await runner
    .prepare(`SELECT id FROM friendships WHERE user_one_id = ? AND user_two_id = ?`)
    .get(lowUserId, highUserId)) as { id: string } | undefined;
}

async function getFriendshipBetween(userId: string, otherUserId: string) {
  return getFriendshipBetweenFrom(db, userId, otherUserId);
}

async function ensureUsersAreFriendsFrom(runner: DbRunner, userId: string, otherUserId: string) {
  const friendship = await getFriendshipBetweenFrom(runner, userId, otherUserId);
  if (!friendship) {
    throw new Error("You can only invite confirmed friends.");
  }
  return friendship;
}

async function ensureUsersAreFriends(userId: string, otherUserId: string) {
  return ensureUsersAreFriendsFrom(db, userId, otherUserId);
}

async function createFriendshipFromRequest(
  requestId: string,
  senderUserId: string,
  receiverUserId: string
) {
  return createFriendshipFromRequestWithRunner(db, requestId, senderUserId, receiverUserId);
}

async function createFriendshipFromRequestWithRunner(
  runner: DbRunner,
  requestId: string,
  senderUserId: string,
  receiverUserId: string
) {
  const { lowUserId, highUserId } = sortPair(senderUserId, receiverUserId);
  const friendshipId = uuid();
  const inserted = await runner
    .prepare(
      `INSERT INTO friendships (id, user_one_id, user_two_id, created_at, request_id)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_one_id, user_two_id) DO NOTHING`
    )
    .run(friendshipId, lowUserId, highUserId, now(), requestId);

  if (inserted.changes === 0) {
    const existing = await getFriendshipBetweenFrom(runner, lowUserId, highUserId);
    if (existing) {
      return existing.id;
    }
    throw new Error("Unable to create friendship.");
  }

  return friendshipId;
}

async function cleanupExpiredWaitingGames() {
  const expiredAt = now() - 12 * 60 * 60 * 1000;
  const result = await db.prepare(`DELETE FROM games WHERE status = 'waiting' AND created_at < ?`).run(expiredAt);
  return result.changes;
}

async function expireInvalidPendingGameInvites() {
  const result = await db.prepare(
    `UPDATE game_invites
     SET status = 'expired', responded_at = ?
     WHERE status = 'pending'
       AND (
         NOT EXISTS (
           SELECT 1
           FROM games
           WHERE games.id = game_invites.game_id AND games.status = 'waiting'
         )
         OR NOT EXISTS (
           SELECT 1
           FROM players
           WHERE players.game_id = game_invites.game_id AND players.user_id = game_invites.sender_user_id
         )
         OR NOT EXISTS (
           SELECT 1
           FROM friendships
           WHERE friendships.user_one_id = CASE
             WHEN game_invites.sender_user_id < game_invites.receiver_user_id
             THEN game_invites.sender_user_id
             ELSE game_invites.receiver_user_id
           END
             AND friendships.user_two_id = CASE
             WHEN game_invites.sender_user_id < game_invites.receiver_user_id
             THEN game_invites.receiver_user_id
             ELSE game_invites.sender_user_id
           END
         )
         OR (
           SELECT COUNT(*)
           FROM players
           WHERE players.game_id = game_invites.game_id
         ) >= 2
       )`
  ).run(now());
  return result.changes;
}

function mapFriendRequest(row: FriendRequestRow, viewerUserId: string): FriendRequestView {
  const sender: SocialUserSummary = {
    userId: row.sender_id,
    username: row.sender_username?.trim() ?? "",
    displayName: buildDisplayName(row.sender_username, row.sender_email),
    email: row.sender_email,
    isAnonymous: Boolean(row.sender_is_anonymous),
    createdAt: row.sender_created_at,
  };
  const receiver: SocialUserSummary = {
    userId: row.receiver_id,
    username: row.receiver_username?.trim() ?? "",
    displayName: buildDisplayName(row.receiver_username, row.receiver_email),
    email: row.receiver_email,
    isAnonymous: Boolean(row.receiver_is_anonymous),
    createdAt: row.receiver_created_at,
  };

  return {
    requestId: row.id,
    direction: row.sender_id === viewerUserId ? "outgoing" : "incoming",
    status: row.status,
    createdAt: row.created_at,
    respondedAt: row.responded_at ?? undefined,
    sender,
    receiver,
  };
}

function mapGameInvite(row: GameInviteRow): GameInviteView {
  const sender: SocialUserSummary = {
    userId: row.sender_id,
    username: row.sender_username?.trim() ?? "",
    displayName: buildDisplayName(row.sender_username, row.sender_email),
    email: row.sender_email,
    isAnonymous: Boolean(row.sender_is_anonymous),
    createdAt: row.sender_created_at,
  };
  const receiver: SocialUserSummary = {
    userId: row.receiver_id,
    username: row.receiver_username?.trim() ?? "",
    displayName: buildDisplayName(row.receiver_username, row.receiver_email),
    email: row.receiver_email,
    isAnonymous: Boolean(row.receiver_is_anonymous),
    createdAt: row.receiver_created_at,
  };

  return {
    inviteId: row.id,
    status: row.status,
    createdAt: row.created_at,
    respondedAt: row.responded_at ?? undefined,
    gameId: row.game_id,
    gameCode: row.game_code,
    gameStatus: row.game_status,
    sender,
    receiver,
    hostUserId: row.host_user_id,
    hostDisplayName: buildDisplayName(row.host_username, null),
    public: Boolean(row.public),
  };
}

async function getRelationshipForUser(viewerUserId: string, targetUserId: string): Promise<SocialRelationship> {
  if (await getFriendshipBetween(viewerUserId, targetUserId)) {
    return "friend";
  }

  const request = await getPendingFriendRequestBetween(viewerUserId, targetUserId);
  if (!request) {
    return "none";
  }

  return request.sender_user_id === viewerUserId ? "outgoing_request" : "incoming_request";
}

async function getFriendRequestById(requestId: string) {
  return getFriendRequestByIdFrom(db, requestId);
}

async function getFriendRequestByIdFrom(runner: DbRunner, requestId: string) {
  return (await runner
    .prepare(
      `SELECT friend_requests.id, friend_requests.status, friend_requests.created_at, friend_requests.responded_at,
              sender.id AS sender_id, sender.email AS sender_email, sender.username AS sender_username, sender.is_anonymous AS sender_is_anonymous,
              sender.created_at AS sender_created_at,
              receiver.id AS receiver_id, receiver.email AS receiver_email, receiver.username AS receiver_username, receiver.is_anonymous AS receiver_is_anonymous,
              receiver.created_at AS receiver_created_at
       FROM friend_requests
       JOIN users AS sender ON sender.id = friend_requests.sender_user_id
       JOIN users AS receiver ON receiver.id = friend_requests.receiver_user_id
       WHERE friend_requests.id = ?`
    )
    .get(requestId)) as FriendRequestRow | undefined;
}

async function getGameInviteByIdFrom(runner: DbRunner, inviteId: string) {
  return (await runner
    .prepare(
      `SELECT game_invites.id, game_invites.status, game_invites.created_at, game_invites.responded_at,
              games.id AS game_id, games.code AS game_code, games.status AS game_status, games.public AS public,
              sender.id AS sender_id, sender.email AS sender_email, sender.username AS sender_username, sender.is_anonymous AS sender_is_anonymous,
              sender.created_at AS sender_created_at,
              receiver.id AS receiver_id, receiver.email AS receiver_email, receiver.username AS receiver_username, receiver.is_anonymous AS receiver_is_anonymous,
              receiver.created_at AS receiver_created_at,
              host_players.user_id AS host_user_id, host_players.username AS host_username
       FROM game_invites
       JOIN games ON games.id = game_invites.game_id
       JOIN users AS sender ON sender.id = game_invites.sender_user_id
       JOIN users AS receiver ON receiver.id = game_invites.receiver_user_id
       JOIN players AS host_players
         ON host_players.game_id = game_invites.game_id AND host_players.user_id = game_invites.sender_user_id
       WHERE game_invites.id = ?`
    )
    .get(inviteId)) as GameInviteRow | undefined;
}

async function getGameInviteById(inviteId: string) {
  return getGameInviteByIdFrom(db, inviteId);
}

export async function searchUsers(user: AuthUser, queryInput: string): Promise<SocialSearchResult[]> {
  assertRegisteredUser(user);

  const query = queryInput.trim();
  if (query.length < 2) {
    return [];
  }

  const like = `%${query.replace(/[%_]/g, "\\$&")}%`;
  const rows = (await db
    .prepare(
        `SELECT users.id, users.email, users.username, users.is_anonymous, users.created_at
       FROM users
       WHERE users.id != ?
         AND users.is_anonymous = 0
         AND (
           LOWER(users.username) LIKE LOWER(?) ESCAPE '\\'
           OR LOWER(users.email) LIKE LOWER(?) ESCAPE '\\'
         )
       ORDER BY users.created_at DESC
       LIMIT 10`
    )
    .all(user.id, like, like)) as UserRow[];

  const relationships = await Promise.all(rows.map((row) => getRelationshipForUser(user.id, row.id)));

  return rows.map((row, index) => ({
    ...mapUserSummary(row),
    relationship: relationships[index] ?? "none",
  }));
}

export async function listSocialOverview(user: AuthUser): Promise<SocialOverview> {
  assertRegisteredUser(user);
  await cleanupExpiredWaitingGames();
  await expireInvalidPendingGameInvites();

  const friends = (await db
    .prepare(
      `SELECT friendships.id AS friendship_id, friendships.created_at AS since,
              CASE WHEN friendships.user_one_id = ? THEN other.id ELSE self.id END AS id,
              CASE WHEN friendships.user_one_id = ? THEN other.email ELSE self.email END AS email,
              CASE WHEN friendships.user_one_id = ? THEN other.username ELSE self.username END AS username,
              CASE WHEN friendships.user_one_id = ? THEN other.is_anonymous ELSE self.is_anonymous END AS is_anonymous,
              CASE WHEN friendships.user_one_id = ? THEN other.created_at ELSE self.created_at END AS created_at
       FROM friendships
       JOIN users AS self ON self.id = friendships.user_one_id
       JOIN users AS other ON other.id = friendships.user_two_id
       WHERE friendships.user_one_id = ? OR friendships.user_two_id = ?
       ORDER BY friendships.created_at DESC`
    )
    .all(user.id, user.id, user.id, user.id, user.id, user.id, user.id)) as Array<
    UserRow & { friendship_id: string; since: number }
  >;

  const pendingRequests = (await db
    .prepare(
      `SELECT friend_requests.id, friend_requests.status, friend_requests.created_at, friend_requests.responded_at,
              sender.id AS sender_id, sender.email AS sender_email, sender.username AS sender_username, sender.is_anonymous AS sender_is_anonymous,
              sender.created_at AS sender_created_at,
              receiver.id AS receiver_id, receiver.email AS receiver_email, receiver.username AS receiver_username, receiver.is_anonymous AS receiver_is_anonymous,
              receiver.created_at AS receiver_created_at
       FROM friend_requests
       JOIN users AS sender ON sender.id = friend_requests.sender_user_id
       JOIN users AS receiver ON receiver.id = friend_requests.receiver_user_id
       WHERE friend_requests.status = 'pending'
         AND (friend_requests.sender_user_id = ? OR friend_requests.receiver_user_id = ?)
       ORDER BY friend_requests.created_at DESC`
    )
    .all(user.id, user.id)) as FriendRequestRow[];

  const pendingInvites = (await db
    .prepare(
      `SELECT game_invites.id, game_invites.status, game_invites.created_at, game_invites.responded_at,
              games.id AS game_id, games.code AS game_code, games.status AS game_status, games.public AS public,
              sender.id AS sender_id, sender.email AS sender_email, sender.username AS sender_username, sender.is_anonymous AS sender_is_anonymous,
              sender.created_at AS sender_created_at,
              receiver.id AS receiver_id, receiver.email AS receiver_email, receiver.username AS receiver_username, receiver.is_anonymous AS receiver_is_anonymous,
              receiver.created_at AS receiver_created_at,
              host_players.user_id AS host_user_id, host_players.username AS host_username
       FROM game_invites
       JOIN games ON games.id = game_invites.game_id
       JOIN users AS sender ON sender.id = game_invites.sender_user_id
       JOIN users AS receiver ON receiver.id = game_invites.receiver_user_id
       JOIN players AS host_players
         ON host_players.game_id = game_invites.game_id AND host_players.user_id = game_invites.sender_user_id
       WHERE game_invites.status = 'pending'
         AND (game_invites.sender_user_id = ? OR game_invites.receiver_user_id = ?)
       ORDER BY game_invites.created_at DESC`
    )
    .all(user.id, user.id)) as GameInviteRow[];

  const invitableGames = (await db
    .prepare(
      `SELECT games.id AS game_id, games.code, games.public, games.created_at, games.status
       FROM games
       JOIN players ON players.game_id = games.id AND players.user_id = ?
       WHERE games.status = 'waiting'
         AND (
           SELECT COUNT(*)
           FROM players AS game_players
           WHERE game_players.game_id = games.id
         ) = 1
       ORDER BY games.created_at DESC`
    )
    .all(user.id)) as Array<{
    game_id: string;
    code: string;
    public: number;
    created_at: number;
    status: "waiting";
  }>;

  return {
    friends: friends.map((friend): FriendView => ({
      friendshipId: friend.friendship_id,
      since: friend.since,
      ...mapUserSummary(friend),
    })),
    incomingRequests: pendingRequests
      .filter((request) => request.receiver_id === user.id)
      .map((request) => mapFriendRequest(request, user.id)),
    outgoingRequests: pendingRequests
      .filter((request) => request.sender_id === user.id)
      .map((request) => mapFriendRequest(request, user.id)),
    incomingGameInvites: pendingInvites
      .filter((invite) => invite.receiver_id === user.id)
      .map(mapGameInvite),
    outgoingGameInvites: pendingInvites
      .filter((invite) => invite.sender_id === user.id)
      .map(mapGameInvite),
    invitableGames: invitableGames.map(
      (game): InvitableGameView => ({
        gameId: game.game_id,
        code: game.code,
        public: Boolean(game.public),
        createdAt: game.created_at,
        status: game.status,
      })
    ),
  };
}

export async function sendFriendRequest(user: AuthUser, targetIdentifier: string) {
  assertRegisteredUser(user);

  const sendRequest = db.transaction(async (tx) => {
    const target = await getRegisteredUserByIdentifierFrom(tx, targetIdentifier);
    if (target.id === user.id) {
      throw new Error("You can't send a friend request to yourself.");
    }

    if (await getFriendshipBetweenFrom(tx, user.id, target.id)) {
      throw new Error("You're already friends.");
    }

    const existingPending = await getPendingFriendRequestBetweenFrom(tx, user.id, target.id);
    if (existingPending) {
      if (existingPending.sender_user_id === user.id) {
        throw new Error("Friend request already sent.");
      }

      const acceptedAt = now();
      const updated = await tx
        .prepare(
          `UPDATE friend_requests
           SET status = 'accepted', responded_at = ?, acted_by_user_id = ?
           WHERE id = ? AND status = 'pending'`
        )
        .run(acceptedAt, user.id, existingPending.id);

      if (updated.changes === 0) {
        throw new Error("Friend request not found.");
      }

      await createFriendshipFromRequestWithRunner(
        tx,
        existingPending.id,
        existingPending.sender_user_id,
        existingPending.receiver_user_id
      );

      return {
        requestId: existingPending.id,
        status: "accepted" as const,
        becameFriends: true,
      };
    }

    const requestId = uuid();
    const createdAt = now();
    const { lowUserId, highUserId } = sortPair(user.id, target.id);
    const inserted = await tx
      .prepare(
      `INSERT INTO friend_requests (
          id, sender_user_id, receiver_user_id, pair_low_user_id, pair_high_user_id, status, created_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
        ON CONFLICT(pair_low_user_id, pair_high_user_id) WHERE status = 'pending' DO NOTHING`
      )
      .run(requestId, user.id, target.id, lowUserId, highUserId, createdAt);

    if (inserted.changes === 0) {
      const pending = await getPendingFriendRequestBetweenFrom(tx, user.id, target.id);
      if (!pending) {
        throw new Error("Unable to send friend request.");
      }
      if (pending.sender_user_id === user.id) {
        throw new Error("Friend request already sent.");
      }

      const acceptedAt = now();
      const updated = await tx
        .prepare(
          `UPDATE friend_requests
           SET status = 'accepted', responded_at = ?, acted_by_user_id = ?
           WHERE id = ? AND status = 'pending'`
        )
        .run(acceptedAt, user.id, pending.id);

      if (updated.changes === 0) {
        throw new Error("Friend request not found.");
      }

      await createFriendshipFromRequestWithRunner(tx, pending.id, pending.sender_user_id, pending.receiver_user_id);

      return {
        requestId: pending.id,
        status: "accepted" as const,
        becameFriends: true,
      };
    }

    return {
      requestId,
      status: "pending" as const,
      becameFriends: false,
    };
  });

  return await sendRequest();
}

export async function acceptFriendRequest(user: AuthUser, requestId: string) {
  assertRegisteredUser(user);

  const acceptRequest = db.transaction(async (tx) => {
    const request = await getFriendRequestByIdFrom(tx, requestId);
    if (!request || request.status !== "pending") {
      throw new Error("Friend request not found.");
    }
    if (request.receiver_id !== user.id) {
      throw new Error("You can only accept requests sent to you.");
    }

    const updated = await tx.prepare(
      `UPDATE friend_requests
       SET status = 'accepted', responded_at = ?, acted_by_user_id = ?
       WHERE id = ? AND status = 'pending'`
    ).run(now(), user.id, request.id);

    if (updated.changes === 0) {
      throw new Error("Friend request not found.");
    }

    await createFriendshipFromRequestWithRunner(tx, request.id, request.sender_id, request.receiver_id);
  });

  await acceptRequest();

  return { ok: true as const };
}

export async function declineFriendRequest(user: AuthUser, requestId: string) {
  assertRegisteredUser(user);

  const declineRequest = db.transaction(async (tx) => {
    const request = await getFriendRequestByIdFrom(tx, requestId);
    if (!request || request.status !== "pending") {
      throw new Error("Friend request not found.");
    }
    if (request.receiver_id !== user.id) {
      throw new Error("You can only decline requests sent to you.");
    }

    const updated = await tx
      .prepare(
        `UPDATE friend_requests
         SET status = 'declined', responded_at = ?, acted_by_user_id = ?
         WHERE id = ? AND status = 'pending'`
      )
      .run(now(), user.id, request.id);

    if (updated.changes === 0) {
      throw new Error("Friend request not found.");
    }
  });

  await declineRequest();

  return { ok: true as const };
}

export async function cancelFriendRequest(user: AuthUser, requestId: string) {
  assertRegisteredUser(user);

  const cancelRequest = db.transaction(async (tx) => {
    const request = await getFriendRequestByIdFrom(tx, requestId);
    if (!request || request.status !== "pending") {
      throw new Error("Friend request not found.");
    }
    if (request.sender_id !== user.id) {
      throw new Error("You can only cancel requests you sent.");
    }

    const updated = await tx
      .prepare(
        `UPDATE friend_requests
         SET status = 'canceled', responded_at = ?, acted_by_user_id = ?
         WHERE id = ? AND status = 'pending'`
      )
      .run(now(), user.id, request.id);

    if (updated.changes === 0) {
      throw new Error("Friend request not found.");
    }
  });

  await cancelRequest();

  return { ok: true as const };
}

export async function removeFriend(user: AuthUser, friendUserId: string) {
  assertRegisteredUser(user);

  const removeRelationship = db.transaction(async (tx) => {
    const friend = await getRegisteredUserByIdentifierFrom(tx, friendUserId);
    if (friend.id === user.id) {
      throw new Error("You can't remove yourself.");
    }

    const { lowUserId, highUserId } = sortPair(user.id, friend.id);
    const friendship = await getFriendshipBetweenFrom(tx, lowUserId, highUserId);
    if (!friendship) {
      throw new Error("Friend not found.");
    }

    const removed = await tx.prepare(`DELETE FROM friendships WHERE id = ?`).run(friendship.id);
    if (removed.changes === 0) {
      throw new Error("Friend not found.");
    }

    await tx
      .prepare(
        `UPDATE game_invites
         SET status = 'canceled', responded_at = ?
         WHERE status = 'pending'
           AND (
             (sender_user_id = ? AND receiver_user_id = ?)
             OR (sender_user_id = ? AND receiver_user_id = ?)
           )`
      )
      .run(now(), user.id, friend.id, friend.id, user.id);
  });

  await removeRelationship();

  return { ok: true as const };
}

export async function sendGameInvite(user: AuthUser, gameId: string, receiverUserId: string) {
  assertRegisteredUser(user);
  await cleanupExpiredWaitingGames();
  await expireInvalidPendingGameInvites();

  if (!gameId.trim()) {
    throw new Error("Choose a waiting game to invite a friend to.");
  }

  const createInvite = db.transaction(async (tx) => {
    const receiver = await getRegisteredUserByIdentifierFrom(tx, receiverUserId);
    if (receiver.id === user.id) {
      throw new Error("You can't invite yourself.");
    }

    await ensureUsersAreFriendsFrom(tx, user.id, receiver.id);

    const game = (await tx
      .prepare(
        `SELECT games.id, games.code, games.status
         FROM games
         JOIN players ON players.game_id = games.id AND players.user_id = ?
         WHERE games.id = ?`
      )
      .get(user.id, gameId)) as { id: string; code: string; status: GameStatus } | undefined;

    if (!game) {
      throw new Error("Waiting game not found.");
    }
    if (game.status !== "waiting") {
      throw new Error("Only waiting games can be invited to friends.");
    }

    const playerCount = (await tx
      .prepare(`SELECT COUNT(*) AS count FROM players WHERE game_id = ?`)
      .get(game.id)) as { count: number };
    if (playerCount.count !== 1) {
      throw new Error("This lobby is no longer available for invitations.");
    }

    const inviteId = uuid();
    const inserted = await tx
      .prepare(
      `INSERT INTO game_invites (
          id, game_id, sender_user_id, receiver_user_id, status, created_at
        ) VALUES (?, ?, ?, ?, 'pending', ?)
        ON CONFLICT(game_id, receiver_user_id) WHERE status = 'pending' DO NOTHING`
      )
      .run(inviteId, game.id, user.id, receiver.id, now());

    if (inserted.changes === 0) {
      throw new Error("Invite already sent for this game.");
    }

    return inviteId;
  });

  const inviteId = await createInvite();

  return { inviteId };
}

export async function cancelGameInvite(user: AuthUser, inviteId: string) {
  assertRegisteredUser(user);
  const cancelInvite = db.transaction(async (tx) => {
    const invite = await getGameInviteByIdFrom(tx, inviteId);
    if (!invite || invite.status !== "pending") {
      throw new Error("Game invite not found.");
    }
    if (invite.sender_id !== user.id) {
      throw new Error("You can only cancel invites you sent.");
    }

    const updated = await tx
      .prepare(
        `UPDATE game_invites
         SET status = 'canceled', responded_at = ?
         WHERE id = ? AND status = 'pending'`
      )
      .run(now(), invite.id);

    if (updated.changes === 0) {
      throw new Error("Game invite not found.");
    }
  });

  await cancelInvite();

  return { ok: true as const };
}

export async function declineGameInvite(user: AuthUser, inviteId: string) {
  assertRegisteredUser(user);
  const declineInvite = db.transaction(async (tx) => {
    const invite = await getGameInviteByIdFrom(tx, inviteId);
    if (!invite || invite.status !== "pending") {
      throw new Error("Game invite not found.");
    }
    if (invite.receiver_id !== user.id) {
      throw new Error("You can only decline invites sent to you.");
    }

    const updated = await tx
      .prepare(
        `UPDATE game_invites
         SET status = 'declined', responded_at = ?
         WHERE id = ? AND status = 'pending'`
      )
      .run(now(), invite.id);

    if (updated.changes === 0) {
      throw new Error("Game invite not found.");
    }
  });

  await declineInvite();

  return { ok: true as const };
}

export async function acceptGameInvite(
  user: AuthUser,
  inviteId: string,
  usernameInput: string,
  secretWordInput: string
){
  assertRegisteredUser(user);
  await cleanupExpiredWaitingGames();
  await expireInvalidPendingGameInvites();

  let joinedGameId = "";
  const acceptInvite = db.transaction(async (tx) => {
    const invite = await getGameInviteByIdFrom(tx, inviteId);
    if (!invite || invite.status !== "pending") {
      throw new Error("Game invite not found.");
    }
    if (invite.receiver_id !== user.id) {
      throw new Error("You can only accept invites sent to you.");
    }

    await ensureUsersAreFriendsFrom(tx, invite.sender_id, invite.receiver_id);

    const game = (await tx
      .prepare(`SELECT id, status, created_at FROM games WHERE id = ?`)
      .get(invite.game_id)) as
      | { id: string; status: "waiting" | "active" | "completed"; created_at: number }
      | undefined;

    if (!game || isWaitingGameExpired({ status: game.status, createdAt: game.created_at })) {
      throw new Error("Waiting game not found.");
    }

    const username = sanitizeUsername(usernameInput);
    const secretWord = normalizeWord(secretWordInput);

    if (!isValidUsername(username)) {
      throw new Error("Username must be 2-20 characters and only use letters, numbers, spaces, hyphens, or underscores.");
    }

    assertValidDictionaryWord(secretWord, 5);

    const createdAt = now();
    const playerId = uuid();
    const joinResult = await performJoinWaitingGameWithRunner(tx, {
      game,
      user,
      username,
      secretWord,
      createdAt,
      playerId,
    });
    joinedGameId = joinResult.gameId;

    const accepted = await tx
      .prepare(
        `UPDATE game_invites
         SET status = 'accepted', responded_at = ?
         WHERE id = ? AND status = 'pending'`
      )
      .run(now(), invite.id);

    if (accepted.changes === 0) {
      throw new Error("Game invite not found.");
    }

    await tx.prepare(
      `UPDATE game_invites
       SET status = 'expired', responded_at = ?
       WHERE game_id = ? AND id != ? AND status = 'pending'`
    ).run(now(), invite.game_id, invite.id);
  });

  try {
    await acceptInvite();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to accept invite.";
    if (/game not found|waiting game not found|already started|game is full/i.test(message)) {
      await db
        .prepare(
          `UPDATE game_invites
           SET status = 'expired', responded_at = ?
           WHERE id = ? AND status = 'pending'`
        )
        .run(now(), inviteId);
    }
    throw error;
  }

  return { gameId: joinedGameId };
}

export function createSocialRouter() {
  const router = Router();

  function statusForRouteError(message: string) {
    return message === "You must be signed in." ? 401 : 400;
  }

  function handleRoute(
    handler: (req: Request, res: Response) => void | Promise<void>
  ) {
    return async (req: Request, res: Response) => {
      try {
        await handler(req, res);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Request failed.";
        res.status(statusForRouteError(message)).json({
          error: message,
        });
      }
    };
  }

  router.get(
    "/",
    handleRoute(async (req, res) => {
      const user = await requireUser(req);
      res.json({ social: await listSocialOverview(user) });
    })
  );

  router.get(
    "/search",
    handleRoute(async (req, res) => {
      const user = await requireUser(req);
      const query = typeof req.query.q === "string" ? req.query.q : "";
      res.json({ results: await searchUsers(user, query) });
    })
  );

  router.post(
    "/requests",
    handleRoute(async (req, res) => {
      const user = await requireUser(req);
      res.json(await sendFriendRequest(user, req.body.targetIdentifier ?? req.body.targetUserId ?? req.body.targetUsername ?? ""));
    })
  );

  router.post(
    "/requests/:requestId/accept",
    handleRoute(async (req, res) => {
      const user = await requireUser(req);
      res.json(await acceptFriendRequest(user, getParam(req.params.requestId)));
    })
  );

  router.post(
    "/requests/:requestId/decline",
    handleRoute(async (req, res) => {
      const user = await requireUser(req);
      res.json(await declineFriendRequest(user, getParam(req.params.requestId)));
    })
  );

  router.post(
    "/requests/:requestId/cancel",
    handleRoute(async (req, res) => {
      const user = await requireUser(req);
      res.json(await cancelFriendRequest(user, getParam(req.params.requestId)));
    })
  );

  router.delete(
    "/friends/:friendUserId",
    handleRoute(async (req, res) => {
      const user = await requireUser(req);
      res.json(await removeFriend(user, getParam(req.params.friendUserId)));
    })
  );

  router.post(
    "/game-invites",
    handleRoute(async (req, res) => {
      const user = await requireUser(req);
      res.json(await sendGameInvite(user, req.body.gameId ?? "", req.body.receiverUserId ?? ""));
    })
  );

  router.post(
    "/game-invites/:inviteId/accept",
    handleRoute(async (req, res) => {
      const user = await requireUser(req);
      res.json(
        await acceptGameInvite(
          user,
          getParam(req.params.inviteId),
          req.body.username ?? "",
          req.body.secretWord ?? ""
        )
      );
    })
  );

  router.post(
    "/game-invites/:inviteId/decline",
    handleRoute(async (req, res) => {
      const user = await requireUser(req);
      res.json(await declineGameInvite(user, getParam(req.params.inviteId)));
    })
  );

  router.post(
    "/game-invites/:inviteId/cancel",
    handleRoute(async (req, res) => {
      const user = await requireUser(req);
      res.json(await cancelGameInvite(user, getParam(req.params.inviteId)));
    })
  );

  return router;
}
