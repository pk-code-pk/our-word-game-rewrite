import { useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";

interface SecretWordSetupProps {
  secretWord: string;
  onSecretWordChange: (word: string) => void;
  onSecretWordSet: (word: string) => void;
}

export function SecretWordSetup({ secretWord, onSecretWordChange, onSecretWordSet }: SecretWordSetupProps) {
  const [isValidating, setIsValidating] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const word = secretWord.trim().toUpperCase();

    if (word.length !== 5) {
      toast.error("Secret word must be exactly 5 letters");
      return;
    }

    if (new Set(word).size !== word.length) {
      const duplicates = word.split("").filter((char, index) => word.indexOf(char) !== index);
      toast.error(`Duplicate letters not allowed. Found duplicates: ${[...new Set(duplicates)].join(", ")}`);
      return;
    }

    setIsValidating(true);

    try {
      const validation = await api.validateWord(word, 5);
      if (!validation.valid) {
        toast.error(validation.reason || "That word is not allowed.");
        return;
      }

      onSecretWordSet(word);
      toast.success("Secret word set! Choose how to play.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to validate word");
    } finally {
      setIsValidating(false);
    }
  };

  return (
    <section className="mx-auto max-w-xl">
      <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
        <div className="border-b border-zinc-100 px-5 py-5 sm:px-6">
          <p className="text-xs font-semibold uppercase tracking-widest text-zinc-400">Step 1 of 2</p>
          <h2 className="mt-1.5 font-display text-2xl font-bold tracking-tight text-zinc-900 sm:text-[2rem]">
            Choose your secret word
          </h2>
        </div>

        <div className="px-5 py-5 sm:px-6 sm:py-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <input
                type="text"
                value={secretWord}
                onChange={(e) => onSecretWordChange(e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 5))}
                placeholder="_ _ _ _ _"
                maxLength={5}
                autoCapitalize="characters"
                spellCheck={false}
                className="w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-4 font-mono text-2xl font-bold tracking-[0.35em] text-center text-zinc-900 outline-none transition focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-100 disabled:opacity-50 sm:text-3xl sm:tracking-[0.4em]"
                disabled={isValidating}
              />
              <div className="mt-2 flex flex-col gap-1 text-xs text-zinc-400 sm:flex-row sm:items-center sm:justify-between">
                <span>{secretWord.length}/5 letters</span>
                <span>No duplicates · dictionary word</span>
              </div>
            </div>

            <button
              type="submit"
              disabled={secretWord.length !== 5 || isValidating}
              className="w-full rounded-xl bg-zinc-900 py-3.5 font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isValidating ? "Checking..." : "Set Secret Word →"}
            </button>
          </form>

          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {[
              ["5 letters", "Exactly five alphabetic characters"],
              ["No duplicates", "Each letter must appear once"],
              ["Real word", "Must be in the dictionary"],
              ["Letters only", "No numbers or symbols"],
            ].map(([title, desc]) => (
              <div key={title} className="rounded-xl border border-zinc-100 bg-zinc-50 px-3 py-3 shadow-[0_1px_0_rgba(0,0,0,0.02)]">
                <p className="text-xs font-semibold text-zinc-700">{title}</p>
                <p className="mt-0.5 text-xs text-zinc-400 leading-4">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
