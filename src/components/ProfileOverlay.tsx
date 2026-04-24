import { useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { useAuth } from "../lib/auth";
import { api } from "../lib/api";
import { runSafely } from "../lib/runSafely";
import { SocialOverlay } from "./social/SocialOverlay";

interface ProfileOverlayProps {
  open: boolean;
  onClose: () => void;
}

export function ProfileOverlay({ open, onClose }: ProfileOverlayProps) {
  const { user, signOut } = useAuth();
  const [isSigningOut, setIsSigningOut] = useState(false);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const currentPasswordRef = useRef<HTMLInputElement>(null);

  const isAnonymous = Boolean(user?.isAnonymous);
  const badgeLetter = isAnonymous ? "G" : (user?.username?.[0] ?? "U").toUpperCase();

  function resetPasswordForm() {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
  }

  async function handleChangePassword(e: FormEvent) {
    e.preventDefault();

    if (newPassword !== confirmPassword) {
      toast.error("New passwords don't match.");
      return;
    }

    setIsSaving(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      toast.success("Password updated.");
      resetPasswordForm();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update password.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleSignOut() {
    if (isSigningOut) return;
    setIsSigningOut(true);
    try {
      await runSafely(
        () => signOut(),
        (error) => {
          toast.error(error instanceof Error ? error.message : "Unable to sign out right now.");
        }
      );
      onClose();
    } finally {
      setIsSigningOut(false);
    }
  }

  const footer = (
    <button
      type="button"
      onClick={() => void handleSignOut()}
      disabled={isSigningOut}
      className="inline-flex w-full items-center justify-center rounded-2xl border border-rose-200 bg-white px-4 py-3 text-sm font-semibold text-rose-700 transition hover:border-rose-300 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {isSigningOut ? "Signing out..." : "Sign out"}
    </button>
  );

  return (
    <SocialOverlay
      open={open}
      onClose={onClose}
      title="Profile"
      size="sm"
      contentClassName="space-y-4"
      footer={footer}
      initialFocusRef={currentPasswordRef}
    >
      {/* Identity hero */}
      <section className="overflow-hidden rounded-[1.75rem] bg-[linear-gradient(135deg,#0f172a_0%,#1d4ed8_48%,#0f766e_100%)] px-5 py-4 text-white">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-white/20 bg-white/15 text-sm font-black tracking-[0.2em]">
            {badgeLetter}
          </div>
          <div className="min-w-0">
            <div className="truncate font-display text-xl font-black tracking-tight">
              @{user?.username ?? "player"}
            </div>
            {isAnonymous && (
              <div className="mt-0.5 text-xs font-medium text-white/60">Guest account</div>
            )}
          </div>
        </div>
      </section>

      {/* Change password */}
      {isAnonymous ? (
        <div className="rounded-2xl border border-dashed border-zinc-200 bg-zinc-50 px-4 py-5 text-sm text-zinc-400">
          Password management is not available for guest accounts.
        </div>
      ) : (
        <section className="overflow-hidden rounded-[1.75rem] border border-zinc-200 bg-white">
          <div className="border-b border-zinc-100 px-4 py-3">
            <h3 className="text-sm font-semibold text-zinc-900">Change password</h3>
          </div>
          <form onSubmit={handleChangePassword} className="space-y-3 px-4 py-4">
            <input
              ref={currentPasswordRef}
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="Current password"
              autoComplete="current-password"
              required
              className="min-h-11 w-full rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-2.5 text-[16px] text-zinc-900 outline-none transition focus:border-zinc-400 focus:bg-white focus:ring-2 focus:ring-zinc-100"
            />
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="New password"
              autoComplete="new-password"
              required
              className="min-h-11 w-full rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-2.5 text-[16px] text-zinc-900 outline-none transition focus:border-zinc-400 focus:bg-white focus:ring-2 focus:ring-zinc-100"
            />
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm new password"
              autoComplete="new-password"
              required
              className="min-h-11 w-full rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-2.5 text-[16px] text-zinc-900 outline-none transition focus:border-zinc-400 focus:bg-white focus:ring-2 focus:ring-zinc-100"
            />
            <button
              type="submit"
              disabled={isSaving || !currentPassword || !newPassword || !confirmPassword}
              className="inline-flex w-full items-center justify-center rounded-2xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isSaving ? "Saving..." : "Save password"}
            </button>
          </form>
        </section>
      )}
    </SocialOverlay>
  );
}
