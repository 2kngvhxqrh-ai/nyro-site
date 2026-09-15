/**
 * Keeps one broken view from blanking the whole app.
 *
 * React unmounts the entire tree when a render throws and nothing catches it.
 * That is exactly what happened: the routing-preview strip read a field off a
 * response that did not have it, and the result was not a broken strip — it
 * was an empty page, with no message, no navigation, and no way back except a
 * reload the user had to think of themselves.
 *
 * A class component because that is the only thing React lets catch a render
 * error; there is no hook for it.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Changing this resets the boundary — used to retry by switching views. */
  resetKey?: string;
}

interface State {
  message: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { message: null };

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  override componentDidUpdate(prev: Props): void {
    // Switching to another view is the natural "try something else", so it
    // clears the error rather than trapping the user on this screen.
    if (prev.resetKey !== this.props.resetKey && this.state.message !== null) {
      this.setState({ message: null });
    }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Kept in the console for whoever is debugging; the user gets the panel.
    console.error("NYRO view crashed:", error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.message === null) return this.props.children;
    return (
      <section className="rounded border border-stop/40 bg-panel">
        <header className="border-b border-line px-4 py-2.5">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stop">This view stopped working</h2>
        </header>
        <div className="space-y-2 p-4">
          <p className="prose-sans text-[11.5px] leading-relaxed text-body">
            Something in this screen threw while rendering. Your conversations are stored in Postgres and are not
            affected — switching to another tab and back will retry.
          </p>
          <p className="text-[11px] text-dim">{this.state.message}</p>
          <button
            type="button"
            onClick={() => this.setState({ message: null })}
            className="rounded border border-line px-3 py-1.5 text-xs text-body transition hover:border-accent/40 hover:text-accent"
          >
            Try again
          </button>
        </div>
      </section>
    );
  }
}
