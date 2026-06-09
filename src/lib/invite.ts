export type ShareOutcome = "shared" | "copied" | "dismissed" | "unsupported";

export const JOIN_QUERY_PARAM = "join";

export function normalizeInviteCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

export function buildInviteUrl(code: string): string {
  const normalized = normalizeInviteCode(code);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/?${JOIN_QUERY_PARAM}=${encodeURIComponent(normalized)}`;
}

export function buildInviteMessage(params: { code: string; hostName?: string }): {
  url: string;
  text: string;
} {
  const url = buildInviteUrl(params.code);
  const host = params.hostName?.trim();
  const intro = host ? `${host} challenged you to a game of FourFive!` : "Join my FourFive match!";
  return { url, text: `${intro} Tap to play: ${url}` };
}

/**
 * Reads the invite code from the current URL (e.g. /?join=ABC123).
 * Returns "" when there is no valid code present.
 */
export function readInviteCodeFromUrl(): string {
  if (typeof window === "undefined") {
    return "";
  }
  const params = new URLSearchParams(window.location.search);
  return normalizeInviteCode(params.get(JOIN_QUERY_PARAM) ?? "");
}

/** Removes the ?join=... param from the address bar without reloading. */
export function clearInviteCodeFromUrl(): void {
  if (typeof window === "undefined") {
    return;
  }
  const url = new URL(window.location.href);
  if (!url.searchParams.has(JOIN_QUERY_PARAM)) {
    return;
  }
  url.searchParams.delete(JOIN_QUERY_PARAM);
  const next = `${url.pathname}${url.search}${url.hash}`;
  window.history.replaceState(window.history.state, "", next);
}

/**
 * Hands the invite off to the device's native share sheet (iMessage / Messages
 * on iOS & macOS, the system share dialog elsewhere). Falls back to copying the
 * invite text to the clipboard when the Web Share API is unavailable.
 */
export async function shareInvite(params: { code: string; hostName?: string }): Promise<ShareOutcome> {
  const { url, text } = buildInviteMessage(params);
  const nav = typeof navigator !== "undefined" ? navigator : undefined;

  if (nav?.share) {
    try {
      await nav.share({ title: "FourFive", text, url });
      return "shared";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return "dismissed";
      }
      // Otherwise fall through to the clipboard fallback below.
    }
  }

  if (nav?.clipboard?.writeText) {
    try {
      await nav.clipboard.writeText(text);
      return "copied";
    } catch {
      // Ignore and report as unsupported so the caller can surface the link.
    }
  }

  return "unsupported";
}
