// Where the route plugin (tui.ts), loaded by the host, lends the harness
// (app.ts) the router's navigate. The host loads its plugins as modules of
// their own, so the plugin's copy of this file is not the harness's: the two
// meet on one process-wide key.
import { Option } from "effect"

/** The router a booted app lent: none before its route plugin loaded, or after its app closed. */
export interface Router {
  navigate: Option.Option<(sessionID: string) => void>
}

const KEY = Symbol.for("dotfiles.sim-tui.router")
const registry: { [key: symbol]: Router } = globalThis
// The first copy of this file in the process puts the empty router in.
registry[KEY] ??= { navigate: Option.none() }

/** The process's router. */
export const router = (): Router => registry[KEY] ?? { navigate: Option.none() }
