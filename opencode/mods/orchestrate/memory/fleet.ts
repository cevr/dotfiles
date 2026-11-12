import { Effect, Layer, Option } from "effect"
import { Fleet } from "../service.ts"

/** One record the plugin asked for: the verifier's report, when named, and the batch. */
export interface Asked {
  readonly report: string
  readonly batch: string
}

/** Fleet in memory: each record asked lands in `asked` (a report not named as the empty string). */
export const layer = (asked: Array<Asked>) =>
  Layer.succeed(
    Fleet,
    Fleet.of({
      record: (input) => Effect.sync(() => void asked.push({ report: Option.getOrElse(input.report, () => ""), batch: input.batch })),
    }),
  )
