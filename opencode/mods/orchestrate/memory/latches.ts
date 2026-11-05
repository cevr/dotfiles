// Latches held in memory: OpenCode's latches (opencode/latches.ts) over
// wakes that keep each request in `kept` under a fresh id and child, or
// refuse with `refuse`, and a start that records each child it is asked to
// start in `started`, or fails with `fail`.
import { Effect } from "effect"
import type { LatchAsk } from "@dotfiles/opencode-wake/latch"
import * as OpenCodeLatches from "../opencode/latches.ts"
import type { LatchStart } from "../service.ts"

export interface MemoryLatches {
  refuse: string | undefined
  fail: string | undefined
  readonly kept: Array<LatchAsk & { readonly id: string; readonly child: string }>
  readonly started: Array<LatchStart>
}

export const empty = (): MemoryLatches => ({ refuse: undefined, fail: undefined, kept: [], started: [] })

export const layer = (memory: MemoryLatches) =>
  OpenCodeLatches.layer(
    (ask) =>
      Effect.sync(() => {
        if (memory.refuse !== undefined) return { outcome: "refused", reason: memory.refuse }
        const n = memory.kept.length + 1
        const kept = { ...ask, id: `w00000${n}`, child: `ses_latched${n}` }
        memory.kept.push(kept)
        return { outcome: "latched", id: kept.id, child: kept.child }
      }),
    (start) => (memory.fail === undefined ? Effect.sync(() => void memory.started.push(start)) : Effect.fail(new Error(memory.fail))),
  )
