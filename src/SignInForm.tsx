"use client";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { useAuth } from "./lib/auth";

type SignInFormProps = {
  mode?: "default" | "upgrade";
};

const LAST_AUTH_IDENTIFIER_KEY = "fourfive.lastAuthIdentifier";
const LAST_AUTH_EMAIL_KEY = "fourfive.lastAuthEmail";

export function resolvePreferredAuthIdentifier(
  isUpgradeMode: boolean,
  rememberedIdentifier: string,
  rememberedEmail: string
) {
  if (isUpgradeMode) {
    return rememberedEmail || rememberedIdentifier;
  }

  return rememberedIdentifier || rememberedEmail;
}

function readPreferredAuthIdentifier(isUpgradeMode: boolean) {
  if (typeof window === "undefined") {
    return "";
  }

  const rememberedIdentifier = window.localStorage.getItem(LAST_AUTH_IDENTIFIER_KEY) ?? "";
  const rememberedEmail = window.localStorage.getItem(LAST_AUTH_EMAIL_KEY) ?? "";

  return resolvePreferredAuthIdentifier(isUpgradeMode, rememberedIdentifier, rememberedEmail);
}

export function SignInForm({ mode = "default" }: SignInFormProps) {
  const auth = useAuth();
  const isUpgradeMode = mode === "upgrade";
  const [flow, setFlow] = useState<"signIn" | "signUp">(() => (isUpgradeMode ? "signUp" : "signIn"));
  const [identifier, setIdentifier] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [anonymousSubmitting, setAnonymousSubmitting] = useState(false);
  const isAnonymousGuest = Boolean(auth.user?.isAnonymous);
  const effectiveFlow = isUpgradeMode ? "signUp" : flow;

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    setIdentifier(readPreferredAuthIdentifier(isUpgradeMode));
  }, [isUpgradeMode]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    const formData = new FormData(event.currentTarget);
    const identifier = String(formData.get("identifier") ?? "");
    const password = String(formData.get("password") ?? "");

    try {
      const authenticatedUser =
        effectiveFlow === "signIn" ? await auth.signIn(identifier, password) : await auth.signUp(identifier, password);

      if (typeof window !== "undefined") {
        const trimmedIdentifier = identifier.trim();
        const rememberedIdentifier = authenticatedUser?.email?.trim() || trimmedIdentifier;

        if (rememberedIdentifier) {
          window.localStorage.setItem(LAST_AUTH_IDENTIFIER_KEY, rememberedIdentifier);
        }

        if (authenticatedUser?.email?.trim()) {
          window.localStorage.setItem(LAST_AUTH_EMAIL_KEY, authenticatedUser.email.trim());
        }
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Authentication failed.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="w-full max-w-full rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm sm:p-8">
      <div className="space-y-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700">
            {isUpgradeMode ? "Guest upgrade" : "Account access"}
          </p>
          <h2 className="mt-2 text-2xl font-display font-bold tracking-tight text-zinc-900 sm:text-3xl">
            {isUpgradeMode ? "Keep this guest session" : "Jump into a match"}
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-600">
            {isUpgradeMode
              ? "Turn this anonymous session into a saved account without losing the game history already attached to it."
              : "Sign in, create a new account, or continue anonymously to explore the game before you commit."}
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-zinc-100 bg-zinc-50 px-4 py-3 shadow-[0_1px_0_rgba(0,0,0,0.02)]">
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-400">Save</div>
            <div className="mt-1 text-sm font-semibold text-zinc-900">History and stats stay with you</div>
          </div>
          <div className="rounded-xl border border-zinc-100 bg-zinc-50 px-4 py-3 shadow-[0_1px_0_rgba(0,0,0,0.02)]">
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-400">Move fast</div>
            <div className="mt-1 text-sm font-semibold text-zinc-900">Resume on desktop or mobile</div>
          </div>
          <div className="rounded-xl border border-zinc-100 bg-zinc-50 px-4 py-3 shadow-[0_1px_0_rgba(0,0,0,0.02)]">
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-400">Invite</div>
            <div className="mt-1 text-sm font-semibold text-zinc-900">Unlock the social hub on saved accounts</div>
          </div>
        </div>
      </div>

      {!isUpgradeMode ? (
        <div className="mt-6 grid grid-cols-2 rounded-xl border border-zinc-200 bg-zinc-50 p-1 shadow-inner">
          <button
            type="button"
            className={`min-h-11 rounded-lg px-4 py-2 text-sm font-semibold transition-all ${
              flow === "signIn" ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500 hover:text-zinc-900"
            }`}
            onClick={() => setFlow("signIn")}
          >
            Sign in
          </button>
          <button
            type="button"
            className={`min-h-11 rounded-lg px-4 py-2 text-sm font-semibold transition-all ${
              flow === "signUp" ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500 hover:text-zinc-900"
            }`}
            onClick={() => setFlow("signUp")}
          >
            Sign up
          </button>
        </div>
      ) : (
        <div className="mt-6 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm leading-6 text-emerald-800">
          Guest upgrade stays locked to account creation so this session stays attached to one identity.
        </div>
      )}

      <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
        <label className="block space-y-2">
          <span className="text-sm font-semibold text-zinc-700">
            {effectiveFlow === "signIn" ? "Email or username" : "Email"}
          </span>
          <input
            className="auth-input-field text-[16px]"
            type="text"
            name="identifier"
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
            placeholder={effectiveFlow === "signIn" ? "you@example.com or your-username" : "you@example.com"}
            autoComplete={effectiveFlow === "signIn" ? "username" : "email"}
            autoCapitalize="none"
            required
          />
        </label>
        <label className="block space-y-2">
          <span className="text-sm font-semibold text-zinc-700">Password</span>
          <input
            className="auth-input-field text-[16px]"
            type="password"
            name="password"
            placeholder={effectiveFlow === "signIn" ? "Enter your password" : "Create a password"}
            autoComplete={effectiveFlow === "signIn" ? "current-password" : "new-password"}
            required
          />
        </label>
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-zinc-900 px-4 py-3 font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? "Working..." : effectiveFlow === "signIn" ? "Sign in" : isUpgradeMode ? "Upgrade account" : "Create account"}
        </button>
      </form>

      <div className="my-5 flex items-center gap-3 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-400">
        <span className="h-px flex-1 bg-zinc-200" />
        <span>or</span>
        <span className="h-px flex-1 bg-zinc-200" />
      </div>

      {!isUpgradeMode ? (
        <>
          <button
            type="button"
            disabled={submitting || anonymousSubmitting}
            className="mt-2 inline-flex min-h-12 w-full items-center justify-center rounded-xl border border-zinc-300 bg-white px-4 py-3 font-semibold text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => {
              if (submitting || anonymousSubmitting) {
                return;
              }

              setAnonymousSubmitting(true);
              void auth.signInAnonymous()
                .catch((error) => {
                  toast.error(error instanceof Error ? error.message : "Anonymous sign-in failed.");
                })
                .finally(() => {
                  setAnonymousSubmitting(false);
                });
            }}
          >
            {anonymousSubmitting ? "Working..." : "Continue anonymously"}
          </button>

          <p className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 text-center text-xs leading-5 text-zinc-500">
            Anonymous sessions are great for a quick test run. Friends, invites, and saved identity stay on email-backed accounts.
          </p>
        </>
      ) : (
        <p className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-center text-xs leading-5 text-emerald-800">
          {isAnonymousGuest
            ? "Upgrading keeps this guest identity in place, including recent games and stats."
            : "This upgrade path is meant for the current guest session on this device."}
        </p>
      )}

      {!isUpgradeMode ? (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-x-1 gap-y-1 text-center text-sm text-zinc-600">
          <span>{flow === "signIn" ? "Need an account? " : "Already registered? "}</span>
          <button
            type="button"
            className="font-semibold text-zinc-900 hover:underline"
            onClick={() => setFlow(flow === "signIn" ? "signUp" : "signIn")}
          >
            {flow === "signIn" ? "Sign up instead" : "Sign in instead"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
