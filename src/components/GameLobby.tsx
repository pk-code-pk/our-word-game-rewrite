import { useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { usePollingQuery } from "../lib/usePollingQuery";

interface GameLobbyProps {
  secretWord: string;
  username: string;
  onUsernameChange: (username: string) => void;
  gameCode: string;
  onGameCodeChange: (code: string) => void;
  isPublic: boolean;
  onIsPublicChange: (isPublic: boolean) => void;
  onGameStart: (gameId: string) => void;
  onBackToSetup: () => void;
}

export function GameLobby({
  secretWord,
  username,
  onUsernameChange,
  gameCode,
  onGameCodeChange,
  isPublic,
  onIsPublicChange,
  onGameStart,
  onBackToSetup,
}: GameLobbyProps) {
  const [isCreating, setIsCreating] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [joiningPublicCode, setJoiningPublicCode] = useState<string | null>(null);

  const publicLobbyQuery = usePollingQuery(() => api.listPublicLobbies(), [], { intervalMs: 3000 });
  const publicLobbyData = publicLobbyQuery.data;
  const openLobbies = publicLobbyData?.openLobbies ?? [];
  const activeGamesCount = publicLobbyData?.activeGamesCount ?? 0;
  const waitingPublicCount = publicLobbyData?.waitingPublicCount ?? 0;
  const hasUsername = Boolean(username.trim());

  const handleCreateGame = async () => {
    if (!hasUsername) {
      toast.error("Please enter a username");
      return;
    }

    setIsCreating(true);
    try {
      const result = await api.createGame({
        username: username.trim(),
        secretWord,
        public: isPublic,
      });
      toast.success(isPublic ? "Public lobby created! Waiting for an opponent." : `Game created! Share code: ${result.code}`);

      setIsCreating(false);
      onGameStart(result.gameId);
    } catch (error) {
      setIsCreating(false);
      toast.error(error instanceof Error ? error.message : "Failed to create game");
    }
  };

  const handleJoinGame = async () => {
    if (!hasUsername) {
      toast.error("Please enter a username");
      return;
    }
    if (!gameCode.trim()) {
      toast.error("Please enter a game code");
      return;
    }

    setIsJoining(true);
    try {
      const result = await api.joinGame({
        code: gameCode.trim().toUpperCase(),
        username: username.trim(),
        secretWord,
      });
      toast.success("Joined game successfully!");
      setIsJoining(false);
      onGameStart(result.gameId);
    } catch (error) {
      setIsJoining(false);
      toast.error(error instanceof Error ? error.message : "Failed to join game");
    }
  };

  const handleJoinPublicGame = async (code: string) => {
    if (!hasUsername) {
      toast.error("Please enter a username");
      return;
    }

    setJoiningPublicCode(code);
    try {
      const result = await api.joinGame({
        code,
        username: username.trim(),
        secretWord,
      });
      toast.success("Joined game successfully!");
      setJoiningPublicCode(null);
      onGameStart(result.gameId);
    } catch (error) {
      setJoiningPublicCode(null);
      toast.error(error instanceof Error ? error.message : "Failed to join game");
    }
  };

  return (
    <section className="mx-auto max-w-2xl">
      <div className="rounded-xl border border-zinc-200 bg-white shadow-sm">
        {/* Header */}
        <div className="border-b border-zinc-100 px-6 py-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-zinc-400">Step 2 of 2</p>
              <h2 className="mt-1.5 font-display text-2xl font-bold tracking-tight text-zinc-900">Set up your match</h2>
            </div>
            <button
              onClick={onBackToSetup}
              className="shrink-0 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-600 transition hover:bg-zinc-50"
            >
              ← Change word
            </button>
          </div>

          {/* Stats row */}
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700">Your word</p>
              <p className="mt-1 font-mono text-xl font-black tracking-[0.25em] text-emerald-900">{secretWord}</p>
            </div>
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Live now</p>
              <p className="mt-1 text-2xl font-black text-zinc-900">{activeGamesCount}</p>
            </div>
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-700">Open rooms</p>
              <p className="mt-1 text-2xl font-black text-amber-900">{waitingPublicCount}</p>
            </div>
          </div>
        </div>

        <div className="px-6 py-6 space-y-6">
          {/* Username */}
          <div>
            <label htmlFor="lobby-display-name" className="mb-1.5 block text-sm font-medium text-zinc-700">
              Display name
            </label>
            <input
              id="lobby-display-name"
              type="text"
              value={username}
              onChange={(e) => onUsernameChange(e.target.value)}
              placeholder="Enter your username"
              maxLength={20}
              autoComplete="nickname"
              className="w-full rounded-lg border border-zinc-200 bg-white px-4 py-2.5 text-[16px] text-zinc-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            />
          </div>

          {/* Create / Join */}
          <div className="grid gap-4 sm:grid-cols-2">
            {/* Create */}
            <div className="rounded-lg border border-zinc-200 p-4">
              <h3 className="font-semibold text-zinc-900">Create game</h3>
              <div className="mt-3 grid grid-cols-2 rounded-xl border border-zinc-200 bg-zinc-50 p-1">
                <button
                  type="button"
                  onClick={() => onIsPublicChange(false)}
                  className={`flex min-h-10 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold transition ${
                    !isPublic
                      ? "border-zinc-900 bg-white text-zinc-900 shadow-sm"
                      : "border-transparent text-zinc-700 hover:border-zinc-200 hover:bg-white/70"
                  }`}
                  aria-pressed={!isPublic}
                >
                  <span
                    className={`h-2.5 w-2.5 rounded-full border ${
                      !isPublic ? "border-zinc-900 bg-zinc-900" : "border-zinc-400 bg-transparent"
                    }`}
                    aria-hidden="true"
                  />
                  Private
                </button>
                <button
                  type="button"
                  onClick={() => onIsPublicChange(true)}
                  className={`flex min-h-10 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold transition ${
                    isPublic
                      ? "border-zinc-900 bg-white text-zinc-900 shadow-sm"
                      : "border-transparent text-zinc-700 hover:border-zinc-200 hover:bg-white/70"
                  }`}
                  aria-pressed={isPublic}
                >
                  <span
                    className={`h-2.5 w-2.5 rounded-full border ${
                      isPublic ? "border-zinc-900 bg-zinc-900" : "border-zinc-400 bg-transparent"
                    }`}
                    aria-hidden="true"
                  />
                  Public
                </button>
              </div>
              <button
                type="button"
                onClick={handleCreateGame}
                disabled={!hasUsername || isCreating}
                className="mt-4 w-full rounded-lg bg-zinc-900 py-2.5 font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isCreating ? "Creating..." : "Create Game"}
              </button>
              <p className="mt-2 text-xs leading-5 text-zinc-500">
                Create the room first, then use the Friends drawer above to invite someone with the + button.
              </p>
            </div>

            {/* Join */}
            <div className="rounded-lg border border-zinc-200 p-4">
              <h3 className="font-semibold text-zinc-900">Join with code</h3>
              <div className="mt-3">
                <input
                  type="text"
                  value={gameCode}
                  onChange={(e) => onGameCodeChange(e.target.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase())}
                  placeholder="XXXXXX"
                  maxLength={6}
                  autoCapitalize="characters"
                  spellCheck={false}
                  className="w-full rounded-lg border border-zinc-200 bg-white px-4 py-2.5 font-mono text-xl font-bold tracking-[0.3em] text-center text-zinc-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                />
              </div>
              <button
                type="button"
                onClick={handleJoinGame}
                disabled={!hasUsername || !gameCode.trim() || isJoining}
                className="mt-4 w-full rounded-lg border border-zinc-900 bg-white py-2.5 font-semibold text-zinc-900 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isJoining ? "Joining..." : "Join Game"}
              </button>
            </div>
          </div>

          {publicLobbyQuery.error && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
              Trouble loading public lobbies — you can still create or join directly.
            </div>
          )}

          {/* Public lobbies */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-zinc-900">Public lobbies</h3>
              <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-semibold text-zinc-500">{openLobbies.length}</span>
            </div>

            {publicLobbyQuery.loading && !publicLobbyData && (
              <div className="space-y-2">
                <div className="h-14 animate-pulse rounded-lg bg-zinc-100" />
                <div className="h-14 animate-pulse rounded-lg bg-zinc-100" />
              </div>
            )}

            {publicLobbyData && openLobbies.length === 0 && (
              <div className="rounded-lg border border-dashed border-zinc-200 px-4 py-5 text-center text-sm text-zinc-400">
                No public lobbies right now. Create one to appear here.
              </div>
            )}

            {openLobbies.length > 0 && (
              <ul className="space-y-2">
                {openLobbies.map((lobby) => (
                  <li
                    key={lobby.code}
                    className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-zinc-900">{lobby.host}</span>
                        <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-500">{lobby.players}/2</span>
                      </div>
                      <p className="font-mono text-xs font-semibold tracking-widest text-zinc-400">{lobby.code}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleJoinPublicGame(lobby.code)}
                      disabled={!hasUsername || lobby.players >= 2 || joiningPublicCode === lobby.code}
                      className="shrink-0 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40 sm:self-auto"
                    >
                      {joiningPublicCode === lobby.code ? "Joining..." : "Join"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
