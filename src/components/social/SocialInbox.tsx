import { useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { FriendRequestView, GameInviteView } from "../../../shared/types";
import { useAuth } from "../../lib/auth";
import { api } from "../../lib/api";
import { usePollingQuery } from "../../lib/usePollingQuery";
import { SocialHeaderButton } from "./SocialHeaderButton";
import { SocialOverlay } from "./SocialOverlay";

interface SocialInboxProps {
  onOpenGame?: (gameId: string) => void;
  displayName?: string;
  refreshKey?: number;
  onSocialMutated?: () => void;
  secretWord: string;
  className?: string;
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
  if (count <= 0) {
    return "0";
  }
  if (count > 99) {
    return "99+";
  }
  return String(count);
}

export function resolveInviteJoinDisplayName(displayName: string | undefined, accountUsername: string) {
  return displayName?.trim() || accountUsername.trim();
}

export function SocialInbox({
  onOpenGame,
  displayName,
  refreshKey,
  onSocialMutated,
  secretWord,
  className = "",
}: SocialInboxProps) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [submittingRequestId, setSubmittingRequestId] = useState<string | null>(null);
  const [submittingInviteId, setSubmittingInviteId] = useState<string | null>(null);

  const canUseInbox = Boolean(user && !user.isAnonymous);
  const inboxQuery = usePollingQuery(() => api.getSocialOverview(), [refreshTick, refreshKey], {
    intervalMs: 5000,
    enabled: canUseInbox,
  });

  const social = inboxQuery.data?.social;
  const incomingRequests = social?.incomingRequests ?? [];
  const incomingGameInvites = social?.incomingGameInvites.filter((invite) => invite.status === "pending") ?? [];
  const unreadCount = incomingRequests.length + incomingGameInvites.length;
  const currentUsername = user?.username ?? "";
  const joinDisplayName = resolveInviteJoinDisplayName(displayName, currentUsername);
  const joinHandle = joinDisplayName || currentUsername;

  const sortedRequests = useMemo(
    () => [...incomingRequests].sort((left, right) => right.createdAt - left.createdAt),
    [incomingRequests]
  );
  const sortedInvites = useMemo(
    () => [...incomingGameInvites].sort((left, right) => right.createdAt - left.createdAt),
    [incomingGameInvites]
  );

  async function refreshInbox() {
    setRefreshTick((tick) => tick + 1);
  }

  async function handleRequestAction(request: FriendRequestView, action: "accept" | "decline") {
    setSubmittingRequestId(request.requestId);
    try {
      if (action === "accept") {
        await api.acceptFriendRequest(request.requestId);
        toast.success(`You are now friends with ${request.sender.displayName}.`);
      } else {
        await api.declineFriendRequest(request.requestId);
        toast.success("Friend request declined.");
      }
      await refreshInbox();
      onSocialMutated?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to update request.");
    } finally {
      setSubmittingRequestId(null);
    }
  }

  async function handleInviteAction(invite: GameInviteView, action: "accept" | "decline") {
    setSubmittingInviteId(invite.inviteId);
    try {
      if (action === "decline") {
        await api.declineGameInvite(invite.inviteId);
        toast.success("Game invite declined.");
        await refreshInbox();
        onSocialMutated?.();
        return;
      }

      const normalizedSecretWord = normalizeSecretWord(secretWord);
      if (normalizedSecretWord.length !== 5) {
        toast.error("Set your secret word first, then open the inbox again.");
        return;
      }

      if (!joinDisplayName) {
        toast.error("Your username is missing. Refresh and try again.");
        return;
      }

      const response = await api.acceptGameInvite(invite.inviteId, {
        username: joinDisplayName,
        secretWord: normalizedSecretWord,
      });
      toast.success("Invite accepted. Joining game...");
      await refreshInbox();
      onSocialMutated?.();
      setOpen(false);
      onOpenGame?.(response.gameId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to update invite.");
    } finally {
      setSubmittingInviteId(null);
    }
  }

  if (!canUseInbox) {
    return null;
  }

  return (
    <>
      <SocialHeaderButton
        onClick={() => setOpen(true)}
        badge={unreadCount > 0 ? formatCount(unreadCount) : undefined}
        surface="light"
        className={className}
      >
        Inbox
      </SocialHeaderButton>

      <SocialOverlay
        open={open}
        onClose={() => setOpen(false)}
        title="Inbox"
        eyebrow="Social"
        subtitle="Your pending friend requests and game invites, kept in one compact queue."
        size="lg"
        contentClassName="space-y-4"
      >
        <section className="overflow-hidden rounded-[1.5rem] bg-[linear-gradient(135deg,#111827_0%,#1d4ed8_52%,#0f766e_100%)] px-4 py-3 text-white sm:px-5 sm:py-5">
          <div className="flex flex-col gap-2.5 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
            <div className="min-w-0 max-w-2xl">
              <p className="text-[11px] font-semibold uppercase tracking-[0.26em] text-sky-200">Incoming</p>
              <h3 className="mt-1.5 font-display text-lg font-black tracking-tight sm:text-2xl">Invites waiting for you</h3>
              <p className="mt-1.5 max-w-[34rem] text-sm leading-5 text-sky-100/90 sm:leading-6">
                Accept with your saved username and the secret word you already chose.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 sm:max-w-[12rem] sm:justify-end">
              <span className="inline-flex items-center rounded-full border border-white/15 bg-white/10 px-2.5 py-1 text-[11px] font-semibold leading-none text-white/90 backdrop-blur">
                @{joinHandle}
              </span>
              <span className="inline-flex items-center rounded-full border border-white/15 bg-white/10 px-2.5 py-1 text-[11px] font-semibold leading-none text-white/90 backdrop-blur">
                {formatCount(unreadCount)} waiting
              </span>
            </div>
          </div>
        </section>

        {inboxQuery.error && social ? (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
            Showing your last good inbox snapshot while refresh is unavailable.
          </div>
        ) : null}

        {inboxQuery.loading && !social ? (
          <div className="space-y-3">
            <div className="h-24 animate-pulse rounded-3xl bg-zinc-100" />
            <div className="h-28 animate-pulse rounded-3xl bg-zinc-100" />
          </div>
        ) : inboxQuery.error && !social ? (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-5 text-sm leading-6 text-amber-900">
            {inboxQuery.error.message}
          </div>
        ) : (
          <>
            <InboxSection
              title="Friend requests"
              count={sortedRequests.length}
              emptyLabel="No incoming friend requests."
            >
              {sortedRequests.map((request) => (
                <article
                  key={request.requestId}
                  className="rounded-2xl border border-zinc-200 bg-white px-4 py-4 shadow-sm"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-semibold text-zinc-900">{request.sender.displayName}</div>
                      <div className="mt-1 text-sm text-zinc-500">
                        @{request.sender.username} • sent {formatTimestamp(request.createdAt)}
                      </div>
                    </div>
                    <span className="rounded-full bg-zinc-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
                      Request
                    </span>
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void handleRequestAction(request, "accept")}
                      disabled={submittingRequestId === request.requestId}
                      className="inline-flex min-h-11 items-center justify-center rounded-full bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {submittingRequestId === request.requestId ? "Accepting..." : "Accept"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleRequestAction(request, "decline")}
                      disabled={submittingRequestId === request.requestId}
                      className="inline-flex min-h-11 items-center justify-center rounded-full border border-zinc-300 px-4 py-2.5 text-sm font-semibold text-zinc-700 transition hover:border-rose-300 hover:text-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Decline
                    </button>
                  </div>
                </article>
              ))}
            </InboxSection>

            <InboxSection
              title="Game invites"
              count={sortedInvites.length}
              emptyLabel="No incoming game invites."
            >
              {sortedInvites.map((invite) => {
                return (
                  <article
                    key={invite.inviteId}
                    className="rounded-2xl border border-zinc-200 bg-white px-4 py-4 shadow-sm"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-semibold text-zinc-900">
                          {invite.sender.displayName} invited you to {invite.gameCode}
                        </div>
                        <div className="mt-1 text-sm text-zinc-500">
                          @{invite.sender.username} • sent {formatTimestamp(invite.createdAt)}
                        </div>
                      </div>
                      <span className="rounded-full bg-zinc-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
                        Game
                      </span>
                    </div>

                    <div className="mt-4 rounded-2xl border border-zinc-100 bg-zinc-50 px-4 py-4">
                      <div className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-400">Joining as</div>
                      <div className="mt-1 font-semibold text-zinc-900">@{joinHandle}</div>
                      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <p className="text-sm leading-6 text-zinc-500">
                          This invite will use your saved secret word from the current session.
                        </p>

                        <div className="flex flex-wrap gap-2 sm:justify-end">
                          <button
                            type="button"
                            onClick={() => void handleInviteAction(invite, "accept")}
                            disabled={submittingInviteId === invite.inviteId}
                            className="inline-flex min-h-11 items-center justify-center rounded-full bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {submittingInviteId === invite.inviteId ? "Joining..." : "Accept"}
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleInviteAction(invite, "decline")}
                            disabled={submittingInviteId === invite.inviteId}
                            className="inline-flex min-h-11 items-center justify-center rounded-full border border-zinc-300 px-4 py-2.5 text-sm font-semibold text-zinc-700 transition hover:border-rose-300 hover:text-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            Decline
                          </button>
                        </div>
                      </div>
                    </div>
                  </article>
                );
              })}
            </InboxSection>
          </>
        )}
      </SocialOverlay>
    </>
  );
}

function InboxSection({
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
        <div>
          <h3 className="font-semibold text-zinc-900">{title}</h3>
          <p className="mt-1 text-sm text-zinc-500">A compact queue so nothing gets buried.</p>
        </div>
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
