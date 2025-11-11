import { useQuery, useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { useState, useEffect } from "react";
import { toast } from "sonner";
import { AlphabetBoard } from "./AlphabetBoard";

interface GameBoardProps {
  gameId: string;
  onGameEnd: () => void;
}

export function GameBoard({ gameId, onGameEnd }: GameBoardProps) {
  const gameState = useQuery(api.games.getGameState, { gameId: gameId as Id<"games"> });
  const submitGuess = useAction(api.games.submitGuess);
  const loggedInUser = useQuery(api.auth.loggedInUser);
  
  const [guessText, setGuessText] = useState("");
  const [guessType, setGuessType] = useState<"fourLetter" | "fullWord">("fourLetter");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const currentPlayer = gameState?.players.find(p => p.userId === loggedInUser?._id);
  const opponent = gameState?.players.find(p => p.userId !== loggedInUser?._id);
  const myGuesses = gameState?.guesses.filter(g => g.playerId === currentPlayer?._id) || [];
  const opponentGuesses = gameState?.guesses.filter(g => g.playerId === opponent?._id) || [];

  useEffect(() => {
    if (gameState?.game.status === "completed") {
      const winner = gameState.players.find(p => p._id === gameState.game.winnerId);
      if (winner) {
        toast.success(`Game Over! ${winner.username} wins!`);
      }
    }
  }, [gameState?.game.status, gameState?.players, gameState?.game.winnerId]);

  const handleSubmitGuess = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentPlayer || !guessText.trim() || isSubmitting) return;

    const word = guessText.trim().toUpperCase();
    
    // Validate length based on guess type
    if (guessType === "fourLetter" && word.length !== 4) {
      toast.error("Four-letter guesses must be exactly 4 letters");
      return;
    }
    if (guessType === "fullWord" && word.length !== 5) {
      toast.error("Full word guesses must be exactly 5 letters");
      return;
    }

    setIsSubmitting(true);
    
    try {
      const result = await submitGuess({
        gameId: gameId as Id<"games">,
        playerId: currentPlayer._id,
        type: guessType,
        text: word,
      });

      if (result.isCorrect) {
        toast.success("🎉 You guessed it correctly! You win!");
      } else if (guessType === "fullWord") {
        toast.success("Guess submitted! That's not the correct word.");
      } else {
        toast.success(
          `Guess submitted! ${result.matchCount} letter${result.matchCount !== 1 ? 's' : ''} match${result.matchCount === 1 ? 'es' : ''}`
        );
      }
      
      setGuessText("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to submit guess");
    } finally {
      setIsSubmitting(false);
    }
  };

  const renderGuessResult = (guess: any) => {
    if (guess.isCorrect) {
      return (
        <span className="px-2 py-1 rounded text-sm font-semibold bg-green-100 text-green-800">
          ✓ Correct!
        </span>
      );
    } else if (guess.type === "fullWord") {
      return (
        <span className="px-2 py-1 rounded text-sm font-semibold bg-red-100 text-red-800">
          ✗ Wrong word
        </span>
      );
    } else {
      return (
        <span className="px-2 py-1 rounded text-sm font-semibold bg-gray-100 text-gray-800">
          {guess.matchCount} match{guess.matchCount !== 1 ? 'es' : ''}
        </span>
      );
    }
  };

  if (!gameState || !currentPlayer) {
    return (
      <div className="flex justify-center items-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
      </div>
    );
  }

  const isGameActive = gameState.game.status === "active";
  const isWaitingForOpponent = gameState.game.status === "waiting";

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Left Panel - Game Board */}
      <div className="lg:col-span-2 bg-white rounded-2xl shadow-md p-6">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-2xl font-bold text-gray-900">Game Board</h2>
          <div className="text-sm text-gray-600">
            Status: <span className="font-semibold capitalize">{gameState.game.status}</span>
          </div>
        </div>

        {isWaitingForOpponent && (
          <div className="text-center py-8">
            <div className="animate-pulse text-lg text-gray-600">
              Waiting for opponent to join...
            </div>
            <div className="mt-4 text-sm text-gray-500">
              Game Code: <span className="font-mono font-bold">{gameState.game.code}</span>
            </div>
          </div>
        )}

        {opponent && (
          <div className="mb-6 grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-blue-50 rounded-lg p-4">
              <h3 className="font-semibold text-blue-900 mb-2">Your Guesses ({myGuesses.length})</h3>
              <div className="space-y-2 max-h-40 overflow-y-auto">
                {myGuesses.length === 0 ? (
                  <p className="text-blue-600 text-sm">No guesses yet</p>
                ) : (
                  myGuesses.map((guess) => (
                    <div key={guess._id} className="flex justify-between items-center bg-white rounded px-3 py-2">
                      <span className="font-mono font-bold">
                        {guess.text} {guess.type === "fullWord" && "🎯"}
                      </span>
                      {renderGuessResult(guess)}
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="bg-orange-50 rounded-lg p-4">
              <h3 className="font-semibold text-orange-900 mb-2">
                {opponent.username}'s Guesses ({opponentGuesses.length})
              </h3>
              <div className="space-y-2 max-h-40 overflow-y-auto">
                {opponentGuesses.length === 0 ? (
                  <p className="text-orange-600 text-sm">No guesses yet</p>
                ) : (
                  opponentGuesses.map((guess) => (
                    <div key={guess._id} className="flex justify-between items-center bg-white rounded px-3 py-2">
                      <span className="font-mono font-bold">
                        {guess.text} {guess.type === "fullWord" && "🎯"}
                      </span>
                      {renderGuessResult(guess)}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* Guess Input */}
        {isGameActive && (
          <form onSubmit={handleSubmitGuess} className="space-y-4">
            <div className="flex gap-4">
              <div className="flex-1">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Your Guess
                </label>
                <input
                  type="text"
                  value={guessText}
                  onChange={(e) => setGuessText(e.target.value.toUpperCase())}
                  placeholder={guessType === "fourLetter" ? "Enter 4-letter word" : "Enter 5-letter word"}
                  maxLength={guessType === "fourLetter" ? 4 : 5}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 font-mono text-lg"
                  disabled={isSubmitting}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Guess Type
                </label>
                <select
                  value={guessType}
                  onChange={(e) => setGuessType(e.target.value as "fourLetter" | "fullWord")}
                  className="px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  disabled={isSubmitting}
                >
                  <option value="fourLetter">4-Letter Guess</option>
                  <option value="fullWord">Full Word (5 letters)</option>
                </select>
              </div>
            </div>
            
            <button
              type="submit"
              disabled={!guessText.trim() || isSubmitting || 
                (guessType === "fourLetter" && guessText.length !== 4) ||
                (guessType === "fullWord" && guessText.length !== 5)
              }
              className="w-full bg-indigo-600 text-white py-3 px-6 rounded-lg font-semibold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isSubmitting ? "Submitting..." : "Submit Guess"}
            </button>
          </form>
        )}

        {gameState.game.status === "completed" && (
          <div className="mt-6 text-center">
            <button
              onClick={onGameEnd}
              className="bg-green-600 text-white py-2 px-6 rounded-lg font-semibold hover:bg-green-700 transition-colors"
            >
              Start New Game
            </button>
          </div>
        )}
      </div>

      {/* Right Panel - Alphabet Board */}
      <div className="lg:col-span-1">
        {currentPlayer && (
          <AlphabetBoard
            playerId={currentPlayer._id}
            alphabet={currentPlayer.alphabet}
            disabled={!isGameActive}
          />
        )}
      </div>
    </div>
  );
}
