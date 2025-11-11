import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { toast } from "sonner";

interface SecretWordSetupProps {
  onSecretWordSet: (word: string) => void;
}

export function SecretWordSetup({ onSecretWordSet }: SecretWordSetupProps) {
  const [secretWord, setSecretWord] = useState("");
  const [isValidating, setIsValidating] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    const word = secretWord.trim().toUpperCase();
    
    if (word.length !== 5) {
      toast.error("Secret word must be exactly 5 letters");
      return;
    }

    if (new Set(word).size !== word.length) {
      const duplicates = word.split('').filter((char, index) => word.indexOf(char) !== index);
      toast.error(`Secret word cannot have duplicate letters. Found duplicates: ${[...new Set(duplicates)].join(', ')}`);
      return;
    }

    setIsValidating(true);
    
    try {
      // We'll validate the word when creating/joining the game
      // For now, just do basic validation
      onSecretWordSet(word);
      toast.success("Secret word set! Choose how to play.");
    } catch (error) {
      toast.error("Please enter a valid English word");
    } finally {
      setIsValidating(false);
    }
  };

  return (
    <div className="max-w-md mx-auto bg-white rounded-2xl shadow-md p-6">
      <h2 className="text-2xl font-bold text-gray-900 mb-4 text-center">
        Choose Your Secret Word
      </h2>
      
      <div className="mb-4 p-4 bg-blue-50 rounded-lg">
        <h3 className="font-semibold text-blue-900 mb-2">Requirements:</h3>
        <ul className="text-blue-800 text-sm space-y-1">
          <li>• Must be exactly 5 letters</li>
          <li>• No duplicate letters</li>
          <li>• Must be a real English word</li>
          <li>• No proper nouns</li>
        </ul>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Your Secret Word
          </label>
          <input
            type="text"
            value={secretWord}
            onChange={(e) => setSecretWord(e.target.value.toUpperCase())}
            placeholder="Enter 5-letter word"
            maxLength={5}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 font-mono text-lg text-center"
            disabled={isValidating}
          />
        </div>
        
        <button
          type="submit"
          disabled={secretWord.length !== 5 || isValidating}
          className="w-full bg-indigo-600 text-white py-3 px-6 rounded-lg font-semibold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isValidating ? "Validating..." : "Set Secret Word"}
        </button>
      </form>
    </div>
  );
}
