import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";

interface AlphabetBoardProps {
  playerId: Id<"players">;
  alphabet: Record<string, "present" | "absent" | "unknown">;
  disabled?: boolean;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

export function AlphabetBoard({ playerId, alphabet, disabled = false }: AlphabetBoardProps) {
  const updateAlphabet = useMutation(api.games.updateAlphabet);
  const [isUpdating, setIsUpdating] = useState<string | null>(null);

  const handleLetterClick = async (letter: string) => {
    if (disabled || isUpdating) return;

    setIsUpdating(letter);
    
    try {
      const currentState = alphabet[letter] || "unknown";
      let newState: "present" | "absent" | "unknown";
      
      // Cycle through states: unknown -> present -> absent -> unknown
      switch (currentState) {
        case "unknown":
          newState = "present";
          break;
        case "present":
          newState = "absent";
          break;
        case "absent":
          newState = "unknown";
          break;
        default:
          newState = "unknown";
      }

      await updateAlphabet({
        playerId,
        letter,
        state: newState,
      });
    } catch (error) {
      console.error("Failed to update alphabet:", error);
    } finally {
      setIsUpdating(null);
    }
  };

  const getLetterStyle = (letter: string) => {
    const state = alphabet[letter] || "unknown";
    const isLoading = isUpdating === letter;
    
    let baseClasses = "w-10 h-10 rounded-lg border-2 font-bold text-sm transition-all duration-200 cursor-pointer select-none flex items-center justify-center";
    
    if (disabled) {
      baseClasses += " cursor-not-allowed opacity-50";
    } else if (!isLoading) {
      baseClasses += " hover:scale-105 active:scale-95";
    }

    switch (state) {
      case "present":
        return `${baseClasses} bg-green-100 border-green-500 text-green-800 shadow-md`;
      case "absent":
        return `${baseClasses} bg-red-100 border-red-500 text-red-800 shadow-md`;
      case "unknown":
      default:
        return `${baseClasses} bg-gray-100 border-gray-300 text-gray-700 hover:bg-gray-200`;
    }
  };

  return (
    <div className="bg-white rounded-2xl shadow-md p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-4 text-center">
        Alphabet Board
      </h3>
      <p className="text-sm text-gray-600 mb-4 text-center">
        Click letters to mark them as present (green) or absent (red)
      </p>
      
      <div className="grid grid-cols-7 gap-2 max-w-sm mx-auto">
        {ALPHABET.map((letter) => (
          <button
            key={letter}
            onClick={() => handleLetterClick(letter)}
            disabled={disabled || isUpdating === letter}
            className={getLetterStyle(letter)}
            title={
              alphabet[letter] === "present" 
                ? "Present in opponent's word" 
                : alphabet[letter] === "absent"
                ? "Not in opponent's word"
                : "Unknown - click to mark"
            }
          >
            {isUpdating === letter ? (
              <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
            ) : (
              letter
            )}
          </button>
        ))}
      </div>

      <div className="mt-4 flex justify-center space-x-4 text-xs text-gray-600">
        <div className="flex items-center space-x-1">
          <div className="w-3 h-3 bg-green-100 border border-green-500 rounded"></div>
          <span>Present</span>
        </div>
        <div className="flex items-center space-x-1">
          <div className="w-3 h-3 bg-red-100 border border-red-500 rounded"></div>
          <span>Absent</span>
        </div>
        <div className="flex items-center space-x-1">
          <div className="w-3 h-3 bg-gray-100 border border-gray-300 rounded"></div>
          <span>Unknown</span>
        </div>
      </div>
    </div>
  );
}
