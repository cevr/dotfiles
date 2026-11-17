// The service the TUI talks to, while it is not ready for a prompt: the line that says so (tui/chrome.tsx
// `StartingNotice`) and how long it has been. After a restart the service answers 503 while it starts, then each
// location's providers and models wait for its plugins to activate; a prompt sent meanwhile waits on the server
// with nothing on screen. The TUI reads the two in turn (opencode/build.ts) from the moment its event stream
// connects, and the line shows from STARTING_SHOWN_AFTER_MS on, so a quick reconnect draws nothing.

/** What the TUI waits for: the service itself, then its location's plugins. */
export type Starting = { readonly phase: "service" | "plugins"; readonly since: number }

/** A wait shorter than this draws nothing: a reconnect to a ready service answers well within it. */
export const STARTING_SHOWN_AFTER_MS = 1_500

/** `12s`, `1m12s`, `1h02m`: the wait so far, in whole seconds. */
export const waited = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`
}

/**
 * The line while the TUI waits: `server starting` or `plugins starting` (muted), then how long and what a prompt
 * does meanwhile (faint). Nothing while it waits for nothing, or not long yet.
 */
export function startingLine(starting: Starting | undefined, now: number): { readonly lead: string; readonly rest: string } | undefined {
  if (starting === undefined || now - starting.since < STARTING_SHOWN_AFTER_MS) return undefined
  return {
    lead: starting.phase === "service" ? "server starting" : "plugins starting",
    rest: ` · ${waited(now - starting.since)} · a prompt sent now waits for it`,
  }
}
