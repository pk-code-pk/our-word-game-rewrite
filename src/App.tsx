import { Authenticated, Unauthenticated, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { SignInForm } from "./SignInForm";
import { SignOutButton } from "./SignOutButton";
import { Toaster } from "sonner";
import { useState } from "react";
import { SecretWordSetup } from "./components/SecretWordSetup";
import { GameLobby } from "./components/GameLobby";
import { GameBoard } from "./components/GameBoard";

export default function App() {
  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <header className="sticky top-0 z-10 bg-indigo-700 text-white h-16 flex justify-between items-center shadow-md px-4">
        <h1 className="text-3xl font-bold tracking-wide">DualWord</h1>
        <Authenticated>
          <SignOutButton />
        </Authenticated>
      </header>
      <main className="flex-1 flex items-center justify-center p-8">
        <div className="w-full max-w-6xl mx-auto">
          <Content />
        </div>
      </main>
      <Toaster />
    </div>
  );
}

function Content() {
  const loggedInUser = useQuery(api.auth.loggedInUser);
  const [secretWord, setSecretWord] = useState<string>("");
  const [currentGameId, setCurrentGameId] = useState<string>("");
  const [gamePhase, setGamePhase] = useState<"setup" | "lobby" | "playing">("setup");

  if (loggedInUser === undefined) {
    return (
      <div className="flex justify-center items-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="text-center mb-8">
        <h2 className="text-4xl font-bold text-gray-900 mb-4">
          Word Deduction Challenge
        </h2>
        <Authenticated>
          <p className="text-xl text-gray-600 mb-2">
            Welcome back, {loggedInUser?.email ?? "friend"}!
          </p>
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 max-w-2xl mx-auto">
            <h3 className="font-semibold text-blue-900 mb-2">How to Play:</h3>
            <ul className="text-blue-800 text-left space-y-1">
              <li>• Each player chooses a secret 5-letter word (no duplicate letters)</li>
              <li>• Submit 4-letter guesses to deduce your opponent's secret word</li>
              <li>• Get feedback on how many letters overlap between your guess and their secret</li>
              <li>• Make as many guesses as you need - there's no limit!</li>
              <li>• You can also guess the full 5-letter word at any time</li>
              <li>• Winner: whoever guesses the opponent's word with fewer total guesses</li>
            </ul>
          </div>
        </Authenticated>
        <Unauthenticated>
          <p className="text-xl text-gray-600">Sign in to start playing</p>
        </Unauthenticated>
      </div>

      <Unauthenticated>
        <SignInForm />
      </Unauthenticated>

      <Authenticated>
        {gamePhase === "setup" && (
          <SecretWordSetup
            onSecretWordSet={(word) => {
              setSecretWord(word);
              setGamePhase("lobby");
            }}
          />
        )}

        {gamePhase === "lobby" && (
          <GameLobby
            secretWord={secretWord}
            onGameStart={(gameId) => {
              setCurrentGameId(gameId);
              setGamePhase("playing");
            }}
            onBackToSetup={() => {
              setSecretWord("");
              setGamePhase("setup");
            }}
          />
        )}

        {gamePhase === "playing" && currentGameId && (
          <GameBoard
            gameId={currentGameId}
            onGameEnd={() => {
              setCurrentGameId("");
              setSecretWord("");
              setGamePhase("setup");
            }}
          />
        )}
      </Authenticated>
    </div>
  );
}
