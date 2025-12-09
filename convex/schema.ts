import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

const applicationTables = {
  games: defineTable({
    code: v.string(),
    mode: v.union(v.literal("pvp"), v.literal("vs_ai")),
    status: v.union(v.literal("waiting"), v.literal("active"), v.literal("completed")),
    public: v.boolean(),
    winnerId: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_code", ["code"])
    .index("by_public_and_status", ["public", "status", "createdAt"])
    .index("by_status", ["status"]),

  players: defineTable({
    gameId: v.id("games"),
    userId: v.optional(v.id("users")),
    username: v.string(),
    isAI: v.boolean(),
    difficulty: v.optional(v.union(v.literal("easy"), v.literal("standard"), v.literal("hard"))),
    secretWordHash: v.string(),
    secretWord: v.optional(v.string()), // Temporary storage for demo - not secure for production
    alphabet: v.record(v.string(), v.union(v.literal("present"), v.literal("absent"), v.literal("unknown"))),
    totalGuesses: v.number(),
  }).index("by_game", ["gameId"]),

  guesses: defineTable({
    gameId: v.id("games"),
    playerId: v.id("players"),
    type: v.union(v.literal("fourLetter"), v.literal("fullWord")),
    text: v.string(),
    matchCount: v.number(),
    isCorrect: v.boolean(),
    guessNumber: v.number(),
  }).index("by_game", ["gameId"])
    .index("by_player", ["playerId"]),

  wordCache: defineTable({
    word: v.string(),
    valid: v.boolean(),
    reason: v.optional(v.string()),
    source: v.string(),
    checkedAt: v.number(),
  }).index("by_word", ["word"]),

  usedWords: defineTable({
    userId: v.id("users"),
    word: v.string(),
    usedAt: v.number(),
  }).index("by_user", ["userId"])
    .index("by_user_and_word", ["userId", "word"]),

  chatMessages: defineTable({
    gameId: v.id("games"),
    playerId: v.id("players"),
    username: v.string(),
    text: v.string(),
    createdAt: v.number(),
  }).index("by_game_and_createdAt", ["gameId", "createdAt"]),

  userStats: defineTable({
    userId: v.id("users"),
    wins: v.number(),
    losses: v.number(),
    totalGuesses: v.number(),
    gamesPlayed: v.number(),
    mostRecentUsername: v.string(),
    currentWinStreak: v.optional(v.number()),
  }).index("by_user", ["userId"])
    .index("by_wins", ["wins"]),
};

export default defineSchema({
  ...authTables,
  ...applicationTables,
});
