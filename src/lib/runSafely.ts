export async function runSafely<T>(
  action: () => Promise<T>,
  onError: (error: unknown) => void
): Promise<T | undefined> {
  try {
    return await action();
  } catch (error) {
    try {
      onError(error);
    } catch {
      // Keep the original failure path from turning into a secondary crash.
    }
    return undefined;
  }
}
