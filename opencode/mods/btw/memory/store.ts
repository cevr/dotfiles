// Each session's side question in memory, for the model's tests and the
// laws: SideQuestions over one Ref, with a switch that makes every write fail.
import { Effect, Layer, Ref } from "effect"
import { HostFailed, SideQuestions } from "../service.ts"
import { INITIAL, type SideQuestionState } from "../side-question.ts"

export interface Shelf {
  readonly states: Ref.Ref<ReadonlyMap<string, SideQuestionState>>
  /** When true, every write fails. */
  readonly refusing: Ref.Ref<boolean>
}

export const shelf: Effect.Effect<Shelf> = Effect.all({ states: Ref.make<ReadonlyMap<string, SideQuestionState>>(new Map()), refusing: Ref.make(false) })

export const layer = (shelf: Shelf) =>
  Layer.succeed(
    SideQuestions,
    SideQuestions.of({
      get: (sessionID) => Ref.get(shelf.states).pipe(Effect.map((states) => states.get(sessionID) ?? INITIAL)),
      set: (sessionID, state) =>
        Effect.gen(function* () {
          if (yield* Ref.get(shelf.refusing)) return yield* new HostFailed({ operation: "store", message: "store refused" })
          yield* Ref.update(shelf.states, (states) => new Map(states).set(sessionID, state))
        }),
    }),
  )
