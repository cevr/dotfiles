// Where the route plugin (tui.ts), loaded by the host, lends the harness
// (app.ts) the router's navigate, and a test the window's session tabs. The
// host loads its plugins as modules of their own, so the plugin's copy of this
// file is not the harness's: the two meet on one process-wide key.
import { Option } from "effect"
import { globalSlot } from "../../tests/global-slot.ts"

/** The window's session tabs, as the plugin API has them: the roots open in this TUI, and a close. */
export interface Tabs {
  readonly list: () => ReadonlyArray<string>
  readonly close: (sessionID: string) => boolean
}

/** The router a booted app lent: none before its route plugin loaded, or after its app closed. */
export interface Router {
  navigate: Option.Option<(sessionID: string) => void>
  tabs: Option.Option<Tabs>
}

const KEY = Symbol.for("dotfiles.sim-tui.router")
const slot = globalSlot<Router>(KEY)
const empty = () => ({ navigate: Option.none(), tabs: Option.none() })
// The first copy of this file in the process puts the empty router in.
if (Option.isNone(slot.get())) slot.set(empty())

/** The process's router. */
export const router = (): Router => Option.getOrElse(slot.get(), empty)
