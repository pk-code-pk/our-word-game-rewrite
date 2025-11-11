import { v } from "convex/values";
import { internalMutation, internalAction } from "./_generated/server";
import { internal, api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

// Common 5-letter words for AI to choose from (no duplicate letters)
const AI_SECRET_WORDS = [
  "CRANE", "SLATE", "ADIEU", "AUDIO", "OUIJA",
  "RAISE", "ARISE", "IRATE", "STARE", "TEARS",
  "ROAST", "TOAST", "COAST", "BOAST", "LEAST",
  "BEAST", "FEAST", "HEART", "SMART", "WORLD"
];

// Common 4-letter words for AI guesses
const AI_GUESS_WORDS = [
  "TEAR", "BEAR", "DEAR", "FEAR", "GEAR",
  "HEAR", "NEAR", "PEAR", "REAR", "SEAR",
  "WEAR", "YEAR", "BEAT", "FEAT", "HEAT",
  "MEAT", "NEAT", "PEAT", "SEAT", "TEAT"
];

export const createAIPlayer = internalMutation({
  args: {
    gameId: v.id("games"),
    difficulty: v.union(v.literal("easy"), v.literal("standard"), v.literal("hard")),
  },
  handler: async (ctx, args) => {
    // Choose a random secret word for AI
    const aiSecretWord = AI_SECRET_WORDS[Math.floor(Math.random() * AI_SECRET_WORDS.length)];
    const secretHash = btoa(aiSecretWord + "salt");
    
    // Create alphabet state
    const alphabet: Record<string, "present" | "absent" | "unknown"> = {};
    for (let i = 65; i <= 90; i++) {
      alphabet[String.fromCharCode(i)] = "unknown";
    }

    const aiPlayerId = await ctx.db.insert("players", {
      gameId: args.gameId,
      username: "DualBot",
      isAI: true,
      difficulty: args.difficulty,
      secretWordHash: secretHash,
      alphabet,
      totalGuesses: 0,
    });

    // Start the game since AI is ready
    await ctx.db.patch(args.gameId, { status: "active" });

    return aiPlayerId;
  },
});

export const makeAIGuess = internalAction({
  args: {
    gameId: v.id("games"),
    aiPlayerId: v.id("players"),
  },
  handler: async (ctx, args) => {
    // Simple AI strategy: pick a random 4-letter word
    const guessWord = AI_GUESS_WORDS[Math.floor(Math.random() * AI_GUESS_WORDS.length)];
    
    // Submit the guess
    await ctx.runMutation(internal.aiGame.submitAIGuess, {
      gameId: args.gameId,
      playerId: args.aiPlayerId,
      text: guessWord,
    });
  },
});

export const getSecretWord = internalAction({
  args: { playerId: v.id("players") },
  handler: async (ctx, args) => {
    // This is a simplified version for demo purposes
    const player = await ctx.runQuery(api.games.getPlayer, { playerId: args.playerId });
    if (!player) throw new Error("Player not found");
    
    // For demo, we'll decode the hash (not secure, just for functionality)
    if (player.isAI) {
      // Return a word from our AI list that matches the hash
      for (const word of AI_SECRET_WORDS) {
        if (btoa(word + "salt") === player.secretWordHash) {
          return word;
        }
      }
    }
    
    // For human players, this is more complex in a real implementation
    // For now, return a placeholder
    return "CRANE";
  },
});
