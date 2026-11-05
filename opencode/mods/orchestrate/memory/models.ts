// Models held in memory: OpenCode's models (opencode/models.ts) over a host
// whose every session runs on one model, offered at a fixed list of variants.
import { Effect } from "effect"
import * as OpenCodeModels from "../opencode/models.ts"
import type { ModelRef } from "../pace.ts"

/** One model for every agent, offered at `variants`; none when absent. */
export const layer = (model: ModelRef | undefined, variants: ReadonlyArray<string> = []) =>
  OpenCodeModels.layer({
    session: () => Effect.succeed({ directory: "memory", ...(model === undefined ? {} : { model }) }),
    agentModel: () => Effect.succeed(undefined),
    defaultModel: () => Effect.succeed(undefined),
    offered: () => Effect.succeed(model === undefined ? [] : [{ ...model, variants: variants.map((id) => ({ id })) }]),
  })
