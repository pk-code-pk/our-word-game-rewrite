# FourFive

FourFive is a two-player word deduction game built with React, Vite, Tailwind, and an Express backend that can run against either a local SQLite database or a hosted Postgres database such as Neon.

## Gameplay

- Each player chooses a secret 5-letter word with no duplicate letters.
- Players submit 4-letter probe guesses or a full 5-letter solve attempt.
- Four-letter guesses return the number of overlapping letters.
- Full-word guesses win immediately if correct.
- Public lobbies, in-match chat, leaderboard stats, and resumable games are supported.
- Multiplayer updates currently use short-interval polling rather than WebSockets.

## Reliability Notes

- Game state is only visible to authenticated participants.
- Secret words stay hidden until a match is completed.
- Waiting lobbies expire automatically after 12 hours.
- Chat includes basic moderation and rate limiting.
- Word validation uses a deterministic local dictionary generated from an English word list.

## Development

- `npm install`
- `npm run generate:wordbank`
- `npm run dev`
- copy `.env.example` to `.env.local` if you want to override the defaults

Useful scripts:

- `npm run typecheck` checks frontend, shared, and backend TypeScript.
- `npm run test` runs regression tests.
- `npm run lint` runs typecheck and the production build.
- `npm run verify` runs the full test and build pipeline.

## Project Structure

- `src/` contains the React frontend.
- `server/` contains the Express API, auth, and SQLite-backed services.
- `shared/` contains shared gameplay rules, types, and dictionary helpers.
- `src/components/` contains the main game UI surfaces.

## Authentication

The app uses custom cookie-session auth with password and anonymous sign-in flows. Anonymous sign-in still creates a user-backed session, which the game relies on for server-side authorization.

## Deployment Notes

The current branch is structured so the same Express app can run locally from `server/index.ts` and be exported as a serverless handler from `api/index.ts`. The included [vercel.json](/Users/praneelkhiantani/Downloads/our-word-game/vercel.json) matches that shape and tells Vercel to:

- build the frontend with `npm run build`
- serve the static app from `dist`
- run the API from `api/index.ts` on the Node.js runtime

The backend already supports two database modes in [server/db.ts](/Users/praneelkhiantani/Downloads/our-word-game/server/db.ts):

- local SQLite when `DATABASE_URL` is unset
- hosted Postgres when `DATABASE_URL` is set

Important production note for Vercel: the fallback local SQLite file under `data/` is only for local development or a single persistent Node host. For a real Vercel deployment, you must point the app at hosted durable storage. The current codebase is already wired for hosted Postgres via `DATABASE_URL`.

## Environment Variables

Start from [.env.example](/Users/praneelkhiantani/Downloads/our-word-game/.env.example).

- `NODE_ENV`
  Use `production` on Vercel.
- `PORT`
  Local backend port only. Vercel sets its own runtime port.
- `DATABASE_FILE`
  Local-only SQLite path. Ignore this in Vercel.
- `DATABASE_URL`
  Required for Vercel. Set this to your hosted Postgres connection string. For Neon, use the pooled connection string.
- `VITE_API_BASE_URL`
  Leave blank for same-origin deployments. Only set this if you intentionally split frontend and API across different origins.

## Vercel Checklist

What still needs to happen outside the repo:

1. Create a hosted database.
   The fastest path with the current code is Neon/Postgres because [server/db.ts](/Users/praneelkhiantani/Downloads/our-word-game/server/db.ts) already supports it.
2. Copy the connection details into Vercel environment variables.
   Set `DATABASE_URL` and `NODE_ENV=production`.
3. Keep the frontend and API in the same Vercel project.
   That lets the strict auth cookie settings in [server/auth.ts](/Users/praneelkhiantani/Downloads/our-word-game/server/auth.ts) work without cross-origin cookie workarounds.
4. Run a preview deployment and smoke test the critical flows.
   Check signup, sign-in, guest upgrade, friend request, game invite, create/join game, refresh persistence, and sign-out/sign-back-in.
5. Only promote to production after the preview environment keeps data across redeploys and refreshes.

## Jeff's Changes

Jeff's work lives at **[github.com/jmperrotti/our-word-game](https://github.com/jmperrotti/our-word-game)** on the **`jeffschanges`** branch. Any time you want to review or pull in Jeff's latest work, that is the canonical reference.

## Verification Status

The intended verification command is still `npm run verify`, and the frontend build currently succeeds. At the moment, there are active backend TypeScript issues outside this README/config lane that still need to be resolved before the full repo can be called green end to end. The tests in [server/auth.test.ts](/Users/praneelkhiantani/Downloads/our-word-game/server/auth.test.ts) have been updated for the newer async auth/session APIs so the verification layer stays aligned with the backend contract while those remaining server fixes land.
