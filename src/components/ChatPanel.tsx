import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { toast } from "sonner";

interface ChatPanelProps {
  gameId: Id<"games">;
  playerId: Id<"players">;
  username: string;
  disabled?: boolean;
}

export function ChatPanel({ gameId, playerId, username, disabled = false }: ChatPanelProps) {
  const messages = useQuery(api.games.listChatMessages, { gameId });
  const sendMessage = useMutation(api.games.sendChatMessage);
  const [message, setMessage] = useState("");
  const [isSending, setIsSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages?.length]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled || isSending) return;

    const text = message.trim();
    if (!text) return;

    setIsSending(true);
    try {
      await sendMessage({ gameId, playerId, text });
      setMessage("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to send message");
    } finally {
      setIsSending(false);
    }
  };

  const canSend = !disabled && !isSending && message.trim().length > 0;

  return (
    <div className="bg-white rounded-2xl shadow-md p-4 flex flex-col h-full">
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Game Chat</h3>
          <p className="text-xs text-gray-500">
            You are chatting as {username}. Only players in this match can see these messages.
          </p>
        </div>
      </div>

      <div
        ref={listRef}
        className="flex-1 min-h-[220px] max-h-80 overflow-y-auto space-y-3 bg-gray-50 border border-gray-100 rounded-lg p-3"
      >
        {!messages && (
          <div className="flex justify-center py-6">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-600"></div>
          </div>
        )}

        {messages && messages.length === 0 && (
          <p className="text-sm text-gray-500 text-center">No messages yet. Say hi to your opponent!</p>
        )}

        {messages &&
          messages.map((msg) => {
            const isMine = msg.playerId === playerId;
            const timeString = new Date(msg.createdAt).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            });

            return (
              <div key={msg._id} className={`flex flex-col ${isMine ? "items-end" : "items-start"}`}>
                <div
                  className={`px-3 py-2 rounded-lg text-sm max-w-[90%] break-words ${
                    isMine
                      ? "bg-indigo-600 text-white shadow-md"
                      : "bg-white border border-gray-200 text-gray-900 shadow-sm"
                  }`}
                >
                  <div className="text-[11px] opacity-80">
                    {isMine ? "You" : msg.username} • {timeString}
                  </div>
                  <div className="mt-1 whitespace-pre-wrap">{msg.text}</div>
                </div>
              </div>
            );
          })}
      </div>

      <form onSubmit={handleSend} className="mt-3 space-y-2">
        {disabled && (
          <p className="text-xs text-amber-600">
            Chat unlocks when a human opponent joins and while the game is active.
          </p>
        )}

        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={300}
          rows={2}
          placeholder="Type a message..."
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-sm resize-none"
          disabled={disabled || isSending}
        />
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-500">
            {message.trim().length}/{300} characters
          </span>
          <button
            type="submit"
            disabled={!canSend}
            className="bg-indigo-600 text-white py-2 px-4 rounded-lg font-semibold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isSending ? "Sending..." : "Send"}
          </button>
        </div>
      </form>
    </div>
  );
}

