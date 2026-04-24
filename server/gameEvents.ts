type GameEvent =
  | { type: "updated"; gameId: string }
  | { type: "ended"; gameId: string };

type GameEventHandler = (event: GameEvent) => void | Promise<void>;

const listeners = new Set<GameEventHandler>();

export function onGameEvent(handler: GameEventHandler): () => void {
  listeners.add(handler);
  return () => {
    listeners.delete(handler);
  };
}

export function emitGameEvent(event: GameEvent): void {
  for (const handler of listeners) {
    try {
      const result = handler(event);
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch((error) => {
          console.error("[gameEvents] handler rejected", error);
        });
      }
    } catch (error) {
      console.error("[gameEvents] handler threw", error);
    }
  }
}
