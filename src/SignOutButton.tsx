"use client";
import { useState } from "react";
import { useAuth } from "./lib/auth";
import { ProfileOverlay } from "./components/ProfileOverlay";

export function SignOutButton() {
  const { user, isAuthenticated } = useAuth();
  const [open, setOpen] = useState(false);

  if (!isAuthenticated) {
    return null;
  }

  const isAnonymous = Boolean(user?.isAnonymous);
  const badgeLetter = isAnonymous ? "G" : (user?.username?.[0] ?? "U").toUpperCase();
  const label = isAnonymous ? "Guest session" : `@${user?.username ?? "account"}`;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={label}
        aria-label={`Profile: ${label}`}
        className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-left transition hover:bg-zinc-800 sm:min-h-9"
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white text-[10px] font-black text-zinc-900">
          {badgeLetter}
        </span>
        <span className="hidden min-w-0 flex-1 md:block">
          <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">Signed in as</span>
          <span className="block truncate text-xs font-semibold text-white">{label}</span>
        </span>
      </button>

      <ProfileOverlay open={open} onClose={() => setOpen(false)} />
    </>
  );
}
