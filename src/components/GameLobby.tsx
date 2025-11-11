import { useState } from "react";
import { useMutation, useQuery, useAction } from "convex/react";
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
  const [difficulty, setDifficulty] = useState<"easy" | "standard" | "hard">("standard");
  
  const createGame = useAction(api.games.createGame);
  const joinGame = useAction(api.games.joinGame);
  const loggedInUser = useQuery(api.auth.loggedInUser);

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
        public: false,
        mode,
        difficulty: mode === "vs_ai" ? difficulty : undefined,
      });
      
      if (mode === "pvp") {
        toast.success(`Game created! Share code: ${result.code}`);
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

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Create Game */}
          <div className="space-y-4">
            <h3 className="text-lg font-semibold text-gray-900">Create New Game</h3>
            
            <button
              onClick={() => handleCreateGame("pvp")}
              disabled={!username.trim() || isCreating}
              className="w-full bg-indigo-600 text-white py-3 px-6 rounded-lg font-semibold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isCreating ? "Creating..." : "Create PvP Game"}
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
    </div>
  );
}
