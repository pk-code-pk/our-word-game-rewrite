# FourFive

FourFive is a two-player word deduction game. React + Vite + Tailwind on the front, an Express + TypeScript API on the back, running against either hosted Postgres (Supabase in production) or a local SQLite file for development.

## Gameplay

- Each player picks a secret **5-letter word with no repeated letters**.
- There are no turns — both players probe freely and race to solve first.
- A **4-letter guess** returns a *match count*: how many of its letters appear anywhere in the opponent's secret. Position is ignored.
- A **5-letter guess** is a solve attempt. Correct ends the game immediately.
- An **alphabet board** lets you mark each letter unknown → present → absent as you narrow things down.
- The server also reports how many letters your opponent has correctly marked against *your* secret, so you can feel them closing in.
- Public lobbies, friends, game invites, presence, a leaderboard, and resumable games are all supported.

Guess pacing is anti-spam only, not a mechanic: a 600 ms cooldown and 15 guesses per 15 s. Both live in `shared/gameLogic.ts` and the client's submit lock imports the cooldown rather than duplicating it — when the two drifted apart (client 400 ms, server 1200 ms) the UI accepted guesses the server always rejected, and the rejection looked to players like the guess silently vanishing.

Secret words are never sent to the opponent's client. They are omitted from the API payload entirely until the game reaches `completed`.

## Playing the Bot

Pick a difficulty in the lobby and the game starts immediately — no lobby wait, since both seats are filled at creation. Bot games are unranked and never touch the leaderboard, so they are safe to use as practice.

The solver is a Mastermind-style constraint filter in `shared/botBrain.ts`. Because both word lists are free of repeated letters, a word is fully described by the set of letters it contains, so every word encodes as a 26-bit mask and a match count is one popcount:

```
matchCount(guess, secret) === popcount(mask(guess) & mask(secret))
```

Each turn it rebuilds the set of dictionary words still consistent with its own past feedback, then picks the probe that splits that set most evenly — the guess whose answer it can predict least well, and therefore learns the most from.

**The bot defends a common word, not a random one.** It searches the whole dictionary when solving, so it cracks an ordinary player word easily — but the dictionary is a Scrabble word list, and two-thirds of it is words like GLISK, NUGAE, and AXOID. A bot whose own secret came from all 8,079 would be one you could out-deduce completely and still never beat. So its secret is drawn from `BOT_SECRET_WORDS`: the 1,500 most common legal words, ranked by frequency. Adjust `BOT_SECRET_POOL_SIZE` in `scripts/generate-wordbank.mjs` — quality holds past rank 1500 and is gone by 4000.

**It cannot cheat.** `chooseMove` takes only the bot's own guess history; there is no parameter for the opponent's secret. That is enforced by the type signature and asserted in the tests. Bot guesses also go through the same `submitGuess` entry point a human uses, so they get identical validation, rate limiting, transaction locking, and win detection. There is no privileged write path.

Difficulty is mostly about **pace, not accuracy**. A four-letter probe yields about 2.2 bits and identifying one of 8,079 words needs roughly 13, so about seven guesses is the floor and no amount of cleverness beats it by much. Measured over 60 random secrets: easy solves in ~14.7 guesses, medium ~9.0, hard ~8.7. What actually separates them is time to solve — roughly 7 minutes, 2 minutes, and 80 seconds respectively. Retune the delays in `BOT_DIFFICULTY_CONFIG` to rebalance; changing `solveThreshold` barely moves the needle.

Two properties of this game are worth knowing before touching the solver:

- **A missed solve carries no information.** The game service records `match_count` 0 for every wrong full-word guess regardless of how many letters actually matched. Reading that 0 as "shares no letters" would wrongly eliminate most of the dictionary. All a miss rules out is that one word.
- **Letter-set anagrams are indistinguishable.** "SNAKE" and "SNEAK" return identical counts for every possible probe, forever. A bot that waits for exactly one candidate would probe until it ran out of dictionary, so once the field collapses to a single letter set it has to gamble.

### How its turns run

Vercel gives us no long-lived worker and Hobby crons fire once a day, so the bot cannot own a loop. Its turns are instead computed inside requests the human is already making — the 20-second safety poll, every broadcast-driven refetch, and every guess.

Because those can overlap, being due is not enough; the turn has to be *claimed*. A conditional `UPDATE` on `players.bot_next_move_at` does that atomically: whoever moves the timestamp forward gets the turn, everyone else sees `changes === 0` and does nothing. It is the only concurrency control involved and behaves identically on both drivers.

The solver stores no state. It is rebuilt from the bot's own rows in `guesses` every turn, which survives cold starts and redeploys for free and leaves nothing that can drift out of sync with the game.

One consequence of having no background worker: if nobody has the game open, the bot does not move. Nothing is watching, so nothing is lost — it resumes on the next request.

## Development

```bash
npm install
npm run generate:wordbank
npm run dev
```

`npm run dev` starts the Vite frontend and the Express backend in parallel. With `DATABASE_URL` unset the backend creates a SQLite database under `data/`, so no external services are required.

Copy `.env.example` to `.env.local` to override defaults.

Scripts:

| Command | Does |
| --- | --- |
| `npm run typecheck` | Typechecks server, shared, and frontend |
| `npm run test` | vitest regression suite |
| `npm run lint` | typecheck plus a production build |
| `npm run verify` | full test and build pipeline |
| `npm run generate:wordbank` | regenerates `shared/wordLists.ts` from the `word-list` and `popular-english-words` packages |

## Project Structure

```
src/        React frontend (components/, lib/, App.tsx)
server/     Express app, auth, data access, game rules enforcement
shared/     Isomorphic gameplay logic, types, dictionary
api/        Vercel serverless wrappers around the same Express app
scripts/    Word bank generator
```

Notable files:

- `shared/gameLogic.ts` — pure, fully tested rules: match counting, the viewer-scoped `buildGameStateView` projection, game codes, sanitizers, moderation, and rate-limit math. Shared verbatim by client and server.
- `server/db.ts` — the dual-driver database layer (see below).
- `server/gameService.ts` — all game mutations and reads.
- `server/realtime.ts` — Supabase broadcast signalling.
- `shared/wordLists.ts` — generated, checked in. 4,269 four-letter and 8,079 five-letter words, all free of repeated letters, plus the 1,500-word `BOT_SECRET_WORDS` pool.
- `shared/botBrain.ts` — the bot's solver. Pure and deliberately blind (see Playing the Bot).
- `server/botRunner.ts` — claims and plays the bot's turn from inside ordinary requests.

## Database

`server/db.ts` exposes one `prepare().get()/all()/run()` interface over two drivers:

- **SQLite** (`better-sqlite3`) when `DATABASE_URL` is unset — local development only.
- **Postgres** (`postgres`) when `DATABASE_URL` is set — production.

Two constraints worth knowing before editing this file:

1. `better-sqlite3` is loaded through `createRequire`, never a static import. A static import pulls the native addon in at module-init time and breaks the serverless runtime, where it is not needed at all.
2. SQLite is synchronous and Postgres is not, so every call site returns `MaybePromise<T>` and forks on `isPromiseLike`. New queries must handle both.

There is no migration tool. Schema lives as `CREATE TABLE IF NOT EXISTS` blocks — **one per dialect** — inside `server/db.ts`. Any schema change must be made in both blocks or the two environments drift.

Tables: `users`, `sessions`, `games`, `players`, `guesses`, `chat_messages`, `player_presence`, `user_stats`, `friend_requests`, `friendships`, `game_invites`, `rate_limit_hits`.

Columns added to an existing table go through `ensureColumnLocal` / `ensureColumnRemote` at the end of `initDb`, not the `CREATE TABLE` block. Anything depending on a new column — an index, for instance — has to run after those, or it will fail against a database that already exists.

Production is Supabase Postgres via the transaction pooler on port 6543.

## Realtime

Live updates use **Supabase Realtime broadcast as a signal only**.

1. A mutation broadcasts `{ gameId }` on topic `game:<id>` via the Realtime REST endpoint — a plain `fetch`, no held socket, so it works from serverless functions.
2. Subscribed clients react by refetching `GET /api/games/:gameId`, which recomputes viewer-specific state server-side.

No game state ever travels over the channel, which is what guarantees the opponent's secret cannot leak through it.

A 20-second safety poll backs the broadcast up in case a signal is dropped. If the Supabase env vars are absent the client degrades to poll-only rather than failing. Broadcast errors are logged and swallowed — a failed signal must never break the mutation that triggered it.

`src/lib/useGameSocket.ts` is named for the WebSocket server this replaced. There is no socket.

## Authentication

Custom cookie sessions, no external identity provider. `fourfive_session`, 30-day TTL, bcrypt password hashes.

Anonymous sign-in creates a real user row and session, so guests are not a special case anywhere in the authorization path. Guests can later upgrade to a full account via `POST /api/auth/upgrade`.

Sign-in against a nonexistent account still runs a bcrypt comparison against a precomputed dummy hash, so response timing does not reveal whether an account exists.

Cookies assume same-origin. Only set `ALLOWED_ORIGINS` if you deliberately split the frontend and API across origins.

## API

- `/api/auth/*` — `me`, `signup`, `signin`, `anonymous`, `upgrade`, `signout`, `password`
- `/api/games` — list, create, `bot`, `matchmake`, `join`, `public-lobbies`
- `/api/games/:gameId` — state, `guess`, `forfeit`, `leave`, `alphabet`, `presence/offline`
- `/api/social/*` — friends, search, requests, game invites
- `/api/leaderboard`, `/api/words/validate`, `/api/health`, `/api/keepalive`

## Deployment

Vercel, single project, frontend and API on the same origin so the strict auth cookie settings work without cross-origin workarounds.

`vercel.json` builds the frontend with `npm run build`, serves the static app from `dist`, and rewrites `/api/:path*` to the Node serverless function in `api/`. The exported handler wraps the exact same Express app that `server/index.ts` runs locally.

```bash
npx vercel            # preview
npx vercel --prod     # production
```

A daily Vercel cron hits `/api/keepalive` to stop the hosted database being paused for inactivity.

Verify a preview deployment before promoting: signup, sign-in, guest upgrade, friend request, game invite, create/join game, refresh persistence, and sign-out/sign-back-in. Confirm data survives a redeploy.

## Environment Variables

Start from `.env.example`.

| Variable | Notes |
| --- | --- |
| `NODE_ENV` | `production` on Vercel |
| `PORT` | Local backend only |
| `DATABASE_FILE` | Local SQLite path. Ignored in production |
| `DATABASE_URL` | Required in production. Use the pooled connection string |
| `VITE_API_BASE_URL` | Leave blank for same-origin deployments |
| `VITE_SUPABASE_URL` | Project URL, exposed to the browser |
| `VITE_SUPABASE_ANON_KEY` | Anon key, exposed to the browser. Realtime subscribe only |
| `SUPABASE_URL` | Same project URL, server side |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret. Server-side broadcast only — never expose to the client |
| `ALLOWED_ORIGINS` | Only for split-origin deployments |

## Mobile Notes

The iOS software keyboard drove most of the layout work, so a few rules are load-bearing:

- Do not correct scroll position while the keyboard is animating. Scripted corrections during the pan read as a bounce.
- Blur the input after submitting. Re-focusing compounds viewport pans, and `preventScroll` is ignored on iOS.
- Correct a stuck viewport once, at the `focusout` boundary: wait for the visual viewport height to restore, glide to zero over rAF, then nudge by one pixel. The nudge works around an iOS 26 bug where `offsetTop` is not reset.
- The app shell needs a definite height (`h-[100svh]`). Without it the flex chain sizes to content and the guess pane grows without bound.
- Minimum-height floors belong on the flex section, not only on inner cards, or content paints underneath its siblings.

Verify layout changes with Playwright screenshots at an iPhone-13 viewport against a preview deployment, and measure with `getBoundingClientRect` rather than by eye.

## Known Dead Code

- `convex/` is left over from the pre-rewrite architecture and is entirely unused.
- `chat_messages`, the chat moderation and rate-limit helpers, and the chat service functions all exist, but no chat route is mounted and no chat UI is wired up.
- `/api/health` still reports `"realtime": "websocket"`. That label predates the move to Supabase broadcast and no longer describes anything.
- `ws` remains in dependencies although the WebSocket server it served is gone.

## Related

Jeff's work lives at [github.com/jmperrotti/our-word-game](https://github.com/jmperrotti/our-word-game) on the `jeffschanges` branch.
