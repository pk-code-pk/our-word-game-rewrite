import { createPortal } from "react-dom";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

const SIZE_CLASS_MAP = {
  sm: "sm:max-w-md",
  md: "sm:max-w-2xl",
  lg: "sm:max-w-3xl",
  xl: "sm:max-w-4xl",
} as const;

export interface SocialOverlayProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  eyebrow?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  headerActions?: ReactNode;
  initialFocusRef?: RefObject<HTMLElement | null>;
  className?: string;
  panelClassName?: string;
  contentClassName?: string;
  footerClassName?: string;
  size?: keyof typeof SIZE_CLASS_MAP;
  labelledBy?: string;
  describedBy?: string;
}

function getFocusableElements(root: HTMLElement | null) {
  if (!root) {
    return [];
  }

  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => {
    if (element.hasAttribute("disabled")) {
      return false;
    }

    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  });
}

function focusSafely(element: HTMLElement | null) {
  element?.focus({ preventScroll: true });
}

export function SocialOverlay({
  open,
  onClose,
  title,
  subtitle,
  eyebrow,
  children,
  footer,
  headerActions,
  initialFocusRef,
  className = "",
  panelClassName = "",
  contentClassName = "",
  footerClassName = "",
  size = "md",
  labelledBy,
  describedBy,
}: SocialOverlayProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previousActiveElementRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const subtitleId = useId();
  const [isMounted, setIsMounted] = useState(open);
  const [isVisible, setIsVisible] = useState(open);

  // The focus-management effect below intentionally depends only on `open`.
  // `onClose` and `initialFocusRef` are passed as fresh references on every
  // parent render (callers use inline arrow functions). If they were part of
  // the effect's deps, the effect would tear down and re-run on each parent
  // render — restoring focus on cleanup and re-focusing the first focusable
  // element on re-run. With a polling parent that re-renders every couple of
  // seconds, that stole focus away from any input inside the overlay
  // mid-keystroke. Reading them through refs keeps the handler current
  // without retriggering the effect.
  const onCloseRef = useRef(onClose);
  const initialFocusRefRef = useRef(initialFocusRef);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    initialFocusRefRef.current = initialFocusRef;
  }, [initialFocusRef]);

  const panelSizeClass = useMemo(() => SIZE_CLASS_MAP[size], [size]);
  const resolvedLabelledBy = labelledBy ?? titleId;
  const resolvedDescribedBy = describedBy ?? (subtitle ? subtitleId : undefined);

  useEffect(() => {
    if (!open) {
      setIsVisible(false);
      const timeout = window.setTimeout(() => {
        setIsMounted(false);
      }, 220);
      return () => window.clearTimeout(timeout);
    }

    setIsMounted(true);
    const frame = window.requestAnimationFrame(() => setIsVisible(true));
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    previousActiveElementRef.current = document.activeElement as HTMLElement | null;

    const previousOverflow = document.body.style.overflow;
    const previousPaddingRight = document.body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;

    document.body.style.overflow = "hidden";
    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`;
    }

    const focusPanel = () => {
      const panel = panelRef.current;
      if (!panel) {
        return;
      }

      const preferred = initialFocusRefRef.current?.current;
      if (preferred && panel.contains(preferred)) {
        focusSafely(preferred);
        return;
      }

      const focusable = getFocusableElements(panel);
      if (focusable.length > 0) {
        focusSafely(focusable[0]);
        return;
      }

      focusSafely(panel);
    };

    const focusTimer = window.setTimeout(focusPanel, 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const panel = panelRef.current;
      if (!panel) {
        return;
      }

      const focusable = getFocusableElements(panel);
      if (focusable.length === 0) {
        event.preventDefault();
        focusSafely(panel);
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        if (!active || !panel.contains(active) || active === first) {
          event.preventDefault();
          focusSafely(last);
        }
        return;
      }

      if (!active || !panel.contains(active) || active === last) {
        event.preventDefault();
        focusSafely(first);
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      document.body.style.paddingRight = previousPaddingRight;

      const previousActive = previousActiveElementRef.current;
      if (previousActive && document.contains(previousActive)) {
        previousActive.focus({ preventScroll: true });
      }
    };
  }, [open]);

  if (!isMounted || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div className={`fixed inset-0 z-[80] ${className}`}>
      <div
        aria-hidden="true"
        role="presentation"
        onPointerDown={onClose}
        className={`absolute inset-0 bg-zinc-950/55 backdrop-blur-[2px] transition-opacity duration-200 ${isVisible ? "opacity-100" : "opacity-0"}`}
      />

      <div className="pointer-events-none fixed inset-0 flex items-stretch justify-stretch sm:justify-end sm:p-4">
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={resolvedLabelledBy}
          aria-describedby={resolvedDescribedBy}
          tabIndex={-1}
          className={`pointer-events-auto relative flex h-[100dvh] w-full min-w-0 flex-col overflow-hidden bg-white shadow-[0_24px_80px_rgba(15,23,42,0.22)] transition-all duration-200 ease-out sm:my-4 sm:h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-2rem)] sm:w-[min(100vw-2rem,42rem)] sm:rounded-[1.75rem] sm:border sm:border-white/70 ${
            isVisible ? "translate-y-0 opacity-100 sm:translate-x-0" : "translate-y-4 opacity-0 sm:translate-x-4"
          } ${panelSizeClass} ${panelClassName}`}
        >
          <div className="flex items-start justify-between gap-4 border-b border-slate-200/80 px-4 py-4 sm:px-6">
            <div className="min-w-0">
              {eyebrow ? (
                <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-500">
                  {eyebrow}
                </div>
              ) : null}
              <h2 id={resolvedLabelledBy} className="mt-1 text-lg font-black tracking-tight text-slate-950 sm:text-xl">
                {title}
              </h2>
              {subtitle ? (
                <p id={resolvedDescribedBy} className="mt-1.5 text-sm leading-6 text-slate-600">
                  {subtitle}
                </p>
              ) : null}
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {headerActions}
              <button
                type="button"
                onClick={onClose}
                className="inline-flex min-h-10 items-center justify-center rounded-full border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
              >
                Close
              </button>
            </div>
          </div>

          <div className={`min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6 ${contentClassName}`}>
            {children}
          </div>

          {footer ? (
            <div className={`border-t border-slate-200/80 px-4 py-4 sm:px-6 ${footerClassName}`}>{footer}</div>
          ) : null}
        </div>
      </div>
    </div>,
    document.body
  );
}
