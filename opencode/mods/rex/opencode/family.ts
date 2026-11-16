// The TUI half's reactive read: the subagents of the family on screen, from
// the TUI's own data, each with whether it runs, and the hand-off of the
// TUI's environment to each one `look` finds due. The session on screen is
// left out (the host's TUI sets its environment itself), and so is the root:
// another TUI may show it. Read inside a Solid computation, every read here
// is reactive.
import type { Effect } from "effect"
import { createEffect } from "solid-js"
import { look, type Member, nothingSeen } from "../family.ts"
import { type Clock, coalescedHands, type HandFailed, notHanded } from "./hand.ts"

/** The reads the follower needs from the TUI plugin's `context.data`; `context.data` satisfies it. */
export interface Reads {
  readonly session: {
    root(sessionID: string): string
    family(sessionID: string): ReadonlyArray<string>
    status(sessionID: string): "idle" | "running"
  }
}

/** The route the TUI shows, as `context.ui.router.current()` returns it. */
export type Route = { readonly type: "session"; readonly sessionID: string } | { readonly type: string }

/** The subagents of `route`'s family, the session on screen and the root aside; none off a session route. */
export const subagentsOf = (reads: Reads, route: Route): ReadonlyArray<Member> => {
  if (!("sessionID" in route) || route.type !== "session" || route.sessionID === "dummy") return []
  const shown = route.sessionID
  const root = reads.session.root(shown)
  return reads.session
    .family(root)
    .filter((id) => id !== root && id !== shown)
    .map((id) => ({ id, running: reads.session.status(id) === "running" }))
}

/**
 * Hands each subagent of the family on screen to `hand` when `look` finds it
 * due: when it first appears, and each time it starts to run again. Run it
 * inside a Solid root; disposing the root stops it.
 */
/** Runs a computation again whenever what it read changes: Solid's `createEffect`, or the reactive build's in a test (Bun resolves solid-js to its server build, which never re-runs one). */
export type Track = (computation: () => void) => void

export const followFamily = (reads: Reads, route: () => Route, hand: (sessionID: string) => void, track: Track = createEffect): void => {
  const state = { seen: nothingSeen }
  track(() => {
    const next = look(state.seen, subagentsOf(reads, route()))
    state.seen = next.seen
    next.due.forEach(hand)
  })
}

/** What the hand-off sends through: the client's `session.environment` for one session (`fromClient`), and the TUI's warning toast. */
export interface HandHost {
  readonly environment: (sessionID: string) => Effect.Effect<void, HandFailed>
  readonly warn: (title: string, message: string) => void
}

/**
 * Follows the family on screen and hands each subagent the environment when
 * it is due, coalesced (`coalescedHands`): a restart's resets are tried again,
 * and what fails for good is one warning per burst. Returns the stop.
 */
export const handFamily = (reads: Reads, route: () => Route, host: HandHost, clock: Clock, track: Track = createEffect): (() => void) => {
  const hands = coalescedHands({
    send: host.environment,
    report: (failed) => host.warn(notHanded(failed.count), failed.error),
    clock,
  })
  followFamily(reads, route, hands.hand, track)
  return hands.dispose
}
