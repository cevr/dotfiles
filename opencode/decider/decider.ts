// An aggregate without a framework: what a command records, decided from the
// state and the time, and the state that what was recorded folds into. A view
// is the fold alone. Every mod's aggregates and views are these shapes.
import type { Effect } from "effect"

/** A read model: a total fold of events into state. */
export interface Fold<State, Event> {
  readonly initial: State
  readonly evolve: (state: State, event: Event) => State
}

/**
 * An aggregate. `decide` is pure: it reads time only from `now` (epoch ms) and
 * returns the events a command records, `[]` when there is nothing to record,
 * or one of the command's declared rejections. `evolve` copies what the events
 * carry and never fails.
 */
export interface Decider<State, Command, Event, Rejection = never> extends Fold<State, Event> {
  readonly decide: (state: State, command: Command, now: number) => Effect.Effect<ReadonlyArray<Event>, Rejection>
}

/** The state `events` fold into, from `from` (the model's initial state by default). */
export const fold = <State, Event>(
  model: Fold<State, Event>,
  events: Iterable<Event>,
  from: State = model.initial,
): State => {
  let state = from
  for (const event of events) state = model.evolve(state, event)
  return state
}
