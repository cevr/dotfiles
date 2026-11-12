// The skill and the run records held in memory, for the plugin's seam tests:
// a history of skill versions (oldest first, each with its subject) that a
// test moves forward, and each run dir's seen version and departures.
import { Effect, Layer } from "effect"
import { RunRecords, Skill } from "../service.ts"
import type { Relation } from "../skill-drift.ts"

/** A skill's history, oldest first; the installed version is `installed`, else the last. Empty: no skill to read. */
export interface MemorySkill {
  readonly history: Array<{ readonly hash: string; readonly subject: string }>
  readonly installed?: string
}

export const skill = (state: MemorySkill) =>
  Layer.succeed(Skill, {
    version: Effect.sync(() => state.installed ?? state.history.at(-1)?.hash),
    // It yields first, as git's answer is asynchronous, so two checks at once interleave.
    relation: (seen, installed) =>
      Effect.yieldNow.pipe(Effect.andThen(Effect.sync((): Relation | undefined => {
        const at = (hash: string) => state.history.findIndex((entry) => entry.hash === hash)
        const [from, to] = [at(seen), at(installed)]
        if (to === -1) return undefined
        if (from === to) return { _tag: "Same" }
        if (from === -1) return { _tag: "Unrelated", subjects: state.history.slice(0, to + 1).reverse().map((entry) => entry.subject) }
        if (from > to) return { _tag: "Older" }
        return { _tag: "Newer", subjects: state.history.slice(from + 1, to + 1).reverse().map((entry) => entry.subject) }
      }))),
  })

/** Each run dir's seen version and its departure lines, and each line logged near a path, in order. */
export interface MemoryRecords {
  readonly seen: Map<string, string>
  readonly departures?: Readonly<Record<string, ReadonlyArray<string>>>
  readonly logged?: Array<{ readonly near: string; readonly line: string }>
}

export const records = (state: MemoryRecords) =>
  Layer.succeed(RunRecords, {
    seen: (runDir) => Effect.sync(() => state.seen.get(runDir)),
    see: (runDir, version) => Effect.sync(() => void state.seen.set(runDir, version)),
    departures: (runDir) => Effect.sync(() => state.departures?.[runDir] ?? []),
    log: ({ near, line }) => Effect.sync(() => void state.logged?.push({ near, line })),
  })
