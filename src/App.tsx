import { Toaster } from "sonner";
import { useEffect, useRef, useState } from "react";
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
import { usePollingQuery } from "./lib/usePollingQuery";

export default function App() {
  const { user, isAuthenticated } = useAuth();
  const [currentView, setCurrentView] = useState<"game" | "leaderboard">("game");

  return (
    <div className="min-h-[100dvh] overflow-x-clip bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.96),_rgba(242,240,235,0.86)_35%,_rgba(236,232,223,1)_100%)] text-zinc-900">
      <header className="sticky top-0 z-20 border-b border-zinc-800/90 bg-zinc-950/95 text-white backdrop-blur">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-3 py-3 sm:px-4 md:flex-row md:items-center md:justify-between md:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-sm font-black text-zinc-950 shadow-sm">
              45
            </div>
            <div>
              <h1 className="text-lg font-display font-bold tracking-tight text-white sm:text-xl">FourFive</h1>
              <p className="hidden text-[11px] font-medium text-zinc-400 sm:block">Word deduction arena</p>
            </div>
          </div>
          <div className="flex w-full items-center justify-between gap-2 md:w-auto md:justify-end">
            <Nav currentView={currentView} onChange={setCurrentView} />
          </div>
        </div>
      </header>

      <main className="flex-1 px-3 py-4 sm:px-4 sm:py-6 md:px-6 lg:px-8 lg:py-8">
        <div className="mx-auto w-full max-w-5xl">
          <ScreenErrorBoundary resetKey={`${user?.id ?? "anonymous"}:${currentView}`}>
            {user?.isAnonymous ? (
              <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900 shadow-sm">
                <strong>Guest session.</strong> Sign in to save your progress and unlock social features.
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
    <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:justify-end">
      <nav className="grid flex-1 grid-cols-2 items-center rounded-xl border border-zinc-700 bg-zinc-900 p-1 shadow-sm sm:flex sm:flex-initial">
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
      <SignOutButton />
    </div>
  );
}

function Content() {
  const { user, loading, isAuthenticated } = useAuth();
  const recentGamesQuery = usePollingQuery(() => api.getPlayerGames(), [user?.id], {
    enabled: isAuthenticated,
    intervalMs: 5000,
  });

  const [secretWord, setSecretWord] = useState("");
  const [currentGameId, setCurrentGameId] = useState("");
  const [gamePhase, setGamePhase] = useState<"setup" | "lobby" | "playing">("setup");
  const previousUserIdRef = useRef<string | null>(null);
  const [username, setUsername] = useState("");
  const [socialRefreshKey, setSocialRefreshKey] = useState(0);

  function refreshSocialData() {
    setSocialRefreshKey((tick) => tick + 1);
  }

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (!user?.id) {
      setUsername("");
      return;
    }

    const scopedKey = `fourfive.username.${user.id}`;
    const storedUsername = window.localStorage.getItem(scopedKey) ?? user.username ?? "";

    // Legacy global usernames from older builds can bleed between accounts.
    if (window.localStorage.getItem("fourfive.username") !== null) {
      window.localStorage.removeItem("fourfive.username");
    }

    setUsername(storedUsername);
  }, [user?.id, user?.username]);

  useEffect(() => {
    if (typeof window === "undefined" || !user?.id) {
      return;
    }

    const scopedKey = `fourfive.username.${user.id}`;
    if (username.trim()) {
      window.localStorage.setItem(scopedKey, username);
    } else {
      window.localStorage.removeItem(scopedKey);
    }
  }, [username, user?.id]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (!user?.id) {
      setSecretWord("");
      return;
    }

    const scopedKey = `fourfive.secretWord.${user.id}`;
    const storedSecretWord = window.localStorage.getItem(scopedKey) ?? "";
    setSecretWord(storedSecretWord);
  }, [user?.id]);

  useEffect(() => {
    if (typeof window === "undefined" || !user?.id) {
      return;
    }

    const scopedKey = `fourfive.secretWord.${user.id}`;
    if (secretWord.trim()) {
      window.localStorage.setItem(scopedKey, secretWord.trim());
    } else {
      window.localStorage.removeItem(scopedKey);
    }
  }, [secretWord, user?.id]);

  useEffect(() => {
    const currentUserId = user?.id ?? null;
    if (previousUserIdRef.current !== currentUserId) {
      setSecretWord("");
      setCurrentGameId("");
      setGamePhase("setup");
      previousUserIdRef.current = currentUserId;
    }
  }, [user?.id]);

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

        toast("Finish this game or return to the lobby before starting a new invite room.");
        return;
      } catch (error) {
        throw error instanceof Error ? error : new Error("Unable to check the current room.");
      }
    }

    if (!secretWord) {
      setGamePhase("setup");
      toast("Choose your secret word first.");
      return;
    }

    if (!trimmedUsername) {
      setGamePhase("lobby");
      toast("Set your display name first, then tap + again.");
      return;
    }

    let createdGame: { gameId: string; code: string } | null = null;

    try {
      if (reusableWaitingGame) {
        await api.sendGameInvite(reusableWaitingGame.gameId, friend.userId);
        toast.success(`Invite sent to ${friend.displayName} in room ${reusableWaitingGame.code}.`);
        setCurrentGameId(reusableWaitingGame.gameId);
        setGamePhase("playing");
        return;
      }

      createdGame = await api.createGame({
        username: trimmedUsername,
        secretWord,
        public: false,
      });
      await api.sendGameInvite(createdGame.gameId, friend.userId);
      toast.success(`Room ${createdGame.code} created and invite sent to ${friend.displayName}.`);
      setCurrentGameId(createdGame.gameId);
      setGamePhase("playing");
    } catch (error) {
      if (createdGame) {
        setCurrentGameId(createdGame.gameId);
        setGamePhase("playing");
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
                setCurrentGameId(gameId);
                setGamePhase("playing");
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
            setCurrentGameId("");
            setGamePhase("setup");
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
              setCurrentGameId(gameId);
              setGamePhase("playing");
            }}
          />

          {user?.isAnonymous ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
                Friend requests and direct invites are available on saved accounts. Upgrade this guest session to keep your history and unlock the social hub.
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
              onSecretWordSet={(word) => {
                setSecretWord(word);
                setGamePhase("lobby");
              }}
            />
          )}

          {gamePhase === "lobby" && (
            <GameLobby
              secretWord={secretWord}
              username={username}
              onUsernameChange={setUsername}
              onGameStart={(gameId) => {
                setCurrentGameId(gameId);
                setGamePhase("playing");
              }}
              onBackToSetup={() => {
                setSecretWord("");
                setGamePhase("setup");
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
