import { Effect, Layer, Option } from "effect"
import { FleetOutcome } from "../fleet.ts"
import { Fleet } from "../service.ts"

/** One record the plugin asked for: the verifier's report, when named, and the batch. */
export interface Asked {
  readonly report: string
  readonly batch: string
}

/**
 * Fleet in memory: each record asked lands in `asked` (a report not named as the empty string),
 * and answers `outcome`'s answer for it (`Off`, nothing to say, unless a test names one). It covers
 * the directories `covers` answers for (every one unless a test names which).
 */
export const layer = (asked: Array<Asked>, outcome: (asked: Asked) => FleetOutcome = () => FleetOutcome.Off(), covers: (directory: string) => boolean = () => true) =>
  Layer.succeed(
    Fleet,
    Fleet.of({
      record: (input) =>
        Effect.sync(() => {
          const each = { report: Option.getOrElse(input.report, () => ""), batch: input.batch }
          asked.push(each)
          return outcome(each)
        }),
      covers: (directory) => Effect.sync(() => covers(directory)),
    }),
  )
