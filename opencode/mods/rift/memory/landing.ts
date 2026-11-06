// Landing held in memory, for the model's tests: each repository's config,
// each Rift's own changes, the merge of each branch, the checks, the push,
// and the steps taken, in order, for the test to read.
import { Effect, Layer } from "effect"
import type { LandConfig, Merged, Ran, Unit } from "../land.ts"
import { Landing, RiftFailed } from "../service.ts"

export interface World {
  /** Each warm source's config; a source not here has `{ main: "main" }` and no checks. */
  readonly config: Map<string, LandConfig>
  /** Each Rift's own uncommitted changes; none when absent. */
  readonly own: Map<string, ReadonlyArray<string>>
  /** Each branch's merge; absent: merged, nothing regenerated. */
  readonly merges: Map<string, Merged>
  /** The lock files the install after the merges commits. */
  readonly installs: Array<string>
  /** `<path> <gate|accept>` to its exit code and output; absent: 0, `1 pass`. */
  readonly checks: Map<string, { readonly code: number; readonly output: string }>
  /** What Git says when the push fails. */
  pushFails: string | undefined
  /** Each branch whose own push fails, to what Git says. */
  readonly branchFails: Map<string, string>
  /** The steps taken: `start <path> <main>`, `merge <branch>`, `install`, `gate <path>`, `push <path>`, `push-branch <branch>`, `sync <path>`, `accept <path> <RIFT_LAND_BASE>`. */
  readonly steps: Array<string>
}

export const config = (
  main: string,
  gate: string | undefined,
  accept: string | undefined,
  options: { readonly push?: boolean; readonly pushBranches?: boolean } = {},
): LandConfig => ({ main, gate, accept, generated: [], regenerate: undefined, push: options.push ?? true, pushBranches: options.pushBranches ?? false })

export const world = (configs: Readonly<Record<string, LandConfig>> = {}): World => ({
  config: new Map(Object.entries(configs)),
  own: new Map(),
  merges: new Map(),
  installs: [],
  checks: new Map(),
  pushFails: undefined,
  branchFails: new Map(),
  steps: [],
})

export const layer = (state: World) =>
  Layer.succeed(
    Landing,
    Landing.of({
      config: (source) => Effect.succeed(state.config.get(source) ?? config("main", undefined, undefined)),
      ownChanges: (path) => Effect.succeed(state.own.get(path) ?? []),
      start: (integration, main) =>
        Effect.sync(() => {
          state.steps.push(`start ${integration} ${main}`)
          return { base: "base0", previous: "prev0" }
        }),
      merge: (_integration, from) =>
        Effect.sync(() => {
          state.steps.push(`merge ${from.branch}`)
          return state.merges.get(from.branch) ?? { _tag: "Merged" as const, regenerated: [] }
        }),
      install: () =>
        Effect.sync(() => {
          state.steps.push("install")
          return state.installs
        }),
      check: (path, label, _command, env) =>
        Effect.sync((): Ran => {
          state.steps.push(label === "accept" ? `accept ${path} ${env["RIFT_LAND_BASE"] ?? ""}` : `gate ${path}`)
          const scripted = state.checks.get(`${path} ${label}`) ?? { code: 0, output: "1 pass\n" }
          return { ...scripted, seconds: 3, log: `/logs/${label}.log` }
        }),
      push: Effect.fn("Landing.push")(function* (path: string, main: string) {
        state.steps.push(`push ${path}`)
        if (state.pushFails !== undefined) return yield* new RiftFailed({ operation: "git push", message: state.pushFails })
        return `abc1234 Merge into ${main}`
      }),
      pushBranch: Effect.fn("Landing.pushBranch")(function* (unit: Unit) {
        state.steps.push(`push-branch ${unit.branch}`)
        const fails = state.branchFails.get(unit.branch)
        if (fails !== undefined) return yield* new RiftFailed({ operation: "git push", message: fails })
        return `def5678 tip of ${unit.branch}`
      }),
      sync: (path) => Effect.sync(() => void state.steps.push(`sync ${path}`)),
    }),
  )
