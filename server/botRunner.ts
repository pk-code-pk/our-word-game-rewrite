// Drives the bot's turns without any background process.
//
// Vercel gives us no long-lived worker and Hobby crons fire once a day, so the
// bot cannot own a loop. Instead its turns are computed inside requests the
// human is already making: the 20s safety poll and every broadcast-driven
// refetch call GET /api/games/:id, and each guess POSTs. Every one of those is
// an opportunity to ask "is the bot due?".
//
// Because several of those requests can overlap, being due is not enough — the
// turn has to be *claimed*. A conditional UPDATE on bot_next_move_at does that
// atomically: whoever flips the timestamp forward gets to move, everyone else
// sees changes === 0 and does nothing. That is the only concurrency control
// needed, and it works identically on SQLite and Postgres.
//
// Nothing in here may throw into the caller's request. A bot that fails to move
// is a cosmetic problem; a bot that 500s the human's game is not.

import {
  chooseMove,
  deriveAlphabetFromCandidates,
  filterCandidateIndices,
  isBotDifficulty,
  nextMoveDelayMs,
  type BotFeedback,
} from "../shared/botBrain.js";
import { db } from "./db.js";
import { submitGuess } from "./gameService.js";
import type { AuthUser, GuessType } from "./types.js";

type BotPlayerRow = {
  id: string;
  user_id: string;
  username: string;
  bot_difficulty: string | null;
  bot_next_move_at: number | null;
  game_status: "waiting" | "active" | "completed";
};

type BotGuessRow = {
  type: GuessType;
  text: string;
  match_count: number;
  is_correct: number;
};

async function clearSchedule(playerId: string): Promise<void> {
  await db.prepare(`UPDATE players SET bot_next_move_at = NULL WHERE id = ?`).run(playerId);
}

/**
 * Plays the bot's turn if one is due and can be claimed.
 *
 * Returns true only when a guess was actually submitted, which makes the
 * behaviour straightforward to assert in tests.
 */
export async function maybeRunBotTurn(gameId: string, at: number = Date.now()): Promise<boolean> {
  try {
    const bot = (await db
      .prepare(
        `SELECT p.id, p.user_id, p.username, p.bot_difficulty, p.bot_next_move_at, g.status AS game_status
         FROM players p
         JOIN games g ON g.id = p.game_id
         WHERE p.game_id = ? AND p.is_bot = 1`
      )
      .get(gameId)) as BotPlayerRow | undefined;

    // Not a bot game, or a bot row with no difficulty to reason from.
    if (!bot || !isBotDifficulty(bot.bot_difficulty)) {
      return false;
    }

    if (bot.game_status !== "active") {
      // Drop the schedule so a finished game stops being reconsidered on every
      // subsequent poll of its final state.
      if (bot.bot_next_move_at !== null) {
        await clearSchedule(bot.id);
      }
      return false;
    }

    if (bot.bot_next_move_at === null || bot.bot_next_move_at > at) {
      return false;
    }

    const difficulty = bot.bot_difficulty;

    // Claim the turn. The WHERE clause re-checks the due condition, so exactly
    // one concurrent caller can win it. Rescheduling before moving also means a
    // crash mid-move costs one turn rather than spinning.
    const claim = await db
      .prepare(
        `UPDATE players
         SET bot_next_move_at = ?
         WHERE id = ? AND is_bot = 1 AND bot_next_move_at IS NOT NULL AND bot_next_move_at <= ?`
      )
      .run(at + nextMoveDelayMs(difficulty), bot.id, at);

    if (!claim || claim.changes !== 1) {
      return false;
    }

    const guessRows = (await db
      .prepare(
        `SELECT type, text, match_count, is_correct
         FROM guesses
         WHERE player_id = ?
         ORDER BY guess_number ASC`
      )
      .all(bot.id)) as BotGuessRow[];

    // The solver keeps no stored state — it is rebuilt from the bot's own
    // guesses every turn. That survives cold starts and redeploys for free and
    // leaves nothing that can drift out of sync with the game.
    const feedback: BotFeedback[] = guessRows.map((row) => ({
      type: row.type,
      text: row.text,
      matchCount: row.match_count,
      isCorrect: Boolean(row.is_correct),
    }));

    const move = chooseMove({ difficulty, feedback });
    if (!move) {
      // A deliberately skipped turn. The claim already rescheduled it.
      return false;
    }

    const botUser: AuthUser = {
      id: bot.user_id,
      email: null,
      username: bot.username,
      isAnonymous: false,
      createdAt: 0,
    };

    // Deliberately routed through the same entry point a human uses, so the bot
    // is subject to identical validation, rate limiting, transaction locking,
    // win detection, and broadcast behaviour. There is no privileged write path.
    const result = await submitGuess(botUser, gameId, move.type, move.text);

    const settledFeedback: BotFeedback[] = [
      ...feedback,
      { type: move.type, text: move.text, matchCount: result.matchCount, isCorrect: result.isCorrect },
    ];

    // Mark the bot's alphabet from what it has genuinely deduced. The
    // opponent-insight readout reports how many letters the opponent has marked
    // correctly, so skipping this would leave that mechanic dead in bot games.
    const alphabet = deriveAlphabetFromCandidates(filterCandidateIndices(settledFeedback));
    await db
      .prepare(`UPDATE players SET alphabet_json = ? WHERE id = ?`)
      .run(JSON.stringify(alphabet), bot.id);

    if (result.gameStatus === "completed") {
      await clearSchedule(bot.id);
    }

    return true;
  } catch (error) {
    // Never surface a bot failure into the human's request.
    console.error(`[bot] turn failed for game ${gameId}:`, error);
    return false;
  }
}
