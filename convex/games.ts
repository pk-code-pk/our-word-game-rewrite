import { v } from "convex/values";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";
import {
  buildGameStateView,
  calculateMatchCount,
  createEmptyAlphabet,
  GAME_CODE_ALPHABET,
  generateGameCode,
  getChatModerationError,
  getChatRateLimitError,
  isValidUsername,
  isWaitingGameExpired,
  normalizeWord,
  pushRecentResult,
  sanitizeChatText,
  sanitizeUsername,
} from "./gameLogic";

const guessValidator = v.object({
  _id: v.id("guesses"),
  playerId: v.id("players"),
  type: v.union(v.literal("fourLetter"), v.literal("fullWord")),
  text: v.string(),
  matchCount: v.number(),
  isCorrect: v.boolean(),
  guessNumber: v.number(),
});

const alphabetValidator = v.record(
  v.string(),
  v.union(v.literal("present"), v.literal("absent"), v.literal("unknown"))
);

const gameStateValidator = v.union(
  v.null(),
  v.object({
    game: v.object({
      _id: v.id("games"),
      code: v.string(),
      status: v.union(v.literal("waiting"), v.literal("active"), v.literal("completed")),
      public: v.boolean(),
      createdAt: v.number(),
      lastActivityAt: v.number(),
      completedAt: v.optional(v.number()),
      winnerId: v.optional(v.string()),
    }),
    me: v.object({
      _id: v.id("players"),
      username: v.string(),
      alphabet: alphabetValidator,
      totalGuesses: v.number(),
      secretWord: v.optional(v.string()),
    }),
    opponent: v.union(
      v.null(),
      v.object({
        _id: v.id("players"),
        username: v.string(),
        totalGuesses: v.number(),
        secretWord: v.optional(v.string()),
      })
    ),
    myGuesses: v.array(guessValidator),
    opponentGuesses: v.array(guessValidator),
    canChat: v.boolean(),
  })
);

const playerGameSummaryValidator = v.object({
  gameId: v.id("games"),
  code: v.string(),
  status: v.union(v.literal("waiting"), v.literal("active"), v.literal("completed")),
  public: v.boolean(),
  createdAt: v.number(),
  lastActivityAt: v.number(),
  completedAt: v.optional(v.number()),
  opponentName: v.optional(v.string()),
  isMyTurnToWait: v.boolean(),
  isExpired: v.boolean(),
});

async function requireUserId(ctx: any): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) {
    throw new Error("You must be signed in to play.");
  }
  return userId;
}

async function requirePlayerInGame(
  ctx: any,
  gameId: Id<"games">,
  userId: Id<"users">
) {
  const players = await ctx.db
    .query("players")
    .withIndex("by_game", (q: any) => q.eq("gameId", gameId))
    .collect();

  const player = players.find((entry: { userId?: Id<"users"> }) => entry.userId === userId);
  if (!player) {
    throw new Error("You are not a participant in this game.");
  }

  return { player, players };
}

async function assertValidDictionaryWord(
  ctx: any,
  word: string,
  expectedLength?: 4 | 5
) {
  if (expectedLength && word.length !== expectedLength) {
    throw new Error(`Word must be exactly ${expectedLength} letters long.`);
  }

  const isValid = await ctx.runAction(internal.dictionary.validateWord, { word });
  if (!isValid) {
    throw new Error("Word must be a real built-in dictionary word with no duplicate letters.");
  }
}

async function reserveUniqueCode(ctx: any): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = generateGameCode();
    const existing = await ctx.runQuery(internal.games.findGameByCode, { code });
    if (!existing) {
      return code;
    }
  }

  throw new Error(`Unable to generate a unique game code from ${GAME_CODE_ALPHABET.length} symbols.`);
}

function encodeSecretWord(secretWord: string): string {
  return btoa(secretWord);
}

export const findGameByCode = internalQuery({
  args: { code: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id("games"),
      _creationTime: v.number(),
      code: v.string(),
      mode: v.union(v.literal("pvp"), v.literal("vs_ai")),
      status: v.union(v.literal("waiting"), v.literal("active"), v.literal("completed")),
      public: v.boolean(),
      winnerId: v.optional(v.string()),
      createdAt: v.number(),
      lastActivityAt: v.optional(v.number()),
      completedAt: v.optional(v.number()),
      rematchOf: v.optional(v.id("games")),
    })
  ),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("games")
      .withIndex("by_code", (q) => q.eq("code", args.code))
      .first();
  },
});

export const cleanupExpiredWaitingGames = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now();
    let deletedCount = 0;

    for await (const game of ctx.db
      .query("games")
      .withIndex("by_status", (q) => q.eq("status", "waiting"))) {
      if (!isWaitingGameExpired(game, now)) {
        continue;
      }

      const players = await ctx.db
        .query("players")
        .withIndex("by_game", (q) => q.eq("gameId", game._id))
        .collect();
      const guesses = await ctx.db
        .query("guesses")
        .withIndex("by_game", (q) => q.eq("gameId", game._id))
        .collect();
      const messages = await ctx.db
        .query("chatMessages")
        .withIndex("by_game_and_createdAt", (q) => q.eq("gameId", game._id))
        .collect();

      for (const guess of guesses) {
        await ctx.db.delete(guess._id);
      }
      for (const message of messages) {
        await ctx.db.delete(message._id);
      }
      for (const player of players) {
        await ctx.db.delete(player._id);
      }
      await ctx.db.delete(game._id);
      deletedCount += 1;
    }

    return deletedCount;
  },
});

export const cleanupExpiredGames = action({
  args: {},
  returns: v.number(),
  handler: async (ctx): Promise<number> => {
    return await ctx.runMutation(internal.games.cleanupExpiredWaitingGames, {});
  },
});

export const checkWordUsed = internalQuery({
  args: {
    userId: v.id("users"),
    word: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const usedWord = await ctx.db
      .query("usedWords")
      .withIndex("by_user_and_word", (q) =>
        q.eq("userId", args.userId).eq("word", args.word.toUpperCase())
      )
      .first();

    return usedWord !== null;
  },
});

export const checkIfWordUsed = action({
  args: {
    word: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const userId = await requireUserId(ctx);
    return await ctx.runQuery(internal.games.checkWordUsed, {
      userId,
      word: normalizeWord(args.word),
    });
  },
});

export const createGame = action({
  args: {
    username: v.string(),
    secretWord: v.string(),
    public: v.optional(v.boolean()),
  },
  returns: v.object({
    gameId: v.id("games"),
    code: v.string(),
  }),
  handler: async (ctx, args): Promise<{ gameId: Id<"games">; code: string }> => {
    await ctx.runMutation(internal.games.cleanupExpiredWaitingGames, {});

    const userId = await requireUserId(ctx);
    const username = sanitizeUsername(args.username);
    const secretWord = normalizeWord(args.secretWord);

    if (!isValidUsername(username)) {
      throw new Error("Username must be 2-20 characters and only use letters, numbers, spaces, hyphens, or underscores.");
    }

    const hasUsedWord = await ctx.runQuery(internal.games.checkWordUsed, {
      userId,
      word: secretWord,
    });
    if (hasUsedWord) {
      throw new Error("You've already used this word before. Please pick a different secret word.");
    }

    await assertValidDictionaryWord(ctx, secretWord, 5);

    const code = await reserveUniqueCode(ctx);
    const result: { gameId: Id<"games">; code: string } = await ctx.runMutation(internal.games.createGameMutation, {
      code,
      secretWord,
      username,
      userId,
      public: args.public ?? false,
    });

    return {
      gameId: result.gameId,
      code: result.code,
    };
  },
});

export const createGameMutation = internalMutation({
  args: {
    code: v.string(),
    secretWord: v.string(),
    username: v.string(),
    userId: v.id("users"),
    public: v.boolean(),
  },
  returns: v.object({
    gameId: v.id("games"),
    code: v.string(),
  }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const gameId = await ctx.db.insert("games", {
      code: args.code,
      mode: "pvp",
      status: "waiting",
      public: args.public,
      createdAt: now,
      lastActivityAt: now,
    });

    await ctx.db.insert("players", {
      gameId,
      userId: args.userId,
      username: args.username,
      secretWordHash: encodeSecretWord(args.secretWord),
      secretWord: args.secretWord,
      alphabet: createEmptyAlphabet(),
      totalGuesses: 0,
    });

    await ctx.db.insert("usedWords", {
      userId: args.userId,
      word: args.secretWord,
      usedAt: now,
    });

    return { gameId, code: args.code };
  },
});

export const joinGame = action({
  args: {
    code: v.string(),
    username: v.string(),
    secretWord: v.string(),
  },
  returns: v.object({
    gameId: v.id("games"),
  }),
  handler: async (ctx, args): Promise<{ gameId: Id<"games"> }> => {
    await ctx.runMutation(internal.games.cleanupExpiredWaitingGames, {});

    const userId = await requireUserId(ctx);
    const username = sanitizeUsername(args.username);
    const secretWord = normalizeWord(args.secretWord);
    const code = normalizeWord(args.code);

    if (!isValidUsername(username)) {
      throw new Error("Username must be 2-20 characters and only use letters, numbers, spaces, hyphens, or underscores.");
    }

    const hasUsedWord = await ctx.runQuery(internal.games.checkWordUsed, {
      userId,
      word: secretWord,
    });
    if (hasUsedWord) {
      throw new Error("You've already used this word before. Please pick a different secret word.");
    }

    await assertValidDictionaryWord(ctx, secretWord, 5);

    return await ctx.runMutation(internal.games.joinGameMutation, {
      code,
      username,
      secretWord,
      userId,
    });
  },
});

export const joinGameMutation = internalMutation({
  args: {
    code: v.string(),
    username: v.string(),
    secretWord: v.string(),
    userId: v.id("users"),
  },
  returns: v.object({
    gameId: v.id("games"),
  }),
  handler: async (ctx, args) => {
    const game = await ctx.db
      .query("games")
      .withIndex("by_code", (q) => q.eq("code", args.code))
      .first();

    if (!game || isWaitingGameExpired(game)) {
      throw new Error("Game not found.");
    }

    if (game.status !== "waiting") {
      throw new Error("Game already started or completed.");
    }

    const players = await ctx.db
      .query("players")
      .withIndex("by_game", (q) => q.eq("gameId", game._id))
      .collect();

    if (players.some((player) => player.userId === args.userId)) {
      throw new Error("You can't join your own game from the same account.");
    }

    if (players.length >= 2) {
      throw new Error("Game is full.");
    }

    await ctx.db.insert("players", {
      gameId: game._id,
      userId: args.userId,
      username: args.username,
      secretWordHash: encodeSecretWord(args.secretWord),
      secretWord: args.secretWord,
      alphabet: createEmptyAlphabet(),
      totalGuesses: 0,
    });

    const now = Date.now();
    await ctx.db.insert("usedWords", {
      userId: args.userId,
      word: args.secretWord,
      usedAt: now,
    });

    await ctx.db.patch(game._id, {
      status: "active",
      lastActivityAt: now,
    });

    return { gameId: game._id };
  },
});

export const updateUserStats = internalMutation({
  args: {
    userId: v.id("users"),
    won: v.boolean(),
    guesses: v.number(),
    username: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existingStats = await ctx.db
      .query("userStats")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .first();

    const recentForm = pushRecentResult(existingStats?.recentResults, args.won ? "W" : "L");
    const nextBestWinGuesses = args.won
      ? existingStats?.bestWinGuesses
        ? Math.min(existingStats.bestWinGuesses, args.guesses)
        : args.guesses
      : existingStats?.bestWinGuesses;

    if (existingStats) {
      const currentStreak = existingStats.currentWinStreak ?? 0;
      await ctx.db.patch(existingStats._id, {
        wins: existingStats.wins + (args.won ? 1 : 0),
        losses: existingStats.losses + (args.won ? 0 : 1),
        totalGuesses: existingStats.totalGuesses + args.guesses,
        gamesPlayed: existingStats.gamesPlayed + 1,
        mostRecentUsername: args.username,
        currentWinStreak: args.won ? currentStreak + 1 : 0,
        recentResults: recentForm,
        bestWinGuesses: nextBestWinGuesses,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("userStats", {
        userId: args.userId,
        wins: args.won ? 1 : 0,
        losses: args.won ? 0 : 1,
        totalGuesses: args.guesses,
        gamesPlayed: 1,
        mostRecentUsername: args.username,
        currentWinStreak: args.won ? 1 : 0,
        recentResults: recentForm,
        bestWinGuesses: nextBestWinGuesses,
        updatedAt: Date.now(),
      });
    }

    return null;
  },
});

export const submitGuess = action({
  args: {
    gameId: v.id("games"),
    type: v.union(v.literal("fourLetter"), v.literal("fullWord")),
    text: v.string(),
  },
  returns: v.object({
    matchCount: v.number(),
    isCorrect: v.boolean(),
    guessNumber: v.number(),
    gameStatus: v.union(v.literal("active"), v.literal("completed")),
  }),
  handler: async (ctx, args): Promise<{
    matchCount: number;
    isCorrect: boolean;
    guessNumber: number;
    gameStatus: "active" | "completed";
  }> => {
    const userId = await requireUserId(ctx);
    const text = normalizeWord(args.text);
    await assertValidDictionaryWord(ctx, text, args.type === "fourLetter" ? 4 : 5);

    return await ctx.runMutation(internal.games.submitGuessMutation, {
      gameId: args.gameId,
      userId,
      type: args.type,
      text,
    });
  },
});

export const submitGuessMutation = internalMutation({
  args: {
    gameId: v.id("games"),
    userId: v.id("users"),
    type: v.union(v.literal("fourLetter"), v.literal("fullWord")),
    text: v.string(),
  },
  returns: v.object({
    matchCount: v.number(),
    isCorrect: v.boolean(),
    guessNumber: v.number(),
    gameStatus: v.union(v.literal("active"), v.literal("completed")),
  }),
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game || game.status !== "active") {
      throw new Error("Game is not active.");
    }

    const { player, players } = await requirePlayerInGame(ctx, args.gameId, args.userId);
    const opponent = players.find((entry: { _id: Id<"players"> }) => entry._id !== player._id);
    if (!opponent?.secretWord) {
      throw new Error("Opponent not found.");
    }

    const existingGuesses = await ctx.db
      .query("guesses")
      .withIndex("by_player", (q) => q.eq("playerId", player._id))
      .collect();
    const guessNumber = existingGuesses.length + 1;

    const isCorrect = args.type === "fullWord" && args.text === opponent.secretWord;
    const matchCount =
      args.type === "fullWord"
        ? isCorrect
          ? 5
          : 0
        : calculateMatchCount(args.text, opponent.secretWord);

    await ctx.db.insert("guesses", {
      gameId: args.gameId,
      playerId: player._id,
      type: args.type,
      text: args.text,
      matchCount,
      isCorrect,
      guessNumber,
    });

    const now = Date.now();
    await ctx.db.patch(player._id, {
      totalGuesses: guessNumber,
    });

    if (isCorrect) {
      await ctx.db.patch(args.gameId, {
        status: "completed",
        winnerId: player._id,
        completedAt: now,
        lastActivityAt: now,
      });

      if (player.userId) {
        await ctx.scheduler.runAfter(0, internal.games.updateUserStats, {
          userId: player.userId,
          won: true,
          guesses: guessNumber,
          username: player.username,
        });
      }

      if (opponent.userId) {
        await ctx.scheduler.runAfter(0, internal.games.updateUserStats, {
          userId: opponent.userId,
          won: false,
          guesses: opponent.totalGuesses,
          username: opponent.username,
        });
      }
    } else {
      await ctx.db.patch(args.gameId, {
        lastActivityAt: now,
      });
    }

    const gameStatus: "active" | "completed" = isCorrect ? "completed" : "active";

    return {
      matchCount,
      isCorrect,
      guessNumber,
      gameStatus,
    };
  },
});

export const updateAlphabet = mutation({
  args: {
    gameId: v.id("games"),
    letter: v.string(),
    state: v.union(v.literal("present"), v.literal("absent"), v.literal("unknown")),
  },
  returns: alphabetValidator,
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const { player } = await requirePlayerInGame(ctx, args.gameId, userId);

    const letter = args.letter.trim().toUpperCase();
    if (!/^[A-Z]$/.test(letter)) {
      throw new Error("Please choose a single letter A-Z.");
    }

    const updatedAlphabet = { ...player.alphabet, [letter]: args.state };
    await ctx.db.patch(player._id, { alphabet: updatedAlphabet });

    return updatedAlphabet;
  },
});

export const listPublicLobbies = query({
  args: {},
  returns: v.object({
    openLobbies: v.array(
      v.object({
        code: v.string(),
        host: v.string(),
        createdAt: v.number(),
        players: v.number(),
      })
    ),
    activeGamesCount: v.number(),
    waitingPublicCount: v.number(),
  }),
  handler: async (ctx) => {
    const openLobbies: Array<{
      code: string;
      host: string;
      createdAt: number;
      players: number;
    }> = [];
    const now = Date.now();

    for await (const game of ctx.db
      .query("games")
      .withIndex("by_public_and_status", (q) => q.eq("public", true).eq("status", "waiting"))
      .order("desc")) {
      if (isWaitingGameExpired(game, now)) {
        continue;
      }

      const players = await ctx.db
        .query("players")
        .withIndex("by_game", (q) => q.eq("gameId", game._id))
        .collect();

      if (players.length < 2) {
        openLobbies.push({
          code: game.code,
          host: players[0]?.username ?? "Unknown",
          createdAt: game.createdAt,
          players: players.length,
        });
      }
    }

    let activeGamesCount = 0;
    for await (const _game of ctx.db
      .query("games")
      .withIndex("by_status", (q) => q.eq("status", "active"))) {
      activeGamesCount += 1;
    }

    return {
      openLobbies,
      activeGamesCount,
      waitingPublicCount: openLobbies.length,
    };
  },
});

export const getGameState = query({
  args: { gameId: v.id("games") },
  returns: gameStateValidator,
  handler: async (ctx, args): Promise<
    | null
    | {
        game: {
          _id: Id<"games">;
          code: string;
          status: "waiting" | "active" | "completed";
          public: boolean;
          createdAt: number;
          lastActivityAt: number;
          completedAt?: number;
          winnerId?: string;
        };
        me: {
          _id: Id<"players">;
          username: string;
          alphabet: Record<string, "present" | "absent" | "unknown">;
          totalGuesses: number;
          secretWord?: string;
        };
        opponent:
          | null
          | {
              _id: Id<"players">;
              username: string;
              totalGuesses: number;
              secretWord?: string;
            };
        myGuesses: Array<{
          _id: Id<"guesses">;
          playerId: Id<"players">;
          type: "fourLetter" | "fullWord";
          text: string;
          matchCount: number;
          isCorrect: boolean;
          guessNumber: number;
        }>;
        opponentGuesses: Array<{
          _id: Id<"guesses">;
          playerId: Id<"players">;
          type: "fourLetter" | "fullWord";
          text: string;
          matchCount: number;
          isCorrect: boolean;
          guessNumber: number;
        }>;
        canChat: boolean;
      }
  > => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return null;
    }

    const game = await ctx.db.get(args.gameId);
    if (!game || isWaitingGameExpired(game)) {
      return null;
    }

    const players = await ctx.db
      .query("players")
      .withIndex("by_game", (q) => q.eq("gameId", args.gameId))
      .collect();
    const guesses = await ctx.db
      .query("guesses")
      .withIndex("by_game", (q) => q.eq("gameId", args.gameId))
      .collect();

    const view = buildGameStateView({
      game,
      players,
      guesses,
      viewerUserId: userId,
    });

    if (!view) {
      return null;
    }

    return {
      ...view,
      me: {
        ...view.me,
        _id: view.me._id as Id<"players">,
      },
      opponent: view.opponent
        ? {
            ...view.opponent,
            _id: view.opponent._id as Id<"players">,
          }
        : null,
      myGuesses: view.myGuesses.map((guess) => ({
        ...guess,
        _id: guess._id as Id<"guesses">,
        playerId: guess.playerId as Id<"players">,
      })),
      opponentGuesses: view.opponentGuesses.map((guess) => ({
        ...guess,
        _id: guess._id as Id<"guesses">,
        playerId: guess.playerId as Id<"players">,
      })),
    };
  },
});

export const getPlayerGames = query({
  args: {},
  returns: v.array(playerGameSummaryValidator),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return [];
    }

    const players = await ctx.db
      .query("players")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    const summaries = await Promise.all(
      players.map(async (player) => {
        const game = await ctx.db.get(player.gameId);
        if (!game) {
          return null;
        }

        const isExpired = isWaitingGameExpired(game);
        if (isExpired) {
          return null;
        }

        const gamePlayers = await ctx.db
          .query("players")
          .withIndex("by_game", (q) => q.eq("gameId", player.gameId))
          .collect();
        const opponent = gamePlayers.find((entry) => entry._id !== player._id);

        return {
          gameId: game._id,
          code: game.code,
          status: game.status,
          public: game.public,
          createdAt: game.createdAt,
          lastActivityAt: game.lastActivityAt ?? game.createdAt,
          completedAt: game.completedAt,
          opponentName: opponent?.username,
          isMyTurnToWait: game.status === "waiting",
          isExpired: false,
        };
      })
    );

    return summaries
      .filter((summary): summary is Exclude<typeof summary, null> => summary !== null)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  },
});

export const listChatMessages = query({
  args: { gameId: v.id("games") },
  returns: v.array(
    v.object({
      _id: v.id("chatMessages"),
      _creationTime: v.number(),
      gameId: v.id("games"),
      playerId: v.id("players"),
      username: v.string(),
      text: v.string(),
      createdAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return [];
    }

    try {
      await requirePlayerInGame(ctx, args.gameId, userId);
    } catch {
      return [];
    }

    return await ctx.db
      .query("chatMessages")
      .withIndex("by_game_and_createdAt", (q) => q.eq("gameId", args.gameId))
      .order("asc")
      .take(100);
  },
});

export const sendChatMessage = mutation({
  args: {
    gameId: v.id("games"),
    text: v.string(),
  },
  returns: v.object({
    messageId: v.id("chatMessages"),
  }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const game = await ctx.db.get(args.gameId);
    if (!game || game.status !== "active") {
      throw new Error("Chat is only available during active games.");
    }

    const { player } = await requirePlayerInGame(ctx, args.gameId, userId);
    const text = sanitizeChatText(args.text);
    const moderationError = getChatModerationError(text);
    if (moderationError) {
      throw new Error(moderationError);
    }

    const recentMessages = await ctx.db
      .query("chatMessages")
      .withIndex("by_game_and_createdAt", (q) => q.eq("gameId", args.gameId))
      .order("desc")
      .take(25);
    const recentOwnMessageTimes = recentMessages
      .filter((message) => message.playerId === player._id)
      .map((message) => message.createdAt);
    const rateLimitError = getChatRateLimitError(recentOwnMessageTimes);
    if (rateLimitError) {
      throw new Error(rateLimitError);
    }

    const now = Date.now();
    const messageId = await ctx.db.insert("chatMessages", {
      gameId: args.gameId,
      playerId: player._id,
      username: player.username,
      text,
      createdAt: now,
    });

    await ctx.db.patch(args.gameId, {
      lastActivityAt: now,
    });

    return { messageId };
  },
});

export const getLeaderboard = query({
  args: {},
  returns: v.array(
    v.object({
      username: v.string(),
      wins: v.number(),
      averageGuessesPerWin: v.number(),
      gamesPlayed: v.number(),
      currentWinStreak: v.number(),
      winRate: v.number(),
      bestWinGuesses: v.optional(v.number()),
      recentResults: v.array(v.union(v.literal("W"), v.literal("L"))),
    })
  ),
  handler: async (ctx) => {
    const allStats = await ctx.db
      .query("userStats")
      .withIndex("by_wins")
      .order("desc")
      .take(10);

    return allStats.map((stat) => ({
      username: stat.mostRecentUsername,
      wins: stat.wins,
      averageGuessesPerWin: stat.wins > 0 ? Math.round((stat.totalGuesses / stat.wins) * 10) / 10 : 0,
      gamesPlayed: stat.gamesPlayed,
      currentWinStreak: stat.currentWinStreak ?? 0,
      winRate: stat.gamesPlayed > 0 ? Math.round((stat.wins / stat.gamesPlayed) * 100) : 0,
      bestWinGuesses: stat.bestWinGuesses,
      recentResults: stat.recentResults ?? [],
    }));
  },
});
