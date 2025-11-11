import { v } from "convex/values";
import { internalAction, query, mutation, internalQuery, internalMutation, action } from "./_generated/server";
import { internal } from "./_generated/api";

export const validateWord = internalAction({
  args: { word: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const word = args.word.toLowerCase().trim();
    
    // Check basic requirements
    if (word.length < 4 || word.length > 5) {
      return false;
    }

    // Check for duplicate letters
    if (new Set(word).size !== word.length) {
      console.log(`Word "${word}" rejected: has duplicate letters`);
      return false;
    }

    // Check if word contains only letters
    if (!/^[a-z]+$/.test(word)) {
      return false;
    }

    // Check cache first
    const cached: any = await ctx.runQuery(internal.dictionary.getCachedWordQuery, { word });
    if (cached) {
      // Check if cache is still valid (7 days)
      const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
      if (cached.checkedAt > sevenDaysAgo) {
        return cached.valid;
      }
    }

    // Try dictionary API
    let isValid = false;

    try {
      // Use Free Dictionary API (no key required)
      const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en_US/${word}`);
      
      if (response.ok) {
        const data = await response.json();
        
        // Check if it's a proper noun (capitalized in dictionary)
        const isProperNoun = data.some((entry: any) => 
          entry.word && entry.word[0] === entry.word[0].toUpperCase()
        );
        
        isValid = !isProperNoun;
      }
    } catch (error) {
      console.error("Dictionary API error:", error);
      // Fallback validation - very basic
      isValid = /^[a-z]{4,5}$/.test(word);
    }

    // Cache the result
    await ctx.runMutation(internal.dictionary.cacheWordResult, {
      word,
      valid: isValid,
      reason: isValid ? undefined : "Word not found or is proper noun",
      source: "american-english-dictionary-api",
      checkedAt: Date.now(),
    });

    return isValid;
  },
});

export const getCachedWordQuery = internalQuery({
  args: { word: v.string() },
  handler: async (ctx, args) => {
    const cached = await ctx.db
      .query("wordCache")
      .withIndex("by_word", (q) => q.eq("word", args.word))
      .first();
    
    return cached;
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
    await ctx.db.insert("wordCache", {
      word: args.word,
      valid: args.valid,
      reason: args.reason,
      source: args.source,
      checkedAt: args.checkedAt,
    });
  },
});

// Public action wrapper for validateWord
export const validateWordPublic = action({
  args: { word: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const isValid: boolean = await ctx.runAction(internal.dictionary.validateWord, {
      word: args.word,
    });
    return isValid;
  },
});
