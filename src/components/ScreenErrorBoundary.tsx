import { Component, type ErrorInfo, type ReactNode } from "react";

interface ScreenErrorBoundaryProps {
  children: ReactNode;
  resetKey: string;
}

interface ScreenErrorBoundaryState {
  hasError: boolean;
}

export class ScreenErrorBoundary extends Component<
  ScreenErrorBoundaryProps,
  ScreenErrorBoundaryState
> {
  state: ScreenErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Screen render failed", error, errorInfo);
  }

  componentDidUpdate(prevProps: ScreenErrorBoundaryProps) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="mx-auto max-w-md rounded-xl border border-rose-200 bg-white p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-rose-100 text-2xl">
          !
        </div>
        <h2 className="text-2xl font-black tracking-tight text-zinc-900">This screen hit a snag</h2>
        <p className="mt-3 text-sm leading-6 text-zinc-600">
          The app caught a rendering error before it could blank the page. Reload to recover cleanly.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-6 inline-flex items-center justify-center rounded-lg bg-zinc-900 px-6 py-3 font-semibold text-white shadow-sm transition hover:bg-zinc-800"
        >
          Reload page
        </button>
      </div>
    );
  }
}
