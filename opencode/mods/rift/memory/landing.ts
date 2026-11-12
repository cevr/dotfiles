// Landing held in memory, for the model's tests: each repository's config,
// each Rift's own changes, the merge of each branch, the checks, the push,
// and the steps taken, in order, for the test to read.
import { Effect, Layer } from "effect"
import type { HostLoad, LandConfig, Merged, PostLanded, Ran, Unit } from "../land.ts"
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
  /** The generated and lock files `rift.regenerate` rewrites after the install, committed as one commit; none: no commit. */
  readonly regenerates: Array<string>
  /** What the regenerate command says when it fails. */
  regenerateFails: string | undefined
  /** `<path> <gate|accept>` to its exit code and output; absent: 0, `1 pass`. */
  readonly checks: Map<string, { readonly code: number; readonly output: string }>
  /** The post-land step's exit, output and report; absent: 0, a report saying it ran. */
  postLandRun: { readonly code: number; readonly output: string; readonly report: string | undefined } | undefined
  /** What each post-land step runs before it ends, standing for a long run; at first, nothing. */
  postLandHold: Effect.Effect<void>
  /** The host's load the post-land step reads first; absent: idle on 8 cores. */
  load: HostLoad | undefined
  /** What Git says when the push fails. */
  pushFails: string | undefined
  /** Each branch whose own push fails, to what Git says. */
  readonly branchFails: Map<string, string>
  /** The steps taken: `start <path> <main>`, `merge <branch>`, `install`, `regenerate`, `commit <files>` (what it rewrote, one commit), `gate <path>`, `push <path>`, `push-branch <branch>`, `sync <path>`, `accept <path> <RIFT_LAND_BASE>`, `load`, `post-land <path> <RIFT_LAND_BASE> <RIFT_LAND_HEAD>`, `ended post-land <path>`. */
  readonly steps: Array<string>
}

export const config = (
  main: string,
  gate: string | undefined,
  accept: string | undefined,
  options: { readonly push?: boolean; readonly pushBranches?: boolean; readonly generated?: ReadonlyArray<string>; readonly regenerate?: string; readonly postLand?: string } = {},
): LandConfig => ({
  main,
  gate,
  accept,
  generated: options.generated ?? [],
  regenerate: options.regenerate,
  push: options.push ?? true,
  pushBranches: options.pushBranches ?? false,
  postLand: options.postLand,
})

export const world = (configs: Readonly<Record<string, LandConfig>> = {}): World => ({
  config: new Map(Object.entries(configs)),
  own: new Map(),
  merges: new Map(),
  installs: [],
  regenerates: [],
  regenerateFails: undefined,
  checks: new Map(),
  postLandRun: undefined,
  postLandHold: Effect.void,
  load: undefined,
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
      regenerate: Effect.fn("Landing.regenerate")(function* () {
        state.steps.push("regenerate")
        if (state.regenerateFails !== undefined) return yield* new RiftFailed({ operation: "sh -c", message: state.regenerateFails })
        if (state.regenerates.length > 0) state.steps.push(`commit ${state.regenerates.join(" ")}`)
        return state.regenerates
      }),
      check: (path, label, _command, env) =>
        Effect.sync((): Ran => {
          state.steps.push(label === "accept" ? `accept ${path} ${env["RIFT_LAND_BASE"] ?? ""}` : `gate ${path}`)
          const scripted = state.checks.get(`${path} ${label}`) ?? { code: 0, output: "1 pass\n" }
          return { ...scripted, seconds: 3, log: `/logs/${label}.log` }
        }),
      postLand: Effect.fn("Landing.postLand")(function* (path: string, _command: string, env: Readonly<Record<string, string>>) {
        state.steps.push(`post-land ${path} ${env["RIFT_LAND_BASE"] ?? ""} ${env["RIFT_LAND_HEAD"] ?? ""}`)
        yield* state.postLandHold
        state.steps.push(`ended post-land ${path}`)
        const scripted = state.postLandRun ?? { code: 0, output: "post-land ran\n", report: "post-land: nothing to do\n" }
        return { ...scripted, seconds: 4, log: "/logs/post-land.log" } satisfies PostLanded
      }),
      hostLoad: Effect.sync(() => {
        state.steps.push("load")
        return state.load ?? { load: 0.5, cores: 8 }
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
