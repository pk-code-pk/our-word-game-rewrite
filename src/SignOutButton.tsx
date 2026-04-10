"use client";
import { useState } from "react";
import { toast } from "sonner";
import { useAuth } from "./lib/auth";
import { runSafely } from "./lib/runSafely";

export function SignOutButton() {
  const { user, isAuthenticated, signOut } = useAuth();
  const [isSigningOut, setIsSigningOut] = useState(false);

  if (!isAuthenticated) {
    return null;
  }

  const isAnonymous = Boolean(user?.isAnonymous);
  const identityLabel = isAnonymous ? "Guest session" : `@${user?.username ?? "account"}`;
  const badgeLetter = isAnonymous ? "G" : (user?.username?.[0] ?? "S").toUpperCase();

  return (
    <button
      type="button"
      className="group inline-flex min-h-9 max-w-full items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-left transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 sm:px-3"
      onClick={async () => {
        if (isSigningOut) {
          return;
        }
        setIsSigningOut(true);
        try {
          await runSafely(
            () => signOut(),
            (error) => {
              toast.error(error instanceof Error ? error.message : "Unable to sign out right now.");
            }
          );
        } finally {
          setIsSigningOut(false);
        }
      }}
      disabled={isSigningOut}
      title={isAnonymous ? "Guest session" : user?.username ?? "Saved account"}
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white text-[10px] font-black text-zinc-900">
        {badgeLetter}
      </span>
      <span className="hidden min-w-0 flex-1 md:block">
        <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">Signed in as</span>
        <span className="block truncate text-xs font-semibold text-white">{identityLabel}</span>
      </span>
      <span className="rounded-md bg-zinc-700 px-2 py-0.5 text-xs font-semibold text-zinc-200 transition group-hover:bg-zinc-600">
        {isSigningOut ? "Signing out..." : "Sign out"}
      </span>
    </button>
  );
}
