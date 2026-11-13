// `bun formal/orchestrate/story.ts <trace.itf.json>…`: each machine.qnt trace (a `quint run` trace, or Apalache's
// `violation1.itf.json`) as numbered steps in the code's words, ending at the pipeline's break when it has one,
// and where machine.ts parts from it when it does.
//
// A CLI adapter: the root has no Effect platform layer, so it reads its argv from process and each trace with
// Bun.file.
import { Array as Arr, Console, Effect, Option } from "effect"
import * as Real from "../../mods/orchestrate/machine.ts"
import { replay, storyOf } from "./replay.ts"
import { decodeTrace } from "./trace.ts"

const tell = Effect.fn("Formal.story")(function* (file: string) {
  const text = yield* Effect.promise(() => Bun.file(file).text())
  const steps = yield* decodeTrace(text)
  yield* Console.log(`── ${file}`)
  yield* Effect.forEach(storyOf(steps), (line) => Console.log(line))
  const parted = yield* replay(Real, steps)
  yield* Console.log(
    Option.match(parted, {
      onNone: () => "machine.ts: decides and folds every step as the model does",
      onSome: (at) => `machine.ts parts from the model at step ${at.step}: ${at.what}`,
    }),
  )
})

void Effect.runPromise(Effect.forEach(Arr.drop(process.argv, 2), tell))
