import cookieParser from "cookie-parser";
import express from "express";
import {
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
  upgradeAnonymousAccount,
} from "./auth.js";
import { databaseFile, databaseProvider, initDb } from "./db.js";
import { createSocialRouter } from "./friends.js";
import { getLeaderboard } from "./leaderboard.js";
import {
  cancelWaitingLobby,
  cleanupExpiredWaitingGames,
  createGame,
  getGameState,
  getPlayerGames,
  joinGame,
  listChatMessages,
  listPublicLobbies,
  markGamePresenceOffline,
  sendChatMessage,
  submitGuess,
  updateAlphabet,
} from "./gameService.js";
import { getWordBankStats, validateGameWord } from "../shared/wordBank.js";

let initialized = false;
let initializePromise: Promise<void> | null = null;

function isProduction() {
  return process.env.NODE_ENV === "production";
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

function isStaleGuestSessionError(error: unknown) {
  return error instanceof Error && error.message === "This guest session can no longer be upgraded.";
}

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use(express.json({ limit: "32kb" }));
  app.use(cookieParser());

  app.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
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
    res.json({
      ok: true,
      sessionCookie: getSessionCookieName(),
      database: {
        provider: databaseProvider,
        ...(isProduction() ? {} : { file: databaseFile }),
      },
      realtime: "polling",
      dictionary: getWordBankStats(),
    });
  });

  app.get("/api/auth/me", async (req, res) => {
    const user = await getUserFromRequest(req);
    res.json({ user: getLoggedInUser(user) });
  });

  app.post("/api/auth/signup", async (req, res) => {
    try {
      const currentUser = await getUserFromRequest(req);
      const currentSessionId = req.cookies?.[getSessionCookieName()] ?? null;

      if (currentUser && !currentUser.isAnonymous) {
        res.status(400).json({
          error: "You're already signed in. Sign out to create a different account.",
        });
        return;
      }

      if (currentUser?.isAnonymous) {
        try {
          await upgradeAnonymousAccount(currentUser.id, req.body.email ?? "", req.body.password ?? "");
          await createSession(res, currentUser.id, { replaceExistingSessionId: currentSessionId });
          res.json({ ok: true, user: await getUserById(currentUser.id) });
          return;
        } catch (error) {
          if (!isStaleGuestSessionError(error)) {
            throw error;
          }
        }
      }

      const userId = await signUp(req.body.email ?? "", req.body.password ?? "");
      await createSession(res, userId, { replaceExistingSessionId: currentSessionId });
      res.json({ ok: true, user: await getUserById(userId) });
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
      await createSession(res, userId, { replaceExistingSessionId: currentSessionId });
      res.json({ ok: true, user: await getUserById(userId) });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Could not sign in." });
    }
  });

  app.post("/api/auth/anonymous", async (req, res) => {
    const currentSessionId = req.cookies?.[getSessionCookieName()] ?? null;
    const userId = await signInAnonymously();
    await createSession(res, userId, { replaceExistingSessionId: currentSessionId });
    res.json({ ok: true, user: await getUserById(userId) });
  });

  app.post("/api/auth/signout", async (req, res) => {
    await clearSession(req, res);
    res.json({ ok: true });
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

  app.get("/api/games/:gameId/chat", async (req, res) => {
    try {
      const user = await requireUser(req);
      res.json({ messages: await listChatMessages(user, req.params.gameId) });
    } catch (error) {
      respondWithRouteError(res, error, "Could not load chat messages.");
    }
  });

  app.post("/api/games/:gameId/chat", async (req, res) => {
    try {
      const user = await requireUser(req);
      res.json(await sendChatMessage(user, req.params.gameId, req.body.text ?? ""));
    } catch (error) {
      respondWithRouteError(res, error, "Could not send chat message.");
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
