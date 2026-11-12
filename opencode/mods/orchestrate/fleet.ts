import { Data, DateTime } from "effect"

/** The commits a target names, as the fleet records them. */
export interface Commits {
  readonly dotfiles: string
  readonly fork: string
}

/** A target the fleet records: its commits and the batch that verified them. */
export interface Verified extends Commits {
  readonly batch: string
}

/**
 * What recording an accepted batch's target did (`Fleet.record`):
 * - `Off`: this host records no target (no checkouts configured), so it says nothing.
 * - `Recorded`: the target moved to the batch's heads.
 * - `Unchanged`: the target already names those heads.
 * - `Refused`: nothing was recorded, and `reason` says why: a batch file that does not name both
 *   heads, a head the checkouts or origin lack, a head that is not a descendant of the current
 *   target's, or a push refused.
 */
export type FleetOutcome = Data.TaggedEnum<{
  Off: {}
  Recorded: { readonly target: Verified }
  Unchanged: { readonly target: Verified }
  Refused: { readonly reason: string }
}>
export const FleetOutcome = Data.taggedEnum<FleetOutcome>()

/** The note's description in the root's context. */
export const FLEET_DESCRIPTION = "orchestrate: the fleet target was not published"

const short = (target: Commits) => `dotfiles ${target.dotfiles.slice(0, 10)}, fork ${target.fork.slice(0, 10)}`

/**
 * The line an outcome adds at `at` where the orchestrator reads it (the run's log.md, the root's
 * context, the server's log), stamped like the drift lines; none for `Off`.
 */
export const fleetLineOf = (batch: string, outcome: FleetOutcome, at: number): ReadonlyArray<string> => {
  const stamp = `${DateTime.formatIso(DateTime.makeUnsafe(at)).slice(0, 16)}Z`
  return FleetOutcome.$match(outcome, {
    Off: () => [],
    Recorded: ({ target }) => [`${stamp} fleet: ${batch} accepted; published the verified target ${short(target)}`],
    Unchanged: ({ target }) => [`${stamp} fleet: ${batch} accepted; the verified target is already ${short(target)}`],
    Refused: ({ reason }) => [`${stamp} fleet: ${batch} accepted, but NOT published: ${reason}. Every host stays on the last published target.`],
  })
}
