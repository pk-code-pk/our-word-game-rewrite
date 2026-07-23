// Serverless-safe game update signalling over Supabase Realtime.
//
// We use Realtime broadcast purely as a SIGNAL: the message carries only the
// gameId (never any game state), and subscribed clients react by refetching
// GET /api/games/:id, which computes viewer-specific state on the server. This
// guarantees the opponent's secret word never travels over the channel.
//
// The signal is delivered via the Realtime broadcast REST endpoint using a
// plain fetch (no held socket), so it works from Vercel serverless functions
// where a long-lived WebSocket server can't run.

export type GameSignalType = "updated" | "ended";

// Resolve at call time (not module load) so a missing env var never crashes
// import — it just makes the broadcast a no-op that logs.
function getConfig(): { url: string; serviceRoleKey: string } | null {
  const url = process.env.SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) {
    return null;
  }
  return { url: url.replace(/\/$/, ""), serviceRoleKey };
}

/**
 * Broadcast a {gameId} signal on channel `game:${gameId}`.
 *
 * Errors are swallowed and logged: a failed broadcast must never break the
 * mutation that triggered it (the client's slow safety poll will still pick
 * up the change).
 */
export async function broadcastGameSignal(gameId: string, type: GameSignalType): Promise<void> {
  const config = getConfig();
  if (!config) {
    // Supabase Realtime not configured (e.g. local dev / tests). No-op.
    return;
  }

  try {
    const response = await fetch(`${config.url}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [
          {
            topic: `game:${gameId}`,
            event: type,
            payload: { gameId },
          },
        ],
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(`[realtime] broadcast failed (${response.status}) for game ${gameId}: ${body}`);
    }
  } catch (error) {
    console.error(`[realtime] broadcast threw for game ${gameId}`, error);
  }
}
