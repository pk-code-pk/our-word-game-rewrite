import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import type { GameInviteView } from "../../../shared/types";
import { useAuth } from "../../lib/auth";
import { api } from "../../lib/api";
import { useSocialData } from "./SocialDataProvider";
import { SocialHeaderButton } from "./SocialHeaderButton";
import { SocialOverlay } from "./SocialOverlay";

interface GuestInvitesPanelProps {
  onSendInvite: (username: string) => Promise<void>;
  onOpenGame?: (gameId: string) => void;
  secretWord: string;
  displayName?: string;
  className?: string;
  forceOpen?: boolean;
  onForceOpenConsumed?: () => void;
}

function formatTimestamp(timestamp: number) {
  return new Date(timestamp).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function normalizeSecretWord(value: string) {
  return value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 5);
}

function formatCount(count: number) {
  if (count <= 0) return "0";
  if (count > 99) return "99+";
  return String(count);
}

export function GuestInvitesPanel({
  onSendInvite,
  onOpenGame,
  secretWord,
  displayName,
  className = "",
  forceOpen,
  onForceOpenConsumed,
}: GuestInvitesPanelProps) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [inviteUsername, setInviteUsername] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [submittingInviteId, setSubmittingInviteId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (forceOpen) {
      setOpen(true);
      onForceOpenConsumed?.();
    }
  }, [forceOpen, onForceOpenConsumed]);

  const enabled = Boolean(user);
  // Reads from the shared social poll hoisted into SocialDataProvider instead
  // of polling /api/social itself.
  const { data: socialData, error: socialError, loading: socialLoading, refresh: refetchSocial } =
    useSocialData();

  const social = socialData?.social;
  const incoming = useMemo(
    () =>
      (social?.incomingGameInvites ?? [])
        .filter((invite) => invite.status === "pending")
        .sort((a, b) => b.createdAt - a.createdAt),
    [social?.incomingGameInvites]
  );
  const outgoing = useMemo(
    () =>
      (social?.outgoingGameInvites ?? [])
        .filter((invite) => invite.status === "pending")
        .sort((a, b) => b.createdAt - a.createdAt),
    [social?.outgoingGameInvites]
  );

  const joinDisplayName = displayName?.trim() || user?.username?.trim() || "";

  async function handleSubmitSend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const username = inviteUsername.trim();
    if (!username) {
      toast.error("Enter a username to invite.");
      return;
    }

    setIsSending(true);
    try {
      await onSendInvite(username);
      setInviteUsername("");
      refetchSocial();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to send invite.");
    } finally {
      setIsSending(false);
    }
  }

  async function handleCancel(invite: GameInviteView) {
    setSubmittingInviteId(invite.inviteId);
    try {
      await api.cancelGameInvite(invite.inviteId);
      toast.success("Invite cancelled.");
      refetchSocial();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to cancel invite.");
    } finally {
      setSubmittingInviteId(null);
    }
  }

  async function handleAccept(invite: GameInviteView) {
    setSubmittingInviteId(invite.inviteId);
    try {
      const normalizedSecretWord = normalizeSecretWord(secretWord);
      if (normalizedSecretWord.length !== 5) {
        toast.error("Set your secret word first, then open Invites again.");
        return;
      }
      if (!joinDisplayName) {
        toast.error("Your display name is missing. Refresh and try again.");
        return;
      }

      const response = await api.acceptGameInvite(invite.inviteId, {
        username: joinDisplayName,
        secretWord: normalizedSecretWord,
      });
      toast.success("Invite accepted. Joining game...");
      refetchSocial();
      setOpen(false);
      onOpenGame?.(response.gameId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to accept invite.");
    } finally {
      setSubmittingInviteId(null);
    }
  }

  async function handleDecline(invite: GameInviteView) {
    setSubmittingInviteId(invite.inviteId);
    try {
      await api.declineGameInvite(invite.inviteId);
      toast.success("Invite declined.");
      refetchSocial();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to decline invite.");
    } finally {
      setSubmittingInviteId(null);
    }
  }

  if (!enabled) {
    return null;
  }

  const incomingCount = incoming.length;

  const footer = (
    <form onSubmit={handleSubmitSend} className="space-y-3 rounded-[1.5rem] border border-zinc-200 bg-zinc-50 p-4">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <input
          ref={inputRef}
          type="text"
          value={inviteUsername}
          onChange={(event) => setInviteUsername(event.target.value)}
          placeholder="Player username"
          autoComplete="off"
          className="min-h-11 w-full rounded-2xl border border-zinc-200 bg-white px-4 py-2.5 text-[16px] text-zinc-900 outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
        />
        <button
          type="submit"
          disabled={isSending}
          className="inline-flex min-h-11 items-center justify-center rounded-2xl bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isSending ? "Sending..." : "Invite"}
        </button>
      </div>
    </form>
  );

  return (
    <>
      <SocialHeaderButton
        onClick={() => setOpen(true)}
        badge={incomingCount > 0 ? formatCount(incomingCount) : undefined}
        surface="light"
        className={className}
      >
        <svg className="h-4 w-4 sm:hidden" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z" />
        </svg>
        <span className="hidden sm:inline">Invites</span>
      </SocialHeaderButton>

      <SocialOverlay
        open={open}
        onClose={() => setOpen(false)}
        title="Invites"
        size="md"
        initialFocusRef={inputRef}
        contentClassName="space-y-4"
        footer={footer}
      >
        {socialError && social ? (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
            Showing your last good snapshot while refresh is unavailable.
          </div>
        ) : null}

        {socialLoading && !social ? (
          <div className="space-y-3">
            <div className="h-24 animate-pulse rounded-3xl bg-zinc-100" />
            <div className="h-24 animate-pulse rounded-3xl bg-zinc-100" />
          </div>
        ) : socialError && !social ? (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-5 text-sm leading-6 text-amber-900">
            {socialError.message}
          </div>
        ) : (
          <>
            <InvitesSection title="Incoming" count={incoming.length} emptyLabel="No incoming invites">
              {incoming.map((invite) => (
                <article
                  key={invite.inviteId}
                  className="rounded-2xl border border-zinc-200 bg-white px-4 py-4 shadow-sm"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-semibold text-zinc-900">{invite.sender.displayName}</div>
                      <div className="mt-1 text-sm text-zinc-500">
                        @{invite.sender.username} • sent {formatTimestamp(invite.createdAt)}
                      </div>
                    </div>
                    <span className="rounded-full bg-zinc-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
                      Invite
                    </span>
                  </div>

                  <div className="mt-4 rounded-2xl border border-zinc-100 bg-zinc-50 px-4 py-3">
                    <div className="text-xs text-zinc-400">
                      Joining as <span className="font-semibold text-zinc-700">@{joinDisplayName || "—"}</span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => void handleAccept(invite)}
                        disabled={submittingInviteId === invite.inviteId}
                        className="inline-flex min-h-11 items-center justify-center rounded-full bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {submittingInviteId === invite.inviteId ? "Joining..." : "Accept"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDecline(invite)}
                        disabled={submittingInviteId === invite.inviteId}
                        className="inline-flex min-h-11 items-center justify-center rounded-full border border-zinc-300 px-4 py-2.5 text-sm font-semibold text-zinc-700 transition hover:border-rose-300 hover:text-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Decline
                      </button>
                    </div>
                  </div>
                </article>
              ))}
            </InvitesSection>

            <InvitesSection title="Outgoing" count={outgoing.length} emptyLabel="No outgoing invites">
              {outgoing.map((invite) => (
                <article
                  key={invite.inviteId}
                  className="rounded-2xl border border-zinc-200 bg-white px-4 py-4 shadow-sm"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-semibold text-zinc-900">{invite.receiver.displayName}</div>
                      <div className="mt-1 text-sm text-zinc-500">
                        @{invite.receiver.username} • sent {formatTimestamp(invite.createdAt)}
                      </div>
                    </div>
                    <span className="rounded-full bg-emerald-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-700">
                      Pending
                    </span>
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void handleCancel(invite)}
                      disabled={submittingInviteId === invite.inviteId}
                      className="inline-flex min-h-11 items-center justify-center rounded-full border border-zinc-300 px-4 py-2.5 text-sm font-semibold text-zinc-700 transition hover:border-rose-300 hover:text-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {submittingInviteId === invite.inviteId ? "Cancelling..." : "Cancel"}
                    </button>
                  </div>
                </article>
              ))}
            </InvitesSection>
          </>
        )}
      </SocialOverlay>
    </>
  );
}

function InvitesSection({
  title,
  count,
  emptyLabel,
  children,
}: {
  title: string;
  count: number;
  emptyLabel: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-3xl border border-zinc-200 bg-white/90 p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-semibold text-zinc-900">{title}</h3>
        <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
          {count}
        </span>
      </div>

      <div className="mt-4 space-y-3">
        {count > 0 ? (
          children
        ) : (
          <div className="rounded-2xl border border-dashed border-zinc-200 bg-zinc-50 px-4 py-5 text-sm text-zinc-400">
            {emptyLabel}
          </div>
        )}
      </div>
    </section>
  );
}
