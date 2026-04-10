import { Toaster } from "sonner";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { FriendView } from "../shared/types";
import { SecretWordSetup } from "./components/SecretWordSetup";
import { GameLobby } from "./components/GameLobby";
import { GameBoard } from "./components/GameBoard";
import { Leaderboard } from "./components/Leaderboard";
import { RecentGamesPanel } from "./components/RecentGamesPanel";
import { ScreenErrorBoundary } from "./components/ScreenErrorBoundary";
import { FriendsPanel } from "./components/social/FriendsPanel";
import { SocialInbox } from "./components/social/SocialInbox";
import { SignInForm } from "./SignInForm";
import { SignOutButton } from "./SignOutButton";
import { useAuth } from "./lib/auth";
import { api } from "./lib/api";
import {
  clearActiveGame,
  createDefaultPlayState,
  readStoredPlayState,
  resetPlayState,
  writeStoredPlayState,
  type PlayState,
} from "./lib/playState";
import { usePollingQuery } from "./lib/usePollingQuery";

function isRecoverableInviteLobbyError(message: string) {
  return /waiting game not found|game not found|no longer available|already started|game is full/i.test(message);
}

export default function App() {
  const { user } = useAuth();
  const [currentView, setCurrentView] = useState<"game" | "leaderboard">("game");

  return (
    <div className="min-h-[100dvh] overflow-x-clip bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.96),_rgba(242,240,235,0.86)_35%,_rgba(236,232,223,1)_100%)] text-zinc-900">
      <header className="sticky top-0 z-20 border-b border-zinc-800/90 bg-zinc-950/95 text-white backdrop-blur">
        <div className="mx-auto grid w-full max-w-5xl grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-3 sm:px-4 md:grid-cols-[auto_minmax(0,1fr)_auto] md:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-sm font-black text-zinc-950 shadow-sm">
              45
            </div>
            <div className="min-w-0">
              <h1 className="text-lg font-display font-bold tracking-tight text-white sm:text-xl">FourFive</h1>
              <p className="hidden text-[11px] font-medium text-zinc-400 sm:block">Word deduction arena</p>
            </div>
          </div>
          <div className="justify-self-end">
            <SignOutButton />
          </div>
          <div className="col-span-2 md:col-span-1 md:justify-self-end">
            <Nav currentView={currentView} onChange={setCurrentView} />
          </div>
        </div>
      </header>

      <main className="flex-1 px-3 py-4 sm:px-4 sm:py-6 md:px-6 lg:px-8 lg:py-8">
        <div className="mx-auto w-full max-w-5xl">
          <ScreenErrorBoundary resetKey={`${user?.id ?? "anonymous"}:${currentView}`}>
            {user?.isAnonymous ? (
              <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900 shadow-sm">
                <strong>Guest session.</strong> Create an account to keep your progress and unlock social features.
              </div>
            ) : null}
            {currentView === "game" ? <Content key={user?.id ?? "anonymous"} /> : <Leaderboard />}
          </ScreenErrorBoundary>
        </div>
      </main>

      <Toaster />
    </div>
  );
}

function Nav(props: {
  currentView: "game" | "leaderboard";
  onChange: (view: "game" | "leaderboard") => void;
}) {
  const { isAuthenticated } = useAuth();

  if (!isAuthenticated) {
    return null;
  }

  return (
    <div className="flex w-full items-center">
      <nav className="grid w-full grid-cols-2 items-center rounded-xl border border-zinc-700 bg-zinc-900 p-1 shadow-sm md:w-auto md:min-w-[15rem]">
        <button
          type="button"
          onClick={() => props.onChange("game")}
          className={`min-h-10 rounded-lg px-3 py-2 text-sm font-semibold transition-all ${
            props.currentView === "game"
              ? "bg-white text-zinc-900 shadow-sm"
              : "text-zinc-400 hover:text-white"
          }`}
        >
          Play
        </button>
        <button
          type="button"
          onClick={() => props.onChange("leaderboard")}
          className={`min-h-10 rounded-lg px-3 py-2 text-sm font-semibold transition-all ${
            props.currentView === "leaderboard"
              ? "bg-white text-zinc-900 shadow-sm"
              : "text-zinc-400 hover:text-white"
          }`}
        >
          Scores
        </button>
      </nav>
    </div>
  );
}

function Content() {
  const { user, loading, isAuthenticated } = useAuth();
  const recentGamesQuery = usePollingQuery(() => api.getPlayerGames(), [user?.id], {
    enabled: isAuthenticated,
    intervalMs: 5000,
  });

  const [playState, setPlayState] = useState<PlayState>(() =>
    user?.id ? readStoredPlayState(user.id, user) : createDefaultPlayState(user)
  );
  const [socialRefreshKey, setSocialRefreshKey] = useState(0);

  function refreshSocialData() {
    setSocialRefreshKey((tick) => tick + 1);
  }

  useEffect(() => {
    if (typeof window === "undefined" || !user?.id) {
      return;
    }

    writeStoredPlayState(user.id, playState);
  }, [playState, user?.id]);

  const { username, secretWord, currentGameId, gamePhase, lobbyCode: gameCode, isPublic } = playState;

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="space-y-3">
            <div className="h-4 w-28 animate-pulse rounded bg-zinc-100" />
            <div className="h-8 w-full max-w-sm animate-pulse rounded bg-zinc-100" />
          </div>
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <div className="h-16 animate-pulse rounded-lg bg-zinc-50" />
            <div className="h-16 animate-pulse rounded-lg bg-zinc-50" />
            <div className="h-16 animate-pulse rounded-lg bg-zinc-50" />
          </div>
        </div>
        <div className="h-64 animate-pulse rounded-xl border border-zinc-200 bg-white" />
      </div>
    );
  }

  const recentGames = recentGamesQuery.data?.games ?? [];
  const reusableWaitingGame = recentGames.find((game) => game.status === "waiting" && !game.isExpired) ?? null;

  async function handleQuickInvite(friend: FriendView) {
    const trimmedUsername = username.trim();

    if (gamePhase === "playing" && currentGameId) {
      try {
        const response = await api.getGameState(currentGameId);
        if (response.gameState?.game.status === "waiting") {
          await api.sendGameInvite(currentGameId, friend.userId);
          toast.success(`Invite sent to ${friend.displayName}.`);
          return;
        }

        if (response.gameState) {
          toast("Finish this game or return to the lobby before starting a new invite room.");
          return;
        }

        setPlayState((prev) => clearActiveGame(prev));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to check the current room.";
        if (!isRecoverableInviteLobbyError(message)) {
          throw error instanceof Error ? error : new Error(message);
        }

        setPlayState((prev) => clearActiveGame(prev));
      }
    }

    if (!secretWord) {
      setPlayState((prev) => ({ ...prev, gamePhase: "setup" }));
      toast("Choose your secret word first.");
      return;
    }

    if (!trimmedUsername) {
      setPlayState((prev) => ({ ...prev, gamePhase: "lobby" }));
      toast("Set your display name first, then tap + again.");
      return;
    }

    let createdGame: { gameId: string; code: string } | null = null;

    try {
      if (reusableWaitingGame) {
        try {
          await api.sendGameInvite(reusableWaitingGame.gameId, friend.userId);
          toast.success(`Invite sent to ${friend.displayName} in room ${reusableWaitingGame.code}.`);
          setPlayState((prev) => ({ ...prev, currentGameId: reusableWaitingGame.gameId, gamePhase: "playing", lobbyCode: "" }));
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unable to reuse the current waiting room.";
          if (!isRecoverableInviteLobbyError(message)) {
            throw error instanceof Error ? error : new Error(message);
          }

          setPlayState((prev) => clearActiveGame(prev));
        }
      }

      createdGame = await api.createGame({
        username: trimmedUsername,
        secretWord,
        public: false,
      });
      await api.sendGameInvite(createdGame.gameId, friend.userId);
      toast.success(`Room ${createdGame.code} created and invite sent to ${friend.displayName}.`);
      setPlayState((prev) => ({ ...prev, currentGameId: createdGame.gameId, gamePhase: "playing", lobbyCode: "" }));
    } catch (error) {
      if (createdGame) {
        setPlayState((prev) => ({ ...prev, currentGameId: createdGame.gameId, gamePhase: "playing", lobbyCode: "" }));
        throw error instanceof Error
          ? new Error(`${error.message} Your room was still created, so you can invite again from there.`)
          : new Error("Your room was created, but the invite could not be sent.");
      }

      throw error instanceof Error ? error : new Error("Unable to create the room right now.");
    }
  }

  const socialToolbar =
    isAuthenticated && !user?.isAnonymous ? (
      <div className="rounded-2xl border border-zinc-200 bg-white/90 p-3 shadow-sm sm:p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-400">Social</p>
            <p className="mt-1 text-sm text-zinc-600">
              Keep friends and invites tucked away here so the main game flow stays clean.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <FriendsPanel
              onQuickInvite={handleQuickInvite}
              refreshKey={socialRefreshKey}
              onSocialMutated={refreshSocialData}
            />
            <SocialInbox
              secretWord={secretWord}
              displayName={username}
              refreshKey={socialRefreshKey}
              onSocialMutated={refreshSocialData}
              onOpenGame={(gameId) => {
                setPlayState((prev) => ({ ...prev, currentGameId: gameId, gamePhase: "playing", lobbyCode: "" }));
              }}
            />
          </div>
        </div>
      </div>
    ) : null;

  if (gamePhase === "playing" && currentGameId) {
    return (
      <div className="space-y-4">
        {socialToolbar}
        <GameBoard
          key={currentGameId}
          gameId={currentGameId}
          onExitToMenu={() => {
            setPlayState((prev) => clearActiveGame(prev));
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {!isAuthenticated ? (
        <div className="mx-auto max-w-xl">
          <SignInForm />
        </div>
      ) : (
        <>
          {socialToolbar}

          <RecentGamesPanel
            games={recentGames}
            onOpenGame={(gameId) => {
              setPlayState((prev) => ({ ...prev, currentGameId: gameId, gamePhase: "playing", lobbyCode: "" }));
            }}
          />

          {user?.isAnonymous ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
                Friend requests and direct invites are available on saved accounts. Create an account to keep your history and unlock the social hub.
              </div>
              <div className="mx-auto max-w-xl">
                <SignInForm mode="upgrade" />
              </div>
            </div>
          ) : null}

          {recentGamesQuery.error && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              We had trouble refreshing your recent games, but the page will keep trying in the background.
            </div>
          )}

          {gamePhase === "setup" && (
            <SecretWordSetup
              secretWord={secretWord}
              onSecretWordChange={(word) => setPlayState((prev) => ({ ...prev, secretWord: word }))}
              onSecretWordSet={(word) => {
                setPlayState((prev) => ({ ...prev, secretWord: word, currentGameId: "", gamePhase: "lobby" }));
              }}
            />
          )}

          {gamePhase === "lobby" && (
            <GameLobby
              secretWord={secretWord}
              username={username}
              onUsernameChange={(value) => setPlayState((prev) => ({ ...prev, username: value }))}
              gameCode={gameCode}
              onGameCodeChange={(value) => setPlayState((prev) => ({ ...prev, lobbyCode: value }))}
              isPublic={isPublic}
              onIsPublicChange={(value) => setPlayState((prev) => ({ ...prev, isPublic: value }))}
              onGameStart={(gameId) => {
                setPlayState((prev) => ({ ...prev, currentGameId: gameId, gamePhase: "playing", lobbyCode: "" }));
              }}
              onBackToSetup={() => {
                setPlayState((prev) => resetPlayState(prev));
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
