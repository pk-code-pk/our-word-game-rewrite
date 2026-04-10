import type { PresenceState } from "../../shared/types";

interface PresenceBadgeProps {
  status: PresenceState | null;
  label?: string;
  className?: string;
}

export function PresenceBadge({ status, label, className = "" }: PresenceBadgeProps) {
  if (!status) {
    return null;
  }

  const isOnline = status === "online";

  return (
    <span
      className={`inline-flex max-w-full items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] shadow-sm ${
        isOnline
          ? "border-emerald-200 bg-emerald-50 text-emerald-700 shadow-emerald-100/60"
          : "border-slate-200 bg-slate-50 text-slate-500"
      } ${className}`}
    >
      <span
        className={`h-2 w-2 rounded-full ${isOnline ? "bg-emerald-500 ring-4 ring-emerald-100" : "bg-slate-400"}`}
      />
      <span className="truncate">{label ?? (isOnline ? "Online" : "Offline")}</span>
    </span>
  );
}
