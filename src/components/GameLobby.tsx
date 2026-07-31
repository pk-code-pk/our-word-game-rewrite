import { useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { HowToPlay } from "./HowToPlay";

interface GameLobbyProps {
  secretWord: string;
  onSecretWordChange: (word: string) => void;
  username: string;
  onUsernameChange: (username: string) => void;
  onGameStart: (gameId: string) => void;
  onPlayWithFriend: () => void;
  onAcceptInvite: () => void;
}

type WordStatus = "idle" | "checking" | "valid" | "invalid";

type BotDifficulty = "easy" | "medium" | "hard";

// UI copy only. The bot's real display name comes back from the server so the
// two can never drift apart.
const BOT_OPTIONS: Array<{ difficulty: BotDifficulty; label: string; blurb: string }> = [
  { difficulty: "easy", label: "Easy", blurb: "Guesses loosely, skips turns" },
  { difficulty: "medium", label: "Medium", blurb: "Solid, steady pace" },
  { difficulty: "hard", label: "Hard", blurb: "Sharp and fast" },
];

export function GameLobby({
  secretWord,
  onSecretWordChange,
  username,
  onUsernameChange,
  onGameStart,
  onPlayWithFriend,
  onAcceptInvite,
}: GameLobbyProps) {
  const [isFinding, setIsFinding] = useState(false);
  const [startingBot, setStartingBot] = useState<BotDifficulty | null>(null);
  const [wordStatus, setWordStatus] = useState<WordStatus>(() =>
    secretWord.length === 5 ? "valid" : "idle"
  );
  const [wordError, setWordError] = useState("");

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

  const handleFindGame = async () => {
    if (!hasUsername) { toast.error("Enter a display name"); return; }
    if (!(await ensureValidWord())) return;

    setIsFinding(true);
    try {
      const result = await api.matchmake({ username: username.trim(), secretWord });
      onGameStart(result.gameId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to find a match");
    } finally {
      setIsFinding(false);
    }
  };

  const handlePlayBot = async (difficulty: BotDifficulty) => {
    if (!hasUsername) { toast.error("Enter a display name"); return; }
    if (!(await ensureValidWord())) return;

    setStartingBot(difficulty);
    try {
      const result = await api.createBotGame({ username: username.trim(), secretWord, difficulty });
      toast.success(`${result.botName} picked a word. Go.`);
      onGameStart(result.gameId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not start a bot game");
    } finally {
      setStartingBot(null);
    }
  };

  // A game-start request is in flight. Any action that would navigate into a
  // different game has to wait, or the two `onGameStart` calls race and one of
  // the created games is orphaned.
  const isStartingGame = isFinding || startingBot !== null;
  // Adds word validation on top: the buttons that need a valid secret word.
  const isBusy = isStartingGame || wordStatus === "checking";

  return (
    <section className="mx-auto max-w-2xl">
      <div className="rounded-xl border border-zinc-200 bg-white shadow-sm">
        <div className="space-y-5 px-6 py-6">
          <div className="flex justify-end">
            <HowToPlay />
          </div>

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

          {/* Action buttons */}
          <div className="flex flex-col gap-2 sm:grid sm:grid-cols-3 sm:gap-3">
            <button
              type="button"
              onClick={handleFindGame}
              disabled={!hasUsername || isBusy}
              className="rounded-lg bg-zinc-900 py-3 font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isFinding ? "Finding opponent..." : "Find match"}
            </button>
            <button
              type="button"
              onClick={onPlayWithFriend}
              disabled={!hasUsername || isBusy}
              className="rounded-lg border border-zinc-300 bg-white py-3 font-semibold text-zinc-900 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Invite friend
            </button>
            <button
              type="button"
              onClick={onAcceptInvite}
              // Deliberately not gated on `hasUsername` or word validation —
              // reading your invites needs neither. Only blocked while a game
              // start is already in flight.
              disabled={isStartingGame}
              className="rounded-lg border border-zinc-300 bg-white py-3 font-semibold text-zinc-900 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Accept invite
            </button>
          </div>

          <p className="text-center text-xs text-zinc-500">
            <span className="font-medium text-zinc-600">Find match</span> pairs you with the next player online.{" "}
            <span className="font-medium text-zinc-600">Invite friend</span> and{" "}
            <span className="font-medium text-zinc-600">Accept invite</span> are for playing someone specific.
          </p>

          {/* Play the bot */}
          <div className="border-t border-zinc-200 pt-5">
            <div className="mb-2.5 flex items-baseline justify-between">
              <h2 className="text-sm font-medium text-zinc-700">Play the bot</h2>
              <span className="text-xs text-zinc-400">Starts instantly · unranked</span>
            </div>
            <div className="flex flex-col gap-2 sm:grid sm:grid-cols-3 sm:gap-3">
              {BOT_OPTIONS.map((option) => (
                <button
                  key={option.difficulty}
                  type="button"
                  onClick={() => handlePlayBot(option.difficulty)}
                  disabled={!hasUsername || isBusy}
                  className="rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-left transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span className="block font-semibold text-zinc-900">
                    {startingBot === option.difficulty ? "Starting..." : option.label}
                  </span>
                  <span className="mt-0.5 block text-xs text-zinc-500">{option.blurb}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
