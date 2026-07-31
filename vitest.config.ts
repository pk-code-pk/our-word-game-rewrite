import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    env: {
      // The suite truncates every table in beforeEach. Without this it runs
      // against server/db.ts's default path (data/fourfive.db) — the same file
      // `npm run dev` uses — so running tests while playing locally deletes
      // your games, players, and user row mid-session. Point it at a scratch
      // file instead; delete data/fourfive.test.db freely.
      DATABASE_FILE: "data/fourfive.test.db",
    },
  },
});
