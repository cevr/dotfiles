import { Effect, Layer, Option } from "effect"
import { Fleet } from "../service.ts"

/** One record the plugin asked for: the verifier's directory, when known, and the batch. */
export interface Asked {
  readonly directory: string
  readonly batch: string
}

/** Fleet in memory: each record asked lands in `asked` (a directory not known as the empty string). */
export const layer = (asked: Array<Asked>) =>
  Layer.succeed(
    Fleet,
    Fleet.of({
      record: (input) => Effect.sync(() => void asked.push({ directory: Option.getOrElse(input.directory, () => ""), batch: input.batch })),
    }),
  )
