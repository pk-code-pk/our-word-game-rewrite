import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    // The suite truncates every table in beforeEach. Without this it does that to
    // ./data/fourfive.db — the local dev database — signing out anyone mid-game.
    env: {
      DATABASE_FILE: ":memory:",
    },
  },
});
