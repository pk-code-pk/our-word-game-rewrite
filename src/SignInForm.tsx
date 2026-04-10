"use client";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { useAuth } from "./lib/auth";

const LAST_AUTH_IDENTIFIER_KEY = "fourfive.lastAuthIdentifier";

export function resolvePreferredAuthIdentifier(rememberedIdentifier: string) {
  return rememberedIdentifier.trim();
}

function readPreferredAuthIdentifier() {
  if (typeof window === "undefined") {
    return "";
  }

  const rememberedIdentifier = window.localStorage.getItem(LAST_AUTH_IDENTIFIER_KEY) ?? "";
  return resolvePreferredAuthIdentifier(rememberedIdentifier);
}

export function SignInForm() {
  const auth = useAuth();
  const [flow, setFlow] = useState<"signIn" | "signUp">("signIn");
  const [identifier, setIdentifier] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [anonymousSubmitting, setAnonymousSubmitting] = useState(false);
  const isDeploymentProtectionBlocked = Boolean(auth.errorMessage?.includes("Vercel Authentication"));

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    setIdentifier(readPreferredAuthIdentifier());
  }, []);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    const formData = new FormData(event.currentTarget);
    const identifier = String(formData.get("identifier") ?? "");
    const password = String(formData.get("password") ?? "");

    try {
      const authenticatedUser =
        flow === "signIn" ? await auth.signIn(identifier, password) : await auth.signUp(identifier, password);

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
        <h2 className="text-2xl font-display font-bold tracking-tight text-zinc-900 sm:text-3xl">Play FourFive</h2>
        <p className="text-sm leading-6 text-zinc-600">Sign in, make an account, or keep going as a guest.</p>
      </div>

      <div className="mt-6 grid grid-cols-2 rounded-xl border border-zinc-200 bg-zinc-50 p-1 shadow-inner">
        <button
          type="button"
          className={`flex min-h-11 items-center justify-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold transition-all ${
            flow === "signIn"
              ? "border-zinc-900 bg-white text-zinc-900 shadow-sm"
              : "border-transparent text-zinc-700 hover:border-zinc-200 hover:bg-white/70"
          }`}
          onClick={() => setFlow("signIn")}
          aria-pressed={flow === "signIn"}
        >
          <span
            className={`h-2.5 w-2.5 rounded-full border ${
              flow === "signIn" ? "border-zinc-900 bg-zinc-900" : "border-zinc-400 bg-transparent"
            }`}
            aria-hidden="true"
          />
          Sign in
        </button>
        <button
          type="button"
          className={`flex min-h-11 items-center justify-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold transition-all ${
            flow === "signUp"
              ? "border-zinc-900 bg-white text-zinc-900 shadow-sm"
              : "border-transparent text-zinc-700 hover:border-zinc-200 hover:bg-white/70"
          }`}
          onClick={() => setFlow("signUp")}
          aria-pressed={flow === "signUp"}
        >
          <span
            className={`h-2.5 w-2.5 rounded-full border ${
              flow === "signUp" ? "border-zinc-900 bg-zinc-900" : "border-zinc-400 bg-transparent"
            }`}
            aria-hidden="true"
          />
          Create account
        </button>
      </div>

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
          {flow === "signUp" ? (
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
            placeholder={flow === "signIn" ? "Enter your password" : "Create a password"}
            autoComplete={flow === "signIn" ? "current-password" : "new-password"}
            required
          />
        </label>
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-zinc-900 px-4 py-3 font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? "Working..." : flow === "signIn" ? "Sign in" : "Create account"}
        </button>
      </form>

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
        {anonymousSubmitting ? "Working..." : "Continue as guest"}
      </button>

      <p className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 text-center text-xs leading-5 text-zinc-500">
        Friends are available on saved accounts.
      </p>
    </div>
  );
}
