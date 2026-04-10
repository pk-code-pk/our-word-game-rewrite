"use client";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { useAuth } from "./lib/auth";

type SignInFormProps = {
  mode?: "default" | "upgrade";
};

const LAST_AUTH_IDENTIFIER_KEY = "fourfive.lastAuthIdentifier";

export function resolvePreferredAuthIdentifier(_isUpgradeMode: boolean, rememberedIdentifier: string) {
  if (_isUpgradeMode) {
    return "";
  }

  return rememberedIdentifier.trim();
}

function readPreferredAuthIdentifier(isUpgradeMode: boolean) {
  if (typeof window === "undefined") {
    return "";
  }

  const rememberedIdentifier = window.localStorage.getItem(LAST_AUTH_IDENTIFIER_KEY) ?? "";
  return resolvePreferredAuthIdentifier(isUpgradeMode, rememberedIdentifier);
}

export function SignInForm({ mode = "default" }: SignInFormProps) {
  const auth = useAuth();
  const isUpgradeMode = mode === "upgrade";
  const [flow, setFlow] = useState<"signIn" | "signUp">(() => (isUpgradeMode ? "signUp" : "signIn"));
  const [identifier, setIdentifier] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [anonymousSubmitting, setAnonymousSubmitting] = useState(false);
  const effectiveFlow = isUpgradeMode ? "signUp" : flow;
  const isDeploymentProtectionBlocked = Boolean(auth.errorMessage?.includes("Vercel Authentication"));

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
        const rememberedIdentifier = authenticatedUser?.username?.trim() || identifier.trim();
        if (rememberedIdentifier) {
          window.localStorage.setItem(LAST_AUTH_IDENTIFIER_KEY, rememberedIdentifier);
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
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700">
          {isUpgradeMode ? "Guest upgrade" : "Account"}
        </p>
        <h2 className="text-2xl font-display font-bold tracking-tight text-zinc-900 sm:text-3xl">
          {isUpgradeMode ? "Create your account" : "Play FourFive"}
        </h2>
        <p className="text-sm leading-6 text-zinc-600">
          {isUpgradeMode
            ? "Pick a username and password to keep this guest session and unlock friends."
            : "Sign in, create an account, or play anonymously."}
        </p>
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
            Create account
          </button>
        </div>
      ) : null}

      {auth.errorMessage ? (
        <div
          className={`mt-6 rounded-xl px-4 py-3 text-sm leading-6 shadow-sm ${
            isDeploymentProtectionBlocked
              ? "border border-amber-200 bg-amber-50 text-amber-900"
              : "border border-rose-200 bg-rose-50 text-rose-900"
          }`}
        >
          {auth.errorMessage}
        </div>
      ) : null}

      <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
        <label className="block space-y-2">
          <span className="text-sm font-semibold text-zinc-700">Username</span>
          <input
            className="auth-input-field text-[16px]"
            type="text"
            name="identifier"
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
            placeholder="your-username"
            autoComplete="username"
            autoCapitalize="none"
            required
          />
          {effectiveFlow === "signUp" ? (
            <span className="block text-xs leading-5 text-zinc-500">
              Use 2-20 characters with letters, numbers, hyphens, or underscores.
            </span>
          ) : null}
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
          {submitting ? "Working..." : effectiveFlow === "signIn" ? "Sign in" : isUpgradeMode ? "Create account" : "Create account"}
        </button>
      </form>

      {!isUpgradeMode ? (
        <>
          <div className="my-5 flex items-center gap-3 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-400">
            <span className="h-px flex-1 bg-zinc-200" />
            <span>or</span>
            <span className="h-px flex-1 bg-zinc-200" />
          </div>

          <button
            type="button"
            disabled={submitting || anonymousSubmitting}
            className="inline-flex min-h-12 w-full items-center justify-center rounded-xl border border-zinc-300 bg-white px-4 py-3 font-semibold text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => {
              if (submitting || anonymousSubmitting) {
                return;
              }

              setAnonymousSubmitting(true);
              void auth
                .signInAnonymous()
                .catch((error) => {
                  toast.error(error instanceof Error ? error.message : "Anonymous sign-in failed.");
                })
                .finally(() => {
                  setAnonymousSubmitting(false);
                });
            }}
          >
            {anonymousSubmitting ? "Working..." : "Play anonymously"}
          </button>

          <p className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 text-center text-xs leading-5 text-zinc-500">
            Anonymous play works for jumping into games quickly. Friends and invites are only available on saved accounts.
          </p>
        </>
      ) : (
        <p className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-center text-xs leading-5 text-emerald-800">
          Creating an account keeps this guest session attached to one username.
        </p>
      )}
    </div>
  );
}
