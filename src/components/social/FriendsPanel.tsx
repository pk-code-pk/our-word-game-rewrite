import { useMemo, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { FriendView } from "../../../shared/types";
import { useAuth } from "../../lib/auth";
import { api } from "../../lib/api";
import { usePollingQuery } from "../../lib/usePollingQuery";
import { SocialHeaderButton } from "./SocialHeaderButton";
import { SocialOverlay } from "./SocialOverlay";

interface FriendsPanelProps {
  onQuickInvite?: (friend: FriendView) => Promise<void>;
  refreshKey?: number;
  onSocialMutated?: () => void;
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

function getInitials(friend: FriendView) {
  const source = friend.displayName.trim() || friend.username.trim() || "FR";
  const initials = source
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("");
  return (initials || source.slice(0, 2) || "FR").toUpperCase();
}

export function FriendsPanel({
  onQuickInvite,
  refreshKey,
  onSocialMutated,
  className = "",
}: FriendsPanelProps) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [showAddFriend, setShowAddFriend] = useState(false);
  const [addUsername, setAddUsername] = useState("");
  const [isAddingFriend, setIsAddingFriend] = useState(false);
  const [pendingFriendId, setPendingFriendId] = useState<string | null>(null);
  const addInputRef = useRef<HTMLInputElement | null>(null);

  const canUseFriends = Boolean(user && !user.isAnonymous);
  const socialQuery = usePollingQuery(() => api.getSocialOverview(), [refreshTick, refreshKey], {
    intervalMs: 5000,
    enabled: canUseFriends,
  });

  const social = socialQuery.data?.social;
  const friends = social?.friends ?? [];
  const friendCount = friends.length;
  const outgoingPendingInvites = social?.outgoingGameInvites.filter((invite) => invite.status === "pending") ?? [];
  const pendingInviteByFriendId = useMemo(
    () => new Map(outgoingPendingInvites.map((invite) => [invite.receiver.userId, invite] as const)),
    [outgoingPendingInvites]
  );

  async function refreshSocial() {
    setRefreshTick((tick) => tick + 1);
  }

  async function handleAddFriend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const username = addUsername.trim();
    if (!username) {
      toast.error("Enter a username to add.");
      return;
    }

    setIsAddingFriend(true);
    try {
      const response = await api.sendFriendRequest(username);
      toast.success(response.becameFriends ? "You are now friends." : "Friend request sent.");
      setAddUsername("");
      setShowAddFriend(false);
      await refreshSocial();
      onSocialMutated?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to send friend request.");
    } finally {
      setIsAddingFriend(false);
    }
  }

  async function handleRemoveFriend(friend: FriendView) {
    setPendingFriendId(friend.userId);
    try {
      await api.removeFriend(friend.userId);
      toast.success(`${friend.displayName} removed from friends.`);
      await refreshSocial();
      onSocialMutated?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to remove friend.");
    } finally {
      setPendingFriendId(null);
    }
  }

  async function handleQuickInvite(friend: FriendView) {
    if (!onQuickInvite) {
      toast.error("Start a room first, then try again.");
      return;
    }

    if (pendingInviteByFriendId.has(friend.userId)) {
      toast("That friend already has a pending invite from you.");
      return;
    }

    setPendingFriendId(friend.userId);
    try {
      await onQuickInvite(friend);
      setOpen(false);
      await refreshSocial();
      onSocialMutated?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to invite friend.");
    } finally {
      setPendingFriendId(null);
    }
  }

  if (!canUseFriends) {
    return null;
  }

  const footer = showAddFriend ? (
    <form onSubmit={handleAddFriend} className="space-y-3 rounded-[1.5rem] border border-zinc-200 bg-zinc-50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-zinc-900">Add friend</div>
          <p className="mt-1 text-sm leading-6 text-zinc-600">
            Enter their exact username and send the request in one step.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowAddFriend(false)}
          className="rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500 transition hover:text-zinc-900"
        >
          Close
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <input
          ref={addInputRef}
          type="text"
          value={addUsername}
          onChange={(event) => setAddUsername(event.target.value)}
          placeholder="Friend username"
          autoComplete="off"
          className="min-h-11 w-full rounded-2xl border border-zinc-200 bg-white px-4 py-2.5 text-[16px] text-zinc-900 outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
        />
        <button
          type="submit"
          disabled={isAddingFriend}
          className="inline-flex min-h-11 items-center justify-center rounded-2xl bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isAddingFriend ? "Adding..." : "Add"}
        </button>
      </div>
    </form>
  ) : (
    <button
      type="button"
      onClick={() => {
        setShowAddFriend(true);
        window.requestAnimationFrame(() => {
          addInputRef.current?.focus({ preventScroll: true });
        });
      }}
      className="inline-flex w-full items-center justify-center rounded-2xl border border-dashed border-zinc-300 bg-zinc-50 px-4 py-3 text-sm font-semibold text-zinc-700 transition hover:border-zinc-400 hover:bg-white hover:text-zinc-900"
    >
      Add friend
    </button>
  );

  return (
    <>
      <SocialHeaderButton
        onClick={() => setOpen(true)}
        badge={friendCount}
        surface="light"
        className={className}
      >
        Friends
      </SocialHeaderButton>

      <SocialOverlay
        open={open}
        onClose={() => {
          setOpen(false);
          setShowAddFriend(false);
        }}
        title="Friends"
        eyebrow="Social"
        subtitle="Keep your circle compact, scrollable, and one tap away from a new room."
        size="md"
        initialFocusRef={showAddFriend ? addInputRef : undefined}
        contentClassName="space-y-4"
        footer={footer}
      >
        <section className="overflow-hidden rounded-[1.75rem] bg-[linear-gradient(135deg,#0f172a_0%,#1d4ed8_48%,#0f766e_100%)] px-5 py-5 text-white">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-white/20 bg-white/15 text-sm font-black tracking-[0.2em] shadow-lg shadow-slate-950/20">
              {(user?.username?.[0] ?? "U").toUpperCase()}
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.26em] text-sky-200">Official username</p>
              <h3 className="mt-2 truncate font-display text-2xl font-black tracking-tight text-white">
                @{user?.username ?? "player"}
              </h3>
              <p className="mt-2 text-sm leading-6 text-sky-100/90">
                Tap <span className="font-semibold">+</span> beside a friend to start or reuse a room. This is the only invite entry point.
              </p>
            </div>
          </div>
        </section>

        {socialQuery.error && social ? (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
            Showing your last good friend list while refresh is unavailable.
          </div>
        ) : null}

        <section className="overflow-hidden rounded-[1.75rem] border border-zinc-200 bg-white">
          <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3">
            <div>
              <h3 className="text-sm font-semibold text-zinc-900">Your friends</h3>
              <p className="mt-1 text-xs text-zinc-500">A few at a time, easy to scan, easy to act on.</p>
            </div>
            <div className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-semibold text-zinc-500">
              {friendCount}
            </div>
          </div>

          {socialQuery.loading && !social ? (
            <div className="space-y-3 px-4 py-4">
              <div className="h-16 animate-pulse rounded-2xl bg-zinc-100" />
              <div className="h-16 animate-pulse rounded-2xl bg-zinc-100" />
              <div className="h-16 animate-pulse rounded-2xl bg-zinc-100" />
            </div>
          ) : friends.length === 0 ? (
            <div className="px-5 py-12 text-center">
              <div className="text-sm font-semibold text-zinc-900">No friends yet.</div>
              <p className="mt-2 text-sm leading-6 text-zinc-500">
                Add someone below, then use <span className="font-semibold">+</span> here when you want to invite them.
              </p>
            </div>
          ) : (
            <div className="max-h-[min(22rem,58dvh)] overflow-y-auto px-3 py-3">
              <div className="space-y-2">
                {friends.map((friend) => {
                  const pendingInvite = pendingInviteByFriendId.get(friend.userId);
                  const isBusy = pendingFriendId === friend.userId;
                  return (
                    <article
                      key={friend.userId}
                      className="flex flex-col gap-3 rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-4 shadow-sm sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0 flex items-center gap-3">
                        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-slate-900 text-sm font-black tracking-[0.16em] text-white">
                          {getInitials(friend)}
                        </div>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="truncate text-sm font-semibold text-zinc-900">{friend.displayName}</div>
                            {pendingInvite ? (
                              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.18em] text-emerald-700">
                                Pending
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-0.5 truncate text-xs text-zinc-500">
                            @{friend.username} • Friends since {formatTimestamp(friend.since)}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 sm:justify-end">
                        <button
                          type="button"
                          onClick={() => void handleQuickInvite(friend)}
                          disabled={Boolean(pendingInvite) || isBusy}
                          className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-zinc-200 bg-white text-lg font-black text-zinc-900 transition hover:border-emerald-300 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-40"
                          aria-label={`Invite ${friend.displayName}`}
                          title={pendingInvite ? "Invite already pending" : `Invite ${friend.displayName}`}
                        >
                          +
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleRemoveFriend(friend)}
                          disabled={isBusy}
                          className="inline-flex min-h-10 items-center justify-center rounded-full border border-zinc-200 bg-white px-4 py-2 text-sm font-semibold text-zinc-600 transition hover:border-rose-200 hover:text-rose-700 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {isBusy ? "Working..." : "Remove"}
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          )}
        </section>
      </SocialOverlay>
    </>
  );
}
