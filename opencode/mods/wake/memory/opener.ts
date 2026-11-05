// An opener held in memory: it answers what `answer` says for each latch it
// is asked, and records the latches asked; with no `answer` it cannot be
// reached. The model's tests script it.
import { Effect, Layer } from "effect"
import type { Latch, Opened } from "../latch.ts"
import { Opener, OpenerUnavailable } from "../service.ts"

export interface MemoryOpener {
  answer: ((latch: Latch) => Opened) | undefined
  readonly asked: Array<Latch>
}

export const empty = (answer?: (latch: Latch) => Opened): MemoryOpener => ({ answer, asked: [] })

export const layer = (memory: MemoryOpener) =>
  Layer.succeed(Opener, {
    open: (latch) =>
      Effect.suspend(() => {
        memory.asked.push(latch)
        return memory.answer === undefined ? Effect.fail(new OpenerUnavailable({ message: "no opener" })) : Effect.succeed(memory.answer(latch))
      }),
  })
