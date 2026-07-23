import cookieParser from "cookie-parser";
import express from "express";
import {
  changePassword,
  clearSession,
  cleanupExpiredSessions,
  createSession,
  getLoggedInUser,
  getSessionCookieName,
  getUserById,
  getUserFromRequest,
  requireUser,
  signIn,
  signInAnonymously,
  signUp,
} from "./auth.js";
import { databaseFile, databaseProvider, initDb, keepDbAlive } from "./db.js";
import { createSocialRouter } from "./friends.js";
import { getLeaderboard } from "./leaderboard.js";
import {
  cancelWaitingLobby,
  cleanupExpiredWaitingGames,
  createGame,
  getGameState,
  getPlayerGames,
  joinGame,
  listPublicLobbies,
  matchmake,
  markGamePresenceOffline,
  submitGuess,
  updateAlphabet,
} from "./gameService.js";
import { getWordBankStats, validateGameWord } from "../shared/wordBank.js";

let initialized = false;
let initializePromise: Promise<void> | null = null;

function isProduction() {
  return process.env.NODE_ENV === "production";
}

function getBuildInfo() {
  const commit = process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? null;
  const environment = process.env.VERCEL_ENV ?? (isProduction() ? "production" : "development");

  return {
    source: "rewrite-no-convex",
    commit: commit ? commit.slice(0, 7) : null,
    environment,
  };
}

async function initializeApplication() {
  if (initialized) {
    return;
  }

  if (!initializePromise) {
    initializePromise = (async () => {
      await initDb();
      await cleanupExpiredSessions();
      await cleanupExpiredWaitingGames();
      initialized = true;
    })().finally(() => {
      if (!initialized) {
        initializePromise = null;
      }
    });
  }

  await initializePromise;
}

function parseExpectedLength(value: unknown): 4 | 5 | undefined {
  return value === 4 || value === 5 ? value : undefined;
}

function respondWithRouteError(res: express.Response, error: unknown, fallbackMessage: string) {
  const message = error instanceof Error ? error.message : fallbackMessage;
  const status = message === "You must be signed in." ? 401 : 400;
  res.status(status).json({ error: message });
}

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Localhost dev origins that are safe to accept when ALLOWED_ORIGINS is empty.
// Anything else (including a deployed staging host) must be added explicitly.
const DEV_ORIGIN_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
function isOriginAllowed(origin: string) {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (isProduction()) return false;
  return DEV_ORIGIN_PATTERN.test(origin);
}

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use(express.json({ limit: "32kb" }));
  app.use(cookieParser());

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && isOriginAllowed(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
    }
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    const buildInfo = getBuildInfo();
    if (buildInfo.commit) {
      res.setHeader("X-App-Commit", buildInfo.commit);
    }
    next();
  });

  app.use(async (_req, _res, next) => {
    try {
      await initializeApplication();
      next();
    } catch (error) {
      next(error);
    }
  });

  app.use("/api/social", createSocialRouter());

  app.get("/api/health", (_req, res) => {
    // Production health is intentionally minimal. Internal details (provider,
    // session cookie name, build commit, dictionary stats) are only useful when
    // diagnosing locally and are reconnaissance signal otherwise.
    if (isProduction()) {
      res.json({ ok: true });
      return;
    }
    res.json({
      ok: true,
      sessionCookie: getSessionCookieName(),
      build: getBuildInfo(),
      database: {
        provider: databaseProvider,
        file: databaseFile,
      },
      realtime: "websocket",
      dictionary: getWordBankStats(),
    });
  });

  // Hit by Vercel Cron (see vercel.json) to keep the free-tier Supabase project
  // from auto-pausing after 7 days of inactivity. Runs a trivial SELECT 1.
  app.get("/api/keepalive", async (_req, res) => {
    await keepDbAlive();
    res.json({ ok: true });
  });

  app.get("/api/auth/me", async (req, res) => {
    const user = await getUserFromRequest(req);
    res.json({ user: getLoggedInUser(user) });
  });

  app.post("/api/auth/signup", async (req, res) => {
    try {
      const currentUser = await getUserFromRequest(req);
      const currentSessionId = req.cookies?.[getSessionCookieName()] ?? null;

      if (currentUser) {
        res.status(400).json({
          error: "You're already signed in. Sign out to create a different account.",
        });
        return;
      }

      const userId = await signUp(req.body.username ?? req.body.identifier ?? req.body.email ?? "", req.body.password ?? "");
      const token = await createSession(res, userId, { replaceExistingSessionId: currentSessionId });
      res.json({ ok: true, user: await getUserById(userId), token });
      return;
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Could not sign up." });
    }
  });

  app.post("/api/auth/signin", async (req, res) => {
    try {
      const currentSessionId = req.cookies?.[getSessionCookieName()] ?? null;
      const userId = await signIn(
        req.body.identifier ?? req.body.email ?? req.body.username ?? "",
        req.body.password ?? ""
      );
      const token = await createSession(res, userId, { replaceExistingSessionId: currentSessionId });
      res.json({ ok: true, user: await getUserById(userId), token });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Could not sign in." });
    }
  });

  app.post("/api/auth/anonymous", async (req, res) => {
    const currentSessionId = req.cookies?.[getSessionCookieName()] ?? null;
    const userId = await signInAnonymously();
    const token = await createSession(res, userId, { replaceExistingSessionId: currentSessionId });
    res.json({ ok: true, user: await getUserById(userId), token });
  });

  app.post("/api/auth/signout", async (req, res) => {
    await clearSession(req, res);
    res.json({ ok: true });
  });

  app.patch("/api/auth/password", async (req, res) => {
    try {
      const user = await requireUser(req);
      await changePassword(user.id, req.body.currentPassword ?? "", req.body.newPassword ?? "");
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Could not change password." });
    }
  });

  app.post("/api/words/validate", (req, res) => {
    res.json(
      validateGameWord(req.body.word ?? "", parseExpectedLength(req.body.expectedLength))
    );
  });

  app.get("/api/games/public-lobbies", async (_req, res) => {
    res.json(await listPublicLobbies());
  });

  app.get("/api/games", async (req, res) => {
    try {
      const user = await requireUser(req);
      res.json({ games: await getPlayerGames(user) });
    } catch (error) {
      respondWithRouteError(res, error, "Could not list games.");
    }
  });

  app.post("/api/games", async (req, res) => {
    try {
      const user = await requireUser(req);
      res.json(await createGame(user, req.body.username ?? "", req.body.secretWord ?? "", Boolean(req.body.public)));
    } catch (error) {
      respondWithRouteError(res, error, "Could not create game.");
    }
  });

  app.post("/api/games/matchmake", async (req, res) => {
    try {
      const user = await requireUser(req);
      res.json(await matchmake(user, req.body.username ?? "", req.body.secretWord ?? ""));
    } catch (error) {
      respondWithRouteError(res, error, "Could not find a match.");
    }
  });

  app.post("/api/games/join", async (req, res) => {
    try {
      const user = await requireUser(req);
      res.json(await joinGame(user, req.body.code ?? "", req.body.username ?? "", req.body.secretWord ?? ""));
    } catch (error) {
      respondWithRouteError(res, error, "Could not join game.");
    }
  });

  app.get("/api/games/:gameId", async (req, res) => {
    try {
      const user = await requireUser(req);
      res.json({ gameState: await getGameState(user, req.params.gameId) });
    } catch (error) {
      respondWithRouteError(res, error, "Could not load game state.");
    }
  });

  app.post("/api/games/:gameId/guess", async (req, res) => {
    try {
      const user = await requireUser(req);
      res.json(await submitGuess(user, req.params.gameId, req.body.type, req.body.text ?? ""));
    } catch (error) {
      respondWithRouteError(res, error, "Could not submit guess.");
    }
  });

  app.post("/api/games/:gameId/leave", async (req, res) => {
    try {
      const user = await requireUser(req);
      res.json(await cancelWaitingLobby(user, req.params.gameId));
    } catch (error) {
      respondWithRouteError(res, error, "Could not leave game.");
    }
  });

  app.patch("/api/games/:gameId/alphabet", async (req, res) => {
    try {
      const user = await requireUser(req);
      res.json({
        alphabet: await updateAlphabet(user, req.params.gameId, req.body.letter ?? "", req.body.state),
      });
    } catch (error) {
      respondWithRouteError(res, error, "Could not update alphabet.");
    }
  });

  app.post("/api/games/:gameId/presence/offline", async (req, res) => {
    try {
      const user = await requireUser(req);
      res.json(await markGamePresenceOffline(user, req.params.gameId));
    } catch (error) {
      respondWithRouteError(res, error, "Could not update presence.");
    }
  });

  app.get("/api/leaderboard", async (_req, res) => {
    res.json({ leaderboard: await getLeaderboard() });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "Route not found." });
  });

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) {
      return;
    }

    const message = error instanceof Error ? error.message : "Internal server error.";
    const status = message === "You must be signed in." ? 401 : 500;
    res.status(status).json({ error: message });
  });

  return app;
}

export const app = createApp();
