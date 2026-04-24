import { useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { usePollingQuery } from "../lib/usePollingQuery";

interface GameLobbyProps {
  secretWord: string;
  onSecretWordChange: (word: string) => void;
  username: string;
  onUsernameChange: (username: string) => void;
  onGameStart: (gameId: string) => void;
}

type WordStatus = "idle" | "checking" | "valid" | "invalid";

export function GameLobby({
  secretWord,
  onSecretWordChange,
  username,
  onUsernameChange,
  onGameStart,
}: GameLobbyProps) {
  const [isFinding, setIsFinding] = useState(false);
  const [joiningPublicCode, setJoiningPublicCode] = useState<string | null>(null);
  const [wordStatus, setWordStatus] = useState<WordStatus>(() =>
    secretWord.length === 5 ? "valid" : "idle"
  );
  const [wordError, setWordError] = useState("");

  const publicLobbyQuery = usePollingQuery(() => api.listPublicLobbies(), [], { intervalMs: 3000 });
  const publicLobbyData = publicLobbyQuery.data;
  const openLobbies = publicLobbyData?.openLobbies ?? [];
  const activeGamesCount = publicLobbyData?.activeGamesCount ?? 0;
  const hasUsername = Boolean(username.trim());

  const validateWord = async (word: string): Promise<boolean> => {
    if (word.length !== 5) {
      setWordStatus("invalid");
      setWordError("Must be exactly 5 letters");
      return false;
    }
    if (new Set(word).size !== word.length) {
      setWordStatus("invalid");
      setWordError("No duplicate letters");
      return false;
    }
    setWordStatus("checking");
    try {
      const result = await api.validateWord(word, 5);
      if (!result.valid) {
        setWordStatus("invalid");
        setWordError(result.reason || "Not a valid word");
        return false;
      }
      setWordStatus("valid");
      setWordError("");
      return true;
    } catch {
      setWordStatus("invalid");
      setWordError("Could not validate");
      return false;
    }
  };

  const handleWordBlur = async () => {
    const word = secretWord.trim();
    if (!word || wordStatus === "valid") return;
    await validateWord(word);
  };

  const ensureValidWord = async (): Promise<boolean> => {
    if (wordStatus === "valid") return true;
    return validateWord(secretWord.trim());
  };

  const handleFindMatch = async () => {
    if (!hasUsername) {
      toast.error("Enter a display name");
      return;
    }
    if (!(await ensureValidWord())) return;

    setIsFinding(true);
    try {
      const result = await api.createGame({
        username: username.trim(),
        secretWord,
        public: true,
      });
      onGameStart(result.gameId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to find a match");
    } finally {
      setIsFinding(false);
    }
  };

  const handleJoinPublicGame = async (code: string) => {
    if (!hasUsername) {
      toast.error("Enter a display name");
      return;
    }
    if (!(await ensureValidWord())) return;

    setJoiningPublicCode(code);
    try {
      const result = await api.joinGame({
        code,
        username: username.trim(),
        secretWord,
      });
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
        {/* Stats */}
        <div className="border-b border-zinc-100 px-6 py-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Live now</p>
              <p className="mt-1 text-2xl font-black text-zinc-900">{activeGamesCount}</p>
            </div>
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-700">Waiting</p>
              <p className="mt-1 text-2xl font-black text-amber-900">{openLobbies.length}</p>
            </div>
          </div>
        </div>

        <div className="space-y-5 px-6 py-6">
          {/* Secret word */}
          <div>
            <label htmlFor="lobby-secret-word" className="mb-1.5 block text-sm font-medium text-zinc-700">
              Secret word
            </label>
            <input
              id="lobby-secret-word"
              type="text"
              value={secretWord}
              onChange={(e) => {
                onSecretWordChange(e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 5));
                setWordStatus("idle");
                setWordError("");
              }}
              onBlur={handleWordBlur}
              placeholder="_ _ _ _ _"
              maxLength={5}
              autoCapitalize="characters"
              spellCheck={false}
              disabled={wordStatus === "checking"}
              className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 font-mono text-2xl font-bold tracking-[0.35em] text-center text-zinc-900 outline-none transition focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-100 disabled:opacity-50"
            />
            <div className="mt-1.5 flex items-center justify-between text-xs">
              <span className="text-zinc-400">5 letters · no repeats · real word</span>
              {wordStatus === "checking" && <span className="text-zinc-400">Checking...</span>}
              {wordStatus === "valid" && <span className="font-medium text-emerald-600">✓ Valid</span>}
              {wordStatus === "invalid" && <span className="font-medium text-rose-500">{wordError}</span>}
            </div>
          </div>

          {/* Display name */}
          <div>
            <label htmlFor="lobby-display-name" className="mb-1.5 block text-sm font-medium text-zinc-700">
              Display name
            </label>
            <input
              id="lobby-display-name"
              type="text"
              value={username}
              onChange={(e) => onUsernameChange(e.target.value)}
              placeholder="Your username"
              maxLength={20}
              autoComplete="nickname"
              className="w-full rounded-lg border border-zinc-200 bg-white px-4 py-2.5 text-[16px] text-zinc-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            />
          </div>

          {/* Find Match */}
          <button
            type="button"
            onClick={handleFindMatch}
            disabled={!hasUsername || isFinding || wordStatus === "checking"}
            className="w-full rounded-lg bg-zinc-900 py-3 font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isFinding ? "Finding match..." : "Find Match"}
          </button>

          {/* Players waiting */}
          {(openLobbies.length > 0 || publicLobbyQuery.loading) && (
            <div>
              <h3 className="mb-3 font-semibold text-zinc-900">Players waiting</h3>

              {publicLobbyQuery.loading && !publicLobbyData ? (
                <div className="space-y-2">
                  <div className="h-14 animate-pulse rounded-lg bg-zinc-100" />
                  <div className="h-14 animate-pulse rounded-lg bg-zinc-100" />
                </div>
              ) : (
                <ul className="space-y-2">
                  {openLobbies.map((lobby) => (
                    <li
                      key={lobby.code}
                      className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-semibold text-zinc-900">{lobby.host}</span>
                        <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-500">
                          {lobby.players}/2
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleJoinPublicGame(lobby.code)}
                        disabled={
                          !hasUsername || lobby.players >= 2 || joiningPublicCode === lobby.code || wordStatus === "checking"
                        }
                        className="shrink-0 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {joiningPublicCode === lobby.code ? "Joining..." : "Join"}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
