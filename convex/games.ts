import { v } from "convex/values";
import { query, mutation, action, internalMutation, internalQuery } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";

// Generate a random 6-character game code
function generateGameCode(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Hash a secret word for storage
async function hashSecretWord(word: string): Promise<string> {
  // Simple hash for demo - in production use proper bcrypt
  return btoa(word + "salt");
}

// Calculate letter overlap between guess and secret
function calculateMatchCount(guess: string, secret: string): number {
  const guessLetters = new Set(guess.toLowerCase());
  const secretLetters = new Set(secret.toLowerCase());
  const intersection = new Set([...guessLetters].filter(x => secretLetters.has(x)));
  return intersection.size;
}

export const createGame = action({
  args: {
    username: v.string(),
    secretWord: v.string(),
    public: v.optional(v.boolean()),
    mode: v.optional(v.union(v.literal("pvp"), v.literal("vs_ai"))),
    difficulty: v.optional(v.union(v.literal("easy"), v.literal("standard"), v.literal("hard"))),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    
    // Validate secret word
    const isValid = await ctx.runAction(internal.dictionary.validateWord, { 
      word: args.secretWord 
    });
    if (!isValid) {
      throw new Error("Invalid secret word - must be a real English word with no duplicate letters");
    }

    const code = generateGameCode();
    const secretHash = await hashSecretWord(args.secretWord);
    
    const result: { gameId: string; playerId: string; code: string } = await ctx.runMutation(internal.games.createGameMutation, {
      code,
      mode: args.mode || "pvp",
      secretHash,
      secretWord: args.secretWord,
      username: args.username,
      userId: userId || undefined,
      public: args.public || false,
      difficulty: args.difficulty,
    });

    return result;
  },
});

export const createGameMutation = internalMutation({
  args: {
    code: v.string(),
    mode: v.union(v.literal("pvp"), v.literal("vs_ai")),
    secretHash: v.string(),
    secretWord: v.string(),
    username: v.string(),
    userId: v.optional(v.id("users")),
    public: v.boolean(),
    difficulty: v.optional(v.union(v.literal("easy"), v.literal("standard"), v.literal("hard"))),
  },
  handler: async (ctx, args) => {
    const gameId = await ctx.db.insert("games", {
      code: args.code,
      mode: args.mode,
      status: "waiting",
      public: args.public,
      createdAt: Date.now(),
    });

    // Create alphabet state (all letters unknown initially)
    const alphabet: Record<string, "present" | "absent" | "unknown"> = {};
    for (let i = 65; i <= 90; i++) {
      alphabet[String.fromCharCode(i)] = "unknown";
    }

    const playerId = await ctx.db.insert("players", {
      gameId,
      userId: args.userId,
      username: args.username,
      isAI: false,
      secretWordHash: args.secretHash,
      secretWord: args.secretWord, // Store actual word for demo
      alphabet,
      totalGuesses: 0,
    });

    // If vs AI mode, create AI player
    if (args.mode === "vs_ai") {
      await ctx.scheduler.runAfter(0, internal.ai.createAIPlayer, {
        gameId,
        difficulty: args.difficulty || "standard",
      });
    }

    return { gameId, playerId, code: args.code };
  },
});

export const joinGame = action({
  args: {
    code: v.string(),
    username: v.string(),
    secretWord: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    
    // Validate secret word
    const isValid = await ctx.runAction(internal.dictionary.validateWord, { 
      word: args.secretWord 
    });
    if (!isValid) {
      throw new Error("Invalid secret word - must be a real English word with no duplicate letters");
    }

    const result: { gameId: string; playerId: string } = await ctx.runMutation(internal.games.joinGameMutation, {
      code: args.code,
      username: args.username,
      secretWord: args.secretWord,
      userId: userId || undefined,
    });

    return result;
  },
});

export const joinGameMutation = internalMutation({
  args: {
    code: v.string(),
    username: v.string(),
    secretWord: v.string(),
    userId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db
      .query("games")
      .withIndex("by_code", (q) => q.eq("code", args.code))
      .unique();
    
    if (!game) {
      throw new Error("Game not found");
    }

    if (game.status !== "waiting") {
      throw new Error("Game already started or completed");
    }

    // Check if game is full
    const players = await ctx.db
      .query("players")
      .withIndex("by_game", (q) => q.eq("gameId", game._id))
      .collect();
    
    if (players.length >= 2) {
      throw new Error("Game is full");
    }

    const secretHash = await hashSecretWord(args.secretWord);
    
    // Create alphabet state
    const alphabet: Record<string, "present" | "absent" | "unknown"> = {};
    for (let i = 65; i <= 90; i++) {
      alphabet[String.fromCharCode(i)] = "unknown";
    }

    const playerId = await ctx.db.insert("players", {
      gameId: game._id,
      userId: args.userId,
      username: args.username,
      isAI: false,
      secretWordHash: secretHash,
      secretWord: args.secretWord, // Store actual word for demo
      alphabet,
      totalGuesses: 0,
    });

    // Start the game if we now have 2 players
    const updatedPlayers = await ctx.db
      .query("players")
      .withIndex("by_game", (q) => q.eq("gameId", game._id))
      .collect();
    
    if (updatedPlayers.length === 2) {
      await ctx.db.patch(game._id, { status: "active" });
    }

    return { gameId: game._id, playerId };
  },
});

export const submitGuess = action({
  args: {
    gameId: v.id("games"),
    playerId: v.id("players"),
    type: v.union(v.literal("fourLetter"), v.literal("fullWord")),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    // Validate guess word
    const isValid = await ctx.runAction(internal.dictionary.validateWord, { 
      word: args.text 
    });
    if (!isValid) {
      throw new Error("Invalid guess word - must be a real English word with no duplicate letters");
    }

    const result: { matchCount: number; isCorrect: boolean; guessNumber: number; gameStatus: string } = await ctx.runMutation(internal.games.submitGuessMutation, {
      gameId: args.gameId,
      playerId: args.playerId,
      type: args.type,
      text: args.text,
    });

    return result;
  },
});

export const submitGuessMutation = internalMutation({
  args: {
    gameId: v.id("games"),
    playerId: v.id("players"),
    type: v.union(v.literal("fourLetter"), v.literal("fullWord")),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game || game.status !== "active") {
      throw new Error("Game not active");
    }

    const player = await ctx.db.get(args.playerId);
    if (!player) {
      throw new Error("Player not found");
    }

    // Get opponent to calculate match count
    const opponent = await ctx.db
      .query("players")
      .withIndex("by_game", (q) => q.eq("gameId", args.gameId))
      .filter((q) => q.neq(q.field("_id"), args.playerId))
      .first();
    
    if (!opponent) {
      throw new Error("Opponent not found");
    }

    // For demo, we'll decode the hash to get the secret word
    // In production, this would be handled more securely
    const opponentSecret: string = await ctx.runQuery(internal.games.getSecretWordForPlayer, {
      playerId: opponent._id
    });

    let matchCount: number;
    let isCorrect: boolean;
    
    if (args.type === "fullWord") {
      // For full word guesses, only check if it's exactly correct
      isCorrect = args.text.toLowerCase() === opponentSecret.toLowerCase();
      matchCount = isCorrect ? 5 : 0; // Either all letters match or none
    } else {
      // For 4-letter guesses, calculate letter overlap
      matchCount = calculateMatchCount(args.text, opponentSecret);
      isCorrect = false; // 4-letter guesses can't win the game
    }

    // Get current guess count for this player
    const existingGuesses = await ctx.db
      .query("guesses")
      .withIndex("by_player", (q) => q.eq("playerId", args.playerId))
      .collect();

    const guessNumber = existingGuesses.length + 1;

    await ctx.db.insert("guesses", {
      gameId: args.gameId,
      playerId: args.playerId,
      type: args.type,
      text: args.text,
      matchCount,
      isCorrect,
      guessNumber,
    });

    // Update player's total guess count
    await ctx.db.patch(args.playerId, {
      totalGuesses: guessNumber,
    });

    // Check if game is won
    if (isCorrect) {
      await ctx.db.patch(args.gameId, {
        status: "completed",
        winnerId: args.playerId,
      });
    }

    // If vs AI, trigger AI response
    if (game.mode === "vs_ai" && opponent.isAI && !isCorrect) {
      await ctx.scheduler.runAfter(1000, internal.ai.makeAIGuess, {
        gameId: args.gameId,
        aiPlayerId: opponent._id,
      });
    }

    return {
      matchCount,
      isCorrect,
      guessNumber,
      gameStatus: isCorrect ? "completed" : "active",
    };
  },
});

export const updateAlphabet = mutation({
  args: {
    playerId: v.id("players"),
    letter: v.string(),
    state: v.union(v.literal("present"), v.literal("absent"), v.literal("unknown")),
  },
  handler: async (ctx, args) => {
    const player = await ctx.db.get(args.playerId);
    if (!player) {
      throw new Error("Player not found");
    }

    const updatedAlphabet = { ...player.alphabet };
    updatedAlphabet[args.letter.toUpperCase()] = args.state;

    await ctx.db.patch(args.playerId, {
      alphabet: updatedAlphabet,
    });

    return updatedAlphabet;
  },
});

export const getGameState = query({
  args: { gameId: v.id("games") },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game) return null;

    const players = await ctx.db
      .query("players")
      .withIndex("by_game", (q) => q.eq("gameId", args.gameId))
      .collect();

    const guesses = await ctx.db
      .query("guesses")
      .withIndex("by_game", (q) => q.eq("gameId", args.gameId))
      .collect();

    return {
      game,
      players,
      guesses,
    };
  },
});

export const getPlayerGames = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const players = await ctx.db
      .query("players")
      .filter((q) => q.eq(q.field("userId"), userId))
      .collect();

    const games = await Promise.all(
      players.map(async (player) => {
        const game = await ctx.db.get(player.gameId);
        return { game, player };
      })
    );

    return games.filter(({ game }) => game !== null);
  },
});

export const getPlayer = query({
  args: { playerId: v.id("players") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.playerId);
  },
});

export const getSecretWordForPlayer = internalQuery({
  args: { playerId: v.id("players") },
  handler: async (ctx, args) => {
    const player = await ctx.db.get(args.playerId);
    if (!player) {
      throw new Error("Player not found");
    }
    
    // For AI players, decode from known words
    if (player.isAI) {
      const AI_SECRET_WORDS = [
        "CRANE", "SLATE", "ADIEU", "AUDIO", "OUIJA",
        "RAISE", "ARISE", "IRATE", "STARE", "TEARS",
        "ROAST", "TOAST", "COAST", "BOAST", "LEAST",
        "BEAST", "FEAST", "HEART", "SMART", "WORLD"
      ];
      
      for (const word of AI_SECRET_WORDS) {
        if (btoa(word + "salt") === player.secretWordHash) {
          return word;
        }
      }
      return "CRANE"; // Fallback for AI
    }
    
    // For human players, return the stored secret word
    return player.secretWord || "WORDS";
  },
});
