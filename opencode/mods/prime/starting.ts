// The service the TUI talks to, while it is not ready for a prompt: the line that says so (tui/chrome.tsx
// `StartingNotice`) and how long it has been. After a restart the service answers 503 while it starts, then each
// location's providers and models wait for its plugins to activate; a prompt sent meanwhile waits on the server
// with nothing on screen. The TUI reads the two in turn (opencode/build.ts) from the moment its event stream
// connects, and the line shows from STARTING_SHOWN_AFTER_MS on, so a quick reconnect draws nothing.
import { Option } from "effect"

/** What the TUI waits for: the service itself, then its location's plugins. */
export type Starting = { readonly phase: "service" | "plugins"; readonly since: number }

/** A wait shorter than this draws nothing: a reconnect to a ready service answers well within it. */
export const STARTING_SHOWN_AFTER_MS = 1_500

const LEAD: Record<Starting["phase"], string> = { service: "server starting", plugins: "plugins starting" }

/**
 * What the TUI learnt of its service, in the order it reads it: its event stream `connected` (a restart, or the
 * TUI's own start), the service `served` its info (it is up), the location's `providers` answered (its plugins are
 * active). A read that fails teaches nothing: the TUI reads again.
 */
export type Reading = "connected" | "served" | "providers"

/**
 * What the TUI waits for after `reading` at `at`: from a connection, the service; once it serves, the location's
 * plugins, timed from the connection (`located`: the TUI is in a location; with none there are no plugins to wait
 * for); once they answer, nothing.
 */
export const startingAfter = (waiting: Option.Option<Starting>, reading: Reading, at: number, located: boolean): Option.Option<Starting> => {
  if (reading === "connected") return Option.some({ phase: "service", since: at })
  if (reading === "providers" || !located) return Option.none()
  return Option.some({ phase: "plugins", since: Option.match(waiting, { onNone: () => at, onSome: (wait) => wait.since }) })
}

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
 * does meanwhile (faint). None while it waits for nothing, or not long yet.
 */
export const startingLine = (starting: Option.Option<Starting>, now: number): Option.Option<{ readonly lead: string; readonly rest: string }> =>
  starting.pipe(
    Option.filter((wait) => now - wait.since >= STARTING_SHOWN_AFTER_MS),
    Option.map((wait) => ({ lead: LEAD[wait.phase], rest: ` · ${waited(now - wait.since)} · a prompt sent now waits for it` })),
  )
