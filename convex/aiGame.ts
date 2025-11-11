import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

// Calculate letter overlap between guess and secret
function calculateMatchCount(guess: string, secret: string): number {
  const guessLetters = new Set(guess.toLowerCase());
  const secretLetters = new Set(secret.toLowerCase());
  const intersection = new Set([...guessLetters].filter(x => secretLetters.has(x)));
  return intersection.size;
}

export const submitAIGuess = internalMutation({
  args: {
    gameId: v.id("games"),
    playerId: v.id("players"),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    const game = await ctx.db.get(args.gameId);
    if (!game || game.status !== "active") {
      throw new Error("Game not active");
    }

    const player = await ctx.db.get(args.playerId);
    if (!player || !player.isAI) {
      throw new Error("Invalid AI player");
    }

    const opponent = await ctx.db
      .query("players")
      .withIndex("by_game", (q) => q.eq("gameId", args.gameId))
      .filter((q) => q.neq(q.field("_id"), args.playerId))
      .first();
    
    if (!opponent) {
      throw new Error("Opponent not found");
    }

    const opponentSecret = await ctx.runQuery(internal.games.getSecretWordForPlayer, {
      playerId: opponent._id
    });

    const matchCount = calculateMatchCount(args.text, opponentSecret);
    const isCorrect = false; // AI only makes 4-letter guesses, so never wins directly

    const existingGuesses = await ctx.db
      .query("guesses")
      .withIndex("by_player", (q) => q.eq("playerId", args.playerId))
      .collect();

    const guessNumber = existingGuesses.length + 1;

    await ctx.db.insert("guesses", {
      gameId: args.gameId,
      playerId: args.playerId,
      type: "fourLetter",
      text: args.text,
      matchCount,
      isCorrect,
      guessNumber,
    });

    await ctx.db.patch(args.playerId, {
      totalGuesses: guessNumber,
    });

    return { matchCount, isCorrect, guessNumber };
  },
});
