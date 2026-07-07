/**
 * Task 25 smoke proof: the status-line header only. Tasks 26-27 add the filter
 * chips, the departure board, and the two light cards on top of these tokens.
 */
export function App() {
  return (
    <div className="min-h-full">
      <header className="bg-ink text-board-txt">
        <div className="mx-auto max-w-6xl px-4 py-3">
          <div className="flex items-baseline gap-3 font-mono">
            <span className="text-amber font-semibold tracking-[0.12em] uppercase">
              DOVOLENKY
            </span>
            <span className="text-board-muted">/</span>
            <span className="text-board-muted tracking-[0.12em] uppercase text-sm">
              osobní terminál zájezdů
            </span>
          </div>
        </div>
      </header>
    </div>
  );
}
