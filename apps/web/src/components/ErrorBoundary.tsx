import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State { error: Error | null }

/** Last line of defence: a rendering error shows a recovery screen instead of a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('FamilyHub crashed while rendering', error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <main role="alert" className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6 text-center">
        <h1 className="font-display text-2xl font-bold">Something went wrong</h1>
        <p className="max-w-md text-sm text-muted-foreground">FamilyHub hit a problem showing this screen. Your data is safe. Reload to continue; if it keeps happening, open the home screen.</p>
        <p className="max-w-md break-words text-xs text-muted-foreground">{this.state.error.message}</p>
        <div className="flex gap-2">
          <button type="button" className="rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground" onClick={() => window.location.reload()}>Reload</button>
          <button type="button" className="rounded-xl border px-4 py-2 text-sm font-semibold" onClick={() => window.location.assign('/')}>Go to home screen</button>
        </div>
      </main>
    );
  }
}
