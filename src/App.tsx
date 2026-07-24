import { Toaster } from "sonner";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { FriendView } from "../shared/types";
import { GameLobby } from "./components/GameLobby";
import { GameBoard } from "./components/GameBoard";
import { Leaderboard } from "./components/Leaderboard";
import { RecentGamesPanel } from "./components/RecentGamesPanel";
import { ScreenErrorBoundary } from "./components/ScreenErrorBoundary";
import { FriendsPanel } from "./components/social/FriendsPanel";
import { GuestInvitesPanel } from "./components/social/GuestInvitesPanel";
import { SocialDataProvider } from "./components/social/SocialDataProvider";
import { SocialInbox } from "./components/social/SocialInbox";
import { SignInForm } from "./SignInForm";
import { SignOutButton } from "./SignOutButton";
import { useAuth } from "./lib/auth";
import { api } from "./lib/api";
import {
  clearActiveGame,
  createDefaultPlayState,
  readStoredPlayState,
  writeStoredPlayState,
  type PlayState,
} from "./lib/playState";
import { usePollingQuery } from "./lib/usePollingQuery";

function isRecoverableInviteLobbyError(message: string) {
  return /waiting game not found|game not found|no longer available|already started|game is full/i.test(message);
}

export default function App() {
  const { user } = useAuth();

  // Mobile keyboard: we deliberately do NOTHING. iOS pans the page up so the
  // focused input sits above the keyboard, and pans back on blur. That native
  // slide is smooth; every JS "correction" we tried (scroll resets, fixed
  // shells, transform-following) turned it into a visible bounce. The layout
  // is a plain 100svh column with the composer at the bottom, and the page is
  // allowed to move while typing.

  // On-device viewport debug HUD: open the app with #vvdebug in the URL to
  // get a live readout of scrollY / visualViewport height & offsetTop. Used
  // to diagnose iOS keyboard jank on real hardware, where no desktop tool can
  // reproduce the behavior. Zero cost unless the hash is present.
  useEffect(() => {
    if (!window.location.hash.includes("vvdebug")) {
      return;
    }
    const hud = document.createElement("div");
    hud.style.cssText =
      "position:fixed;top:4px;left:4px;z-index:99999;background:rgba(0,0,0,0.82);color:#4ade80;" +
      "font:11px/1.5 ui-monospace,Menlo,monospace;padding:6px 8px;border-radius:6px;pointer-events:none;white-space:pre";
    document.body.appendChild(hud);
    const vv = window.visualViewport;
    let lastEvent = "init";
    const render = () => {
      hud.textContent =
        `scrollY ${Math.round(window.scrollY)}\n` +
        `vv.h ${vv ? Math.round(vv.height) : "-"} / win ${window.innerHeight}\n` +
        `vv.offTop ${vv ? Math.round(vv.offsetTop) : "-"}\n` +
        `focus ${document.activeElement?.tagName ?? "-"}\n` +
        `last ${lastEvent}`;
    };
    const on = (name: string) => () => {
      lastEvent = `${name} @${Math.round(performance.now() / 100) / 10}s`;
      render();
    };
    const handlers: Array<[EventTarget, string]> = [
      [window, "scroll"],
      [window, "resize"],
      [window, "focusin"],
      [window, "focusout"],
    ];
    if (vv) {
      handlers.push([vv, "resize"], [vv, "scroll"]);
    }
    const bound = handlers.map(([t, n]) => {
      const h = on(n);
      t.addEventListener(n, h, { passive: true });
      return [t, n, h] as const;
    });
    const interval = window.setInterval(render, 250);
    render();
    return () => {
      window.clearInterval(interval);
      bound.forEach(([t, n, h]) => t.removeEventListener(n, h));
      hud.remove();
    };
  }, []);

  return (
    <div className="flex h-[100svh] flex-col overflow-x-clip bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.96),_rgba(242,240,235,0.86)_35%,_rgba(236,232,223,1)_100%)] text-zinc-900 lg:h-auto lg:min-h-[100svh]">
      <ScreenErrorBoundary resetKey={user?.id ?? "anonymous"}>
        <Content key={user?.id ?? "anonymous"} />
      </ScreenErrorBoundary>
      {/* Offset below the header so toasts never cover the top bar (screen
          recording showed match-count toasts painting over it, which read as
          the header glitching during keyboard transitions). */}
      <Toaster position="top-center" offset={{ top: 64 }} mobileOffset={{ top: 60 }} duration={2500} />
    </div>
  );
}

function Content() {
  const { user, loading, isAuthenticated } = useAuth();

  const recentGamesQuery = usePollingQuery(() => api.getPlayerGames(), [user?.id], {
    enabled: isAuthenticated,
    // The recent-games panel isn't a realtime surface — bumping from 1s to 5s
    // cuts ~80% of DB load with no user-visible change. The active game itself
    // uses WebSockets for realtime updates.
    intervalMs: 5000,
  });

  const [playState, setPlayState] = useState<PlayState>(() =>
    user?.id ? readStoredPlayState(user.id, user) : createDefaultPlayState(user)
  );
  const [openFriendsPanel, setOpenFriendsPanel] = useState(false);
  const [openInbox, setOpenInbox] = useState(false);
  const [openGuestInvites, setOpenGuestInvites] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !user?.id) {
      return;
    }
    writeStoredPlayState(user.id, playState);
  }, [playState, user?.id]);

  const { username, secretWord, currentGameId, gamePhase, lobbyCode: gameCode, isPublic } = playState;

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
      const created = createdGame;
      await api.sendGameInvite(created.gameId, friend.userId);
      toast.success(`Room ${created.code} created and invite sent to ${friend.displayName}.`);
      setPlayState((prev) => ({ ...prev, currentGameId: created.gameId, gamePhase: "playing", lobbyCode: "" }));
    } catch (error) {
      if (createdGame) {
        const created = createdGame;
        setPlayState((prev) => ({ ...prev, currentGameId: created.gameId, gamePhase: "playing", lobbyCode: "" }));
        throw error instanceof Error
          ? new Error(`${error.message} Your room was still created, so you can invite again from there.`)
          : new Error("Your room was created, but the invite could not be sent.");
      }
      throw error instanceof Error ? error : new Error("Unable to create the room right now.");
    }
  }

  const canUseSocial = isAuthenticated && !user?.isAnonymous;
  const isGuestSignedIn = isAuthenticated && Boolean(user?.isAnonymous);

  async function handleGuestUsernameInvite(targetUsername: string) {
    const trimmedUsername = username.trim();
    const normalizedSecret = secretWord.trim();

    if (!normalizedSecret) {
      setPlayState((prev) => ({ ...prev, gamePhase: "setup" }));
      toast("Choose your secret word first, then send the invite.");
      throw new Error("Set your secret word first.");
    }
    if (!trimmedUsername) {
      setPlayState((prev) => ({ ...prev, gamePhase: "lobby" }));
      toast("Set your display name first, then send the invite.");
      throw new Error("Set your display name first.");
    }

    if (gamePhase === "playing" && currentGameId) {
      try {
        const response = await api.getGameState(currentGameId);
        if (response.gameState?.game.status === "waiting") {
          const result = await api.sendGameInviteByUsername(currentGameId, targetUsername);
          toast.success(`Invite sent to ${result.receiverDisplayName}.`);
          return;
        }
        if (response.gameState) {
          toast("Finish this game or return to the lobby before sending a new invite.");
          throw new Error("Cannot invite while a game is active.");
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

    if (reusableWaitingGame) {
      try {
        const result = await api.sendGameInviteByUsername(reusableWaitingGame.gameId, targetUsername);
        toast.success(`Invite sent to ${result.receiverDisplayName} in room ${reusableWaitingGame.code}.`);
        setPlayState((prev) => ({
          ...prev,
          currentGameId: reusableWaitingGame.gameId,
          gamePhase: "playing",
          lobbyCode: "",
        }));
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to reuse the current waiting room.";
        if (!isRecoverableInviteLobbyError(message)) {
          throw error instanceof Error ? error : new Error(message);
        }
        setPlayState((prev) => clearActiveGame(prev));
      }
    }

    let createdGame: { gameId: string; code: string } | null = null;
    try {
      createdGame = await api.createGame({
        username: trimmedUsername,
        secretWord: normalizedSecret,
        public: false,
      });
      const created = createdGame;
      const result = await api.sendGameInviteByUsername(created.gameId, targetUsername);
      toast.success(`Room ${created.code} created and invite sent to ${result.receiverDisplayName}.`);
      setPlayState((prev) => ({
        ...prev,
        currentGameId: created.gameId,
        gamePhase: "playing",
        lobbyCode: "",
      }));
    } catch (error) {
      if (createdGame) {
        const created = createdGame;
        setPlayState((prev) => ({
          ...prev,
          currentGameId: created.gameId,
          gamePhase: "playing",
          lobbyCode: "",
        }));
        throw error instanceof Error
          ? new Error(`${error.message} Your room was still created, so you can invite again from there.`)
          : new Error("Your room was created, but the invite could not be sent.");
      }
      throw error instanceof Error ? error : new Error("Unable to create the room right now.");
    }
  }

  return (
    <SocialDataProvider>
      {/* Sticky only on desktop, where the page actually scrolls. On mobile the
          shell is a fixed one-screen column, so sticky buys nothing — and iOS
          recomputes sticky positioning during keyboard scroll churn, which made
          the header flicker in and out on dismissal. */}
      <header className="z-20 border-b border-zinc-800/90 bg-zinc-950/95 text-white backdrop-blur lg:sticky lg:top-0">
        <div className="mx-auto flex w-full max-w-5xl items-center gap-2 px-3 py-2.5 sm:px-4 md:px-6">
          <h1 className="shrink-0 font-display text-base font-bold tracking-tight text-white sm:text-xl">FourFive</h1>

          <div className="ml-auto flex shrink-0 items-center gap-1">
            {canUseSocial && (
              <FriendsPanel
                onQuickInvite={handleQuickInvite}
                forceOpen={openFriendsPanel}
                onForceOpenConsumed={() => setOpenFriendsPanel(false)}
              />
            )}
            {canUseSocial && (
              <SocialInbox
                secretWord={secretWord}
                displayName={username}
                onOpenGame={(gameId) => {
                  setPlayState((prev) => ({ ...prev, currentGameId: gameId, gamePhase: "playing", lobbyCode: "" }));
                }}
                forceOpen={openInbox}
                onForceOpenConsumed={() => setOpenInbox(false)}
              />
            )}
            {isGuestSignedIn && (
              <GuestInvitesPanel
                onSendInvite={handleGuestUsernameInvite}
                secretWord={secretWord}
                displayName={username}
                onOpenGame={(gameId) => {
                  setPlayState((prev) => ({ ...prev, currentGameId: gameId, gamePhase: "playing", lobbyCode: "" }));
                }}
                forceOpen={openGuestInvites}
                onForceOpenConsumed={() => setOpenGuestInvites(false)}
              />
            )}
            {isAuthenticated && <Leaderboard />}
            <SignOutButton />
          </div>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col px-3 pb-4 pt-2 sm:px-4 sm:pb-6 sm:pt-3 md:px-6 lg:px-8 lg:pb-8 lg:pt-4">
        <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col">
          <ScreenErrorBoundary resetKey={user?.id ?? "anonymous"}>
            {loading ? (
              <div className="space-y-4">
                <div className="h-12 animate-pulse rounded-xl border border-zinc-200 bg-white" />
                <div className="h-64 animate-pulse rounded-xl border border-zinc-200 bg-white" />
              </div>
            ) : !isAuthenticated ? (
              <div className="mx-auto max-w-xl">
                <SignInForm />
              </div>
            ) : gamePhase === "playing" && currentGameId ? (
              <GameBoard
                key={currentGameId}
                gameId={currentGameId}
                onExitToMenu={() => setPlayState((prev) => clearActiveGame(prev))}
              />
            ) : (
              <div className="space-y-6">
                <RecentGamesPanel
                  games={recentGames}
                  onOpenGame={(gameId) => {
                    setPlayState((prev) => ({ ...prev, currentGameId: gameId, gamePhase: "playing", lobbyCode: "" }));
                  }}
                />

                {recentGamesQuery.error && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                    Trouble refreshing recent games. Retrying in the background.
                  </div>
                )}

                {(gamePhase === "setup" || gamePhase === "lobby") && (
                  <GameLobby
                    secretWord={secretWord}
                    onSecretWordChange={(word) => setPlayState((prev) => ({ ...prev, secretWord: word }))}
                    username={username}
                    onUsernameChange={(value) => setPlayState((prev) => ({ ...prev, username: value }))}
                    onGameStart={(gameId) => {
                      setPlayState((prev) => ({ ...prev, currentGameId: gameId, gamePhase: "playing", lobbyCode: "" }));
                    }}
                    onPlayWithFriend={() => {
                      // Guests can't use the registered-only friends list, but they
                      // CAN invite by username via the guest invite composer.
                      if (user?.isAnonymous) {
                        setOpenGuestInvites(true);
                      } else {
                        setOpenFriendsPanel(true);
                      }
                    }}
                    onAcceptInvite={() => {
                      if (user?.isAnonymous) {
                        setOpenGuestInvites(true);
                      } else {
                        setOpenInbox(true);
                      }
                    }}
                  />
                )}
              </div>
            )}
          </ScreenErrorBoundary>
        </div>
      </main>
    </SocialDataProvider>
  );
}
