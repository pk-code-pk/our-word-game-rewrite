import { useState } from "react";
import { useQuery, useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import { toast } from "sonner";

interface GameLobbyProps {
  secretWord: string;
  onGameStart: (gameId: string) => void;
  onBackToSetup: () => void;
}

export function GameLobby({ secretWord, onGameStart, onBackToSetup }: GameLobbyProps) {
  const [username, setUsername] = useState("");
  const [gameCode, setGameCode] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [joiningPublicCode, setJoiningPublicCode] = useState<string | null>(null);
  const [difficulty, setDifficulty] = useState<"easy" | "standard" | "hard">("standard");
  const [isPublic, setIsPublic] = useState(false);
  
  const createGame = useAction(api.games.createGame);
  const joinGame = useAction(api.games.joinGame);
  const publicLobbyData = useQuery(api.games.listPublicLobbies);

  const handleCreateGame = async (mode: "pvp" | "vs_ai") => {
    if (!username.trim()) {
      toast.error("Please enter a username");
      return;
    }

    setIsCreating(true);
    
    try {
      const result = await createGame({
        username: username.trim(),
        secretWord,
        public: mode === "pvp" ? isPublic : false,
        mode,
        difficulty: mode === "vs_ai" ? difficulty : undefined,
      });
      
      if (mode === "pvp") {
        toast.success(isPublic ? "Public lobby created! Waiting for an opponent." : `Game created! Share code: ${result.code}`);
      } else {
        toast.success("AI game started!");
      }
      
      onGameStart(result.gameId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create game");
    } finally {
      setIsCreating(false);
    }
  };

  const handleJoinGame = async () => {
    if (!username.trim()) {
      toast.error("Please enter a username");
      return;
    }
    
    if (!gameCode.trim()) {
      toast.error("Please enter a game code");
      return;
    }

    setIsJoining(true);
    
    try {
      const result = await joinGame({
        code: gameCode.trim().toUpperCase(),
        username: username.trim(),
        secretWord,
      });
      
      toast.success("Joined game successfully!");
      onGameStart(result.gameId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to join game");
    } finally {
      setIsJoining(false);
    }
  };

  const handleJoinPublicGame = async (code: string) => {
    if (!username.trim()) {
      toast.error("Please enter a username");
      return;
    }

    setJoiningPublicCode(code);
    try {
      const result = await joinGame({
        code,
        username: username.trim(),
        secretWord,
      });

      toast.success("Joined game successfully!");
      onGameStart(result.gameId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to join game");
    } finally {
      setJoiningPublicCode(null);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="bg-white rounded-2xl shadow-md p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-2xl font-bold text-gray-900">Ready to Play!</h2>
          <button
            onClick={onBackToSetup}
            className="text-indigo-600 hover:text-indigo-800 font-medium"
          >
            Change Secret Word
          </button>
        </div>
        
        <div className="mb-6 p-4 bg-green-50 rounded-lg">
          <p className="text-green-800">
            <span className="font-semibold">Your secret word:</span> {secretWord}
          </p>
        </div>

        <div className="mb-6">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Your Username
          </label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Enter your username"
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          />
        </div>

        <div className="mb-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="bg-indigo-50 border border-indigo-100 rounded-lg p-4">
            <p className="text-indigo-900 font-semibold">Active games</p>
            <p className="text-2xl font-bold text-indigo-700">
              {publicLobbyData?.activeGamesCount ?? 0}
            </p>
          </div>
          <div className="bg-green-50 border border-green-100 rounded-lg p-4">
            <p className="text-green-900 font-semibold">Open public lobbies</p>
            <p className="text-2xl font-bold text-green-700">
              {publicLobbyData?.waitingPublicCount ?? 0}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Create Game */}
          <div className="space-y-4">
            <h3 className="text-lg font-semibold text-gray-900">Create New Game</h3>
            <div className="flex items-start gap-2">
              <input
                id="public-game-toggle"
                type="checkbox"
                checked={isPublic}
                onChange={(e) => setIsPublic(e.target.checked)}
                className="mt-1 h-4 w-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
              />
              <label htmlFor="public-game-toggle" className="text-sm text-gray-700">
                Make this a public lobby so anyone can join without a code when there's a free spot.
              </label>
            </div>
            
            <button
              onClick={() => handleCreateGame("pvp")}
              disabled={!username.trim() || isCreating}
              className="w-full bg-indigo-600 text-white py-3 px-6 rounded-lg font-semibold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isCreating ? "Creating..." : "Create Game"}
            </button>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-700">
                AI Difficulty
              </label>
              <select
                value={difficulty}
                onChange={(e) => setDifficulty(e.target.value as "easy" | "standard" | "hard")}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              >
                <option value="easy">Easy</option>
                <option value="standard">Standard</option>
                <option value="hard">Hard</option>
              </select>
              
              <button
                onClick={() => handleCreateGame("vs_ai")}
                disabled={!username.trim() || isCreating}
                className="w-full bg-green-600 text-white py-3 px-6 rounded-lg font-semibold hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isCreating ? "Creating..." : "Play vs AI"}
              </button>
            </div>
          </div>

          {/* Join Game */}
          <div className="space-y-4">
            <h3 className="text-lg font-semibold text-gray-900">Join Existing Game</h3>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Game Code
              </label>
              <input
                type="text"
                value={gameCode}
                onChange={(e) => setGameCode(e.target.value.toUpperCase())}
                placeholder="Enter game code"
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 font-mono text-2xl text-center tracking-wider"
              />
            </div>
            
            <button
              onClick={handleJoinGame}
              disabled={!username.trim() || !gameCode.trim() || isJoining}
              className="w-full bg-orange-600 text-white py-3 px-6 rounded-lg font-semibold hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isJoining ? "Joining..." : "Join Game"}
            </button>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-md p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-xl font-bold text-gray-900">Public Lobbies</h3>
            <p className="text-sm text-gray-600">Join a waiting player instantly when a spot is open.</p>
          </div>
        </div>

        {!publicLobbyData && (
          <div className="flex justify-center items-center py-6">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-600"></div>
          </div>
        )}

        {publicLobbyData && publicLobbyData.openLobbies.length === 0 && (
          <p className="text-gray-600">No public lobbies available right now. Create one to get started!</p>
        )}

        {publicLobbyData && publicLobbyData.openLobbies.length > 0 && (
          <div className="space-y-3">
            {publicLobbyData.openLobbies.map((lobby) => (
              <div
                key={lobby.code}
                className="border border-gray-200 rounded-lg p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
              >
                <div>
                  <p className="text-sm text-gray-500">Host</p>
                  <p className="font-semibold text-gray-900">{lobby.host}</p>
                  <p className="text-sm text-gray-600">Players: {lobby.players}/2</p>
                  <p className="text-xs text-gray-500">Code: {lobby.code}</p>
                </div>
                <button
                  onClick={() => handleJoinPublicGame(lobby.code)}
                  disabled={
                    !username.trim() ||
                    lobby.players >= 2 ||
                    joiningPublicCode === lobby.code
                  }
                  className="w-full sm:w-auto bg-green-600 text-white py-2 px-4 rounded-lg font-semibold hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {joiningPublicCode === lobby.code ? "Joining..." : "Join"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
