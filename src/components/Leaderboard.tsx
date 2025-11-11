import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

export function Leaderboard() {
  const leaderboard = useQuery(api.games.getLeaderboard);

  if (leaderboard === undefined) {
    return (
      <div className="flex justify-center items-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto bg-white rounded-2xl shadow-md p-6">
      <div className="mb-6">
        <h2 className="text-3xl font-bold text-gray-900 mb-2 text-center">
          🏆 Leaderboard
        </h2>
        <p className="text-gray-600 text-center">
          Top 10 Players by Total Wins
        </p>
      </div>

      {leaderboard.length === 0 ? (
        <div className="text-center py-8 text-gray-500">
          No games completed yet. Be the first to play!
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b-2 border-gray-200">
                <th className="text-left py-3 px-4 font-semibold text-gray-700">Rank</th>
                <th className="text-left py-3 px-4 font-semibold text-gray-700">Player</th>
                <th className="text-center py-3 px-4 font-semibold text-gray-700">Wins</th>
                <th className="text-center py-3 px-4 font-semibold text-gray-700">Games Played</th>
                <th className="text-center py-3 px-4 font-semibold text-gray-700">Avg. Guesses/Win</th>
              </tr>
            </thead>
            <tbody>
              {leaderboard.map((entry, index) => (
                <tr 
                  key={index} 
                  className={`border-b border-gray-100 hover:bg-gray-50 transition-colors ${
                    index < 3 ? 'bg-gradient-to-r from-yellow-50 to-transparent' : ''
                  }`}
                >
                  <td className="py-4 px-4">
                    <div className="flex items-center">
                      {index === 0 && <span className="text-2xl mr-2">🥇</span>}
                      {index === 1 && <span className="text-2xl mr-2">🥈</span>}
                      {index === 2 && <span className="text-2xl mr-2">🥉</span>}
                      <span className="font-semibold text-gray-700">#{index + 1}</span>
                    </div>
                  </td>
                  <td className="py-4 px-4">
                    <span className="font-medium text-gray-900">{entry.username}</span>
                  </td>
                  <td className="py-4 px-4 text-center">
                    <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-semibold bg-green-100 text-green-800">
                      {entry.wins}
                    </span>
                  </td>
                  <td className="py-4 px-4 text-center">
                    <span className="text-gray-700">{entry.gamesPlayed}</span>
                  </td>
                  <td className="py-4 px-4 text-center">
                    <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-blue-100 text-blue-800">
                      {entry.averageGuessesPerWin}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-6 text-center text-sm text-gray-500">
        <p>Lower average guesses per win is better! 🎯</p>
      </div>
    </div>
  );
}

