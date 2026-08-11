import type {
  AlphabetState,
  AuthUser,
  GameStateView,
  LeaderboardEntry,
  PresenceState,
  RecentGameSummary,
  SocialOverview,
  SocialSearchResult,
  WordValidationResult,
} from "../../shared/types";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");
export const AUTH_ERROR_EVENT = "fourfive:unauthorized";

// The session cookie (httpOnly, Secure, SameSite=None in cross-origin deploys)
// is the primary auth and is unreadable from JS. This Bearer token is a fallback
// for cross-origin browsers that drop third-party cookies (Safari ITP). It is
// the same value as the cookie; consider migrating to short-lived WS tickets if
// the threat model later requires reducing XSS-stealable credential lifetime.
const TOKEN_KEY = "fourfive.token";

export function getStoredToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setStoredToken(token: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearStoredToken(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  payload: { error?: string } | null;

  constructor(status: number, message: string, payload: { error?: string } | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

export function inferApiErrorMessage(params: {
  status: number;
  statusText: string;
  path: string;
  contentType: string | null;
  responseText: string;
  payload: { error?: string } | null;
}) {
  const { status, statusText, path, contentType, responseText, payload } = params;

  if (payload?.error) {
    return payload.error;
  }

  const lowerContentType = contentType?.toLowerCase() ?? "";
  const looksLikeHtml = lowerContentType.includes("text/html");
  const looksLikeVercelProtection =
    responseText.includes("Vercel Authentication") ||
    responseText.includes("Authentication Required") ||
    responseText.includes("x-vercel-protection-bypass") ||
    responseText.includes("vercel.com/sso-api");

  if (looksLikeHtml && looksLikeVercelProtection) {
    return `This deployment is blocked by Vercel Authentication, so ${path} is not reaching the app API. Disable Deployment Protection for this environment or use an unprotected deployment URL.`;
  }

  return `Request failed (${status}${statusText ? ` ${statusText}` : ""}).`;
}

type GameStateResponse = { gameState: GameStateView | null };
type LegacyGameStateResponse = {
  gameState:
    | (Omit<GameStateView, "presence" | "opponentGuesses"> & {
        presence?: {
          me?: PresenceState;
          opponent?: PresenceState | null;
        };
        myFoundLetterCount?: number | null;
        opponentFoundLetterCount?: number | null;
        opponentPresentLetterCount?: number | null;
        opponentGreenLetterInsight?: GameStateView["opponentGreenLetterInsight"];
        opponentGuesses?: Array<{
          id: string;
          playerId: string;
          type: "fourLetter" | "fullWord";
          text: string;
          matchCount: number;
          isCorrect: boolean;
          guessNumber: number;
          createdAt: number;
        }>;
        me?: {
          id: string;
          username: string;
          alphabet?: Record<string, AlphabetState>;
          totalGuesses: number;
          secretWord?: string;
        };
        opponent?: {
          id: string;
          username: string;
          totalGuesses: number;
          secretWord?: string;
        } | null;
      })
    | null;
};

// Every request is bounded. A bare fetch has no timeout: on a stalled mobile
// connection the promise can hang indefinitely, and callers that gate UI state
// on it (the guess submitter held an `isSubmitting` flag across the await) stay
// wedged forever, silently discarding everything the player does next. A
// request that cannot finish must FAIL so the caller's error path runs.
export const REQUEST_TIMEOUT_MS = 15_000;

export class RequestTimeoutError extends Error {
  constructor(path: string) {
    super("The server took too long to respond. Check your connection and try again.");
    this.name = "RequestTimeoutError";
    this.path = path;
  }
  path: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body !== undefined;
  const token = getStoredToken();

  // AbortSignal.any keeps any caller-supplied signal working alongside the
  // timeout. Both are optional at runtime in older Safari, hence the guards.
  const timeoutSignal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      : undefined;
  const callerSignal = init?.signal ?? undefined;
  let signal: AbortSignal | undefined = timeoutSignal ?? callerSignal ?? undefined;
  if (timeoutSignal && callerSignal && typeof AbortSignal.any === "function") {
    signal = AbortSignal.any([timeoutSignal, callerSignal]);
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      credentials: "include",
      headers: {
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
      ...init,
      signal,
    });
  } catch (cause) {
    // Distinguish "we gave up waiting" from a caller-initiated abort, so the
    // timeout gets a message a player can act on.
    if (timeoutSignal?.aborted && !callerSignal?.aborted) {
      throw new RequestTimeoutError(path);
    }
    throw cause;
  }

  if (!response.ok) {
    const contentType = response.headers.get("content-type");
    const responseText = await response.text().catch(() => "");
    let payload: { error?: string } | null = null;

    if (responseText) {
      try {
        payload = JSON.parse(responseText) as { error?: string };
      } catch {
        payload = null;
      }
    }

    const fallbackMessage = inferApiErrorMessage({
      status: response.status,
      statusText: response.statusText,
      path,
      contentType,
      responseText,
      payload,
    });
    if (response.status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent(AUTH_ERROR_EVENT, {
          detail: {
            path,
            message: payload?.error ?? "Unauthorized.",
          },
        })
      );
    }
    throw new ApiError(response.status, payload?.error ?? fallbackMessage, payload);
  }

  return (await response.json()) as T;
}

export function normalizeGameStateResponse(payload: LegacyGameStateResponse): GameStateResponse {
  if (!payload.gameState) {
    return { gameState: null };
  }

  const gameState = payload.gameState;
  const opponent = gameState.opponent ?? null;

  return {
    gameState: {
      ...gameState,
      me: {
        ...gameState.me,
        alphabet: gameState.me?.alphabet ?? {},
      },
      opponent,
      myGuesses: gameState.myGuesses ?? [],
      opponentGuesses: gameState.opponentGuesses ?? [],
      myFoundLetterCount:
        opponent && typeof gameState.myFoundLetterCount === "number"
          ? gameState.myFoundLetterCount
          : null,
      opponentFoundLetterCount:
        opponent && typeof gameState.opponentFoundLetterCount === "number"
          ? gameState.opponentFoundLetterCount
          : opponent && typeof gameState.opponentPresentLetterCount === "number"
          ? gameState.opponentPresentLetterCount
          : null,
      opponentGreenLetterInsight: gameState.opponentGreenLetterInsight ?? null,
      presence: {
        me: gameState.presence?.me ?? "offline",
        opponent: opponent ? (gameState.presence?.opponent ?? "offline") : null,
      },
    },
  };
}

async function authRequest(path: string, body?: Record<string, unknown>) {
  const result = await request<{ ok: true; user: AuthUser | null; token?: string }>(path, {
    method: "POST",
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (result.token) setStoredToken(result.token);
  return result;
}

export const api = {
  me: () => request<{ user: AuthUser | null }>("/api/auth/me"),
  signUp: (username: string, password: string) =>
    authRequest("/api/auth/signup", { username, password }),
  signIn: (identifier: string, password: string) =>
    authRequest("/api/auth/signin", { identifier, username: identifier, password }),
  signInAnonymous: () => authRequest("/api/auth/anonymous"),
  signOut: async () => {
    // X-Requested-With marks this as a same-app fetch. In cross-origin deploys the
    // server requires it on cookie-authenticated signout as CSRF protection, since
    // the session cookie is SameSite=None and would otherwise ride a forged request.
    const result = await request<{ ok: true }>("/api/auth/signout", {
      method: "POST",
      headers: { "X-Requested-With": "fetch" },
    });
    clearStoredToken();
    return result;
  },
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>("/api/auth/password", {
      method: "PATCH",
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  validateWord: (word: string, expectedLength?: 4 | 5) =>
    request<WordValidationResult>("/api/words/validate", {
      method: "POST",
      body: JSON.stringify({ word, expectedLength }),
    }),
  listPublicLobbies: () =>
    request<{
      openLobbies: Array<{ code: string; host: string; createdAt: number; players: number }>;
      activeGamesCount: number;
      waitingPublicCount: number;
    }>("/api/games/public-lobbies"),
  getPlayerGames: () => request<{ games: RecentGameSummary[] }>("/api/games"),
  getLeaderboard: () => request<{ leaderboard: LeaderboardEntry[] }>("/api/leaderboard"),
  createGame: (payload: { username: string; secretWord: string; public: boolean }) =>
    request<{ gameId: string; code: string }>("/api/games", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  joinGame: (payload: { code: string; username: string; secretWord: string }) =>
    request<{ gameId: string }>("/api/games/join", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  matchmake: (payload: { username: string; secretWord: string }) =>
    request<{ gameId: string }>("/api/games/matchmake", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  createBotGame: (payload: { username: string; secretWord: string; difficulty: "easy" | "medium" | "hard" }) =>
    request<{ gameId: string; code: string; botName: string }>("/api/games/bot", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  getGameState: async (gameId: string) =>
    normalizeGameStateResponse(await request<LegacyGameStateResponse>(`/api/games/${gameId}`)),
  submitGuess: (gameId: string, payload: { type: "fourLetter" | "fullWord"; text: string }) =>
    request<{
      matchCount: number;
      isCorrect: boolean;
      guessNumber: number;
      gameStatus: "active" | "completed";
    }>(`/api/games/${gameId}/guess`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  leaveWaitingGame: (gameId: string) =>
    request<{ cancelled: true }>(`/api/games/${gameId}/leave`, {
      method: "POST",
    }),
  forfeitGame: (gameId: string) =>
    request<{ status: "completed"; winnerPlayerId: string }>(`/api/games/${gameId}/forfeit`, {
      method: "POST",
    }),
  updateAlphabet: (
    gameId: string,
    payload: { letter: string; state: "present" | "absent" | "unknown" }
  ) =>
    request<{ alphabet: Record<string, "present" | "absent" | "unknown"> }>(
      `/api/games/${gameId}/alphabet`,
      {
        method: "PATCH",
        body: JSON.stringify(payload),
      }
    ),
  markGamePresenceOffline: (gameId: string, options?: { keepalive?: boolean }) =>
    request<{ presence: "offline" }>(`/api/games/${gameId}/presence/offline`, {
      method: "POST",
      keepalive: options?.keepalive,
    }),
  getSocialOverview: () => request<{ social: SocialOverview }>("/api/social"),
  searchUsers: (query: string) =>
    request<{ results: SocialSearchResult[] }>(
      `/api/social/search?q=${encodeURIComponent(query)}`
    ),
  sendFriendRequest: (targetIdentifier: string) =>
    request<{ requestId: string; status: "pending" | "accepted"; becameFriends: boolean }>(
      "/api/social/requests",
      {
        method: "POST",
        body: JSON.stringify({ targetIdentifier }),
      }
    ),
  acceptFriendRequest: (requestId: string) =>
    request<{ ok: true }>(`/api/social/requests/${requestId}/accept`, {
      method: "POST",
    }),
  declineFriendRequest: (requestId: string) =>
    request<{ ok: true }>(`/api/social/requests/${requestId}/decline`, {
      method: "POST",
    }),
  cancelFriendRequest: (requestId: string) =>
    request<{ ok: true }>(`/api/social/requests/${requestId}/cancel`, {
      method: "POST",
    }),
  removeFriend: (friendUserId: string) =>
    request<{ ok: true }>(`/api/social/friends/${friendUserId}`, {
      method: "DELETE",
    }),
  sendGameInvite: (gameId: string, receiverUserId: string) =>
    request<{ inviteId: string }>("/api/social/game-invites", {
      method: "POST",
      body: JSON.stringify({ gameId, receiverUserId }),
    }),
  sendGameInviteByUsername: (gameId: string, username: string) =>
    request<{ inviteId: string; receiverDisplayName: string }>(
      "/api/social/game-invites/by-username",
      {
        method: "POST",
        body: JSON.stringify({ gameId, username }),
      }
    ),
  acceptGameInvite: (inviteId: string, payload: { username: string; secretWord: string }) =>
    request<{ gameId: string }>(`/api/social/game-invites/${inviteId}/accept`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  declineGameInvite: (inviteId: string) =>
    request<{ ok: true }>(`/api/social/game-invites/${inviteId}/decline`, {
      method: "POST",
    }),
  cancelGameInvite: (inviteId: string) =>
    request<{ ok: true }>(`/api/social/game-invites/${inviteId}/cancel`, {
      method: "POST",
    }),
};
