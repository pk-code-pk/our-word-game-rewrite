import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { usePollingQuery } from "../lib/usePollingQuery";

interface ChatPanelProps {
  gameId: string;
  currentPlayerId: string;
  username: string;
  disabled?: boolean;
}

export function ChatPanel({ gameId, currentPlayerId, username, disabled = false }: ChatPanelProps) {
  const messagesQuery = usePollingQuery(() => api.listChatMessages(gameId), [gameId, disabled], {
    enabled: !disabled,
    intervalMs: 1500,
  });
  const messages = messagesQuery.data?.messages;
  const [message, setMessage] = useState("");
  const [isSending, setIsSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const keepMessagesPinnedRef = useRef(true);

  useEffect(() => {
    if (!messages?.length) {
      keepMessagesPinnedRef.current = true;
      return;
    }

    if (keepMessagesPinnedRef.current) {
      scrollToBottom(listRef.current);
    }
  }, [messages?.length]);

  useEffect(() => {
    keepMessagesPinnedRef.current = true;
  }, [gameId]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const viewport = window.visualViewport;
    if (!viewport) {
      return;
    }

    const keepComposerVisible = () => {
      if (document.activeElement === textareaRef.current) {
        ensureComposerVisible(formRef.current);
      }
    };

    viewport.addEventListener("resize", keepComposerVisible);
    window.addEventListener("orientationchange", keepComposerVisible);

    return () => {
      viewport.removeEventListener("resize", keepComposerVisible);
      window.removeEventListener("orientationchange", keepComposerVisible);
    };
  }, []);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled || isSending) return;

    const text = message.trim();
    if (!text) return;

    setIsSending(true);
    try {
      await api.sendChatMessage(gameId, text);
      setMessage("");
      keepMessagesPinnedRef.current = true;
      window.requestAnimationFrame(() => {
        textareaRef.current?.focus({ preventScroll: true });
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to send message");
    } finally {
      setIsSending(false);
    }
  };

  const canSend = !disabled && !isSending && message.trim().length > 0;

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white">
      <div className="border-b border-zinc-100 px-4 py-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-900">Chat</h3>
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">Live</span>
        </div>
      </div>

      {messagesQuery.error && (
        <div className="mx-4 mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          The chat stream hiccupped, but we&apos;ll keep trying in the background.
        </div>
      )}

      <div
        ref={listRef}
        onScroll={() => {
          keepMessagesPinnedRef.current = isNearBottom(listRef.current);
        }}
        className="mx-3 mt-3 flex-1 min-h-0 max-h-[min(16rem,30dvh)] overflow-y-auto space-y-2 rounded-lg border border-zinc-100 bg-zinc-50 p-2.5 sm:mx-4 sm:max-h-[min(20rem,36dvh)]"
        style={{ scrollbarGutter: "stable both-edges", overflowAnchor: "none" }}
      >
        {messagesQuery.loading && !messages && (
          <div className="space-y-2 py-2">
            <div className="h-12 animate-pulse rounded-lg bg-white" />
            <div className="h-12 animate-pulse rounded-lg bg-white" />
            <div className="h-12 animate-pulse rounded-lg bg-white" />
          </div>
        )}

        {messages && messages.length === 0 && (
          <div className="flex h-full min-h-[120px] items-center justify-center text-sm text-zinc-400">
            No messages yet.
          </div>
        )}

        {messages?.map((msg) => {
          const isMine = msg.playerId === currentPlayerId;
          const timeString = new Date(msg.createdAt).toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit",
          });

          return (
            <div key={msg.id} className={`flex flex-col ${isMine ? "items-end" : "items-start"}`}>
              <div
                className={
                  isMine
                    ? "max-w-[85%] rounded-xl rounded-br-sm bg-zinc-900 px-3 py-2 text-sm text-white"
                    : "max-w-[85%] rounded-xl rounded-bl-sm border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900"
                }
              >
                <div className="text-[10px] font-medium opacity-60 mb-0.5">
                  {isMine ? "You" : msg.username} • {timeString}
                </div>
                <div className="whitespace-pre-wrap">{msg.text}</div>
              </div>
            </div>
          );
        })}
      </div>

      <form ref={formRef} onSubmit={handleSend} className="border-t border-zinc-100 p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]">
        {disabled && (
          <p className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-700">
            Chat activates when an opponent joins.
          </p>
        )}

        <textarea
          ref={textareaRef}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={300}
          rows={2}
          placeholder="Type a message..."
          className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-[16px] text-zinc-900 resize-none outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 disabled:bg-zinc-50 w-full"
          disabled={disabled || isSending}
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-xs text-zinc-400">{message.trim().length}/300 characters</span>
          <button
            type="submit"
            disabled={!canSend}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-40 sm:w-auto"
          >
            {isSending ? "Sending..." : "Send"}
          </button>
        </div>
      </form>
    </div>
  );
}

function scrollToBottom(element: HTMLDivElement | null) {
  if (!element) {
    return;
  }

  element.scrollTop = element.scrollHeight;
}

function isNearBottom(element: HTMLDivElement | null, threshold = 28) {
  if (!element) {
    return true;
  }

  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
}

function ensureComposerVisible(element: HTMLElement | null) {
  if (!element) {
    return;
  }

  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  const rect = element.getBoundingClientRect();
  const bottomSafeArea = 20;

  if (rect.bottom > viewportHeight - bottomSafeArea) {
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}
