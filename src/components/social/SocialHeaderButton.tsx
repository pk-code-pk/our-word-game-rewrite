import type { ButtonHTMLAttributes, ReactNode } from "react";

interface SocialHeaderButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  badge?: ReactNode;
  icon?: ReactNode;
  active?: boolean;
  surface?: "dark" | "light";
}

export function SocialHeaderButton({
  children,
  badge,
  icon,
  active = false,
  surface = "dark",
  className = "",
  type = "button",
  ...buttonProps
}: SocialHeaderButtonProps) {
  const isDarkSurface = surface === "dark";
  const baseStyles = isDarkSurface
    ? "border-white/10 bg-white/10 text-white hover:border-white/20 hover:bg-white/20"
    : "border-slate-200 bg-white text-slate-800 hover:border-slate-300 hover:bg-slate-50";

  const activeStyles = isDarkSurface
    ? "border-white bg-white text-slate-950 shadow-sm"
    : "border-slate-950 bg-slate-950 text-white shadow-sm";

  return (
    <button
      type={type}
      {...buttonProps}
      className={[
        "inline-flex min-h-9 items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-sm font-semibold transition sm:min-h-10 sm:gap-2 sm:px-3.5 sm:py-2",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent",
        "disabled:cursor-not-allowed disabled:opacity-45",
        active ? activeStyles : baseStyles,
        className,
      ].join(" ")}
    >
      {icon ? <span className="flex h-6 w-6 items-center justify-center rounded-full bg-current/10 text-[0.95em]">{icon}</span> : null}
      <span className="max-w-[11rem] truncate sm:max-w-none">{children}</span>
      {badge !== undefined ? (
        <span
          className={[
            "ml-0.5 inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-[11px] font-bold leading-none",
            active ? "bg-black/10 text-current" : isDarkSurface ? "bg-white/10 text-white" : "bg-slate-100 text-slate-700",
          ].join(" ")}
        >
          {badge}
        </span>
      ) : null}
    </button>
  );
}
