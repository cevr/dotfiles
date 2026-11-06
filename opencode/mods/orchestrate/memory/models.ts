// Models held in memory: OpenCode's models (opencode/models.ts) over a host
// whose every session runs on one model, offered at a fixed list of variants,
// beside any other models it offers.
import { Effect } from "effect"
import * as OpenCodeModels from "../opencode/models.ts"
import type { ModelRef } from "../pace.ts"
import type { Offered } from "../service.ts"

/** One model for every agent, offered at `variants`, none when absent; `others` are offered too. */
export const layer = (model: ModelRef | undefined, variants: ReadonlyArray<string> = [], others: ReadonlyArray<Offered> = []) =>
  OpenCodeModels.layer({
    session: () => Effect.succeed({ directory: "memory", ...(model === undefined ? {} : { model }) }),
    agentModel: () => Effect.succeed(undefined),
    defaultModel: () => Effect.succeed(undefined),
    offered: () => Effect.succeed([...(model === undefined ? [] : [{ ...model, variants: variants.map((id) => ({ id })) }]), ...others]),
  })
