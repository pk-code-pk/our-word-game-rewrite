import { v } from "convex/values";
import { internalAction, internalQuery, internalMutation, action } from "./_generated/server";
import { internal } from "./_generated/api";
import { getWordValidationReason, isAllowedGameWord } from "./wordBank";

export const validateWord = internalAction({
  args: { word: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const word = args.word.toLowerCase().trim();

    const cached = await ctx.runQuery(internal.dictionary.getCachedWordQuery, { word });
    if (cached) {
      return cached.valid;
    }

    const isValid = isAllowedGameWord(word);
    const reason = isValid ? undefined : getWordValidationReason(word);

    await ctx.runMutation(internal.dictionary.cacheWordResult, {
      word,
      valid: isValid,
      reason,
      source: "built-in-word-bank",
      checkedAt: Date.now(),
    });

    return isValid;
  },
});

export const getCachedWordQuery = internalQuery({
  args: { word: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id("wordCache"),
      _creationTime: v.number(),
      word: v.string(),
      valid: v.boolean(),
      reason: v.optional(v.string()),
      source: v.string(),
      checkedAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("wordCache")
      .withIndex("by_word", (q) => q.eq("word", args.word))
      .first();
  },
});

export const cacheWordResult = internalMutation({
  args: {
    word: v.string(),
    valid: v.boolean(),
    reason: v.optional(v.string()),
    source: v.string(),
    checkedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("wordCache")
      .withIndex("by_word", (q) => q.eq("word", args.word))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        valid: args.valid,
        reason: args.reason,
        source: args.source,
        checkedAt: args.checkedAt,
      });
      return;
    }

    await ctx.db.insert("wordCache", {
      word: args.word,
      valid: args.valid,
      reason: args.reason,
      source: args.source,
      checkedAt: args.checkedAt,
    });
  },
});

export const validateWordPublic = action({
  args: { word: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    return await ctx.runAction(internal.dictionary.validateWord, { word: args.word });
  },
});
