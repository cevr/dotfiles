// Landing held in memory, for the model's tests: each repository's config,
// each Rift's own changes, the merge of each branch, the checks, the push,
// and the steps taken, in order, for the test to read.
import { Clock, Effect, Layer, Match, Option } from "effect"
import type { HostLoad, LandConfig, Merged, PostLanded, Ran, Unit } from "../land.ts"
import { type LandRecord, type Receipt, Standing, standing } from "../receipt.ts"
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
  /** Each post-land step's environment, in order (RIFT_LAND_BASE, RIFT_LAND_HEAD, RIFT_POST_LAND_LOAD). */
  readonly postLandEnvs: Array<Readonly<Record<string, string>>>
  /** What each post-land step runs before it ends, standing for a long run; at first, nothing. */
  postLandHold: Effect.Effect<void>
  /** What each gate and accept check runs before it ends, standing for a long run; at first, nothing. */
  readonly checkHold: Record<"gate" | "accept", Effect.Effect<void>>
  /** Each Rift's round receipt standing, by its path; absent: none (`Missing`). */
  readonly standings: Map<string, Standing>
  /** Each checkout's head, by its path; absent: `head-<its name>`. */
  readonly heads: Map<string, string>
  /** Each land's record, in order. */
  readonly records: Array<LandRecord>
  /** The host's load the post-land step reads first; absent: idle on 8 cores. */
  load: HostLoad | undefined
  /** Every load reading taken, with its time on the Effect clock. */
  readonly readings: Array<{ readonly at: number; readonly load: HostLoad }>
  /** What Git says when the push fails. */
  pushFails: string | undefined
  /** The pushed commit's hash for each push, counted from 1; at first, `abc1234` for every one. */
  headOf: (push: number) => string
  /** The pushes so far. */
  pushes: number
  /** Each branch whose own push fails, to what Git says. */
  readonly branchFails: Map<string, string>
  /**
   * The steps taken: `start <path> <main>`, `merge <branch>`, `install`, `regenerate`, `commit <files>` (what it
   * rewrote, one commit), `gate <path>`, `push <path>`, `push-branch <branch>`, `sync <path>`, `accept <path>
   * <RIFT_LAND_BASE>`, `load`, `post-land <path> <RIFT_LAND_BASE> <RIFT_LAND_HEAD>`, `ended post-land <path>`, and
   * by receipts: `standing <path>`, `focus <path> <command>`, `merge-check <path> <RIFT_LAND_BASE>`, `record <head>`.
   */
  readonly steps: Array<string>
}

export const config = (
  main: string,
  gate: string | undefined,
  accept: string | undefined,
  options: {
    readonly push?: boolean
    readonly pushBranches?: boolean
    readonly generated?: ReadonlyArray<string>
    readonly regenerate?: string
    readonly postLand?: string
    readonly mergeCheck?: string
    readonly focus?: string
  } = {},
): LandConfig => ({
  main,
  gate,
  accept,
  generated: options.generated ?? [],
  regenerate: options.regenerate,
  push: options.push ?? true,
  pushBranches: options.pushBranches ?? false,
  postLand: options.postLand,
  mergeCheck: Option.fromUndefinedOr(options.mergeCheck),
  focus: Option.fromUndefinedOr(options.focus),
})

/** A green round receipt of `path` at `head`, as a Rift's round gate writes one. */
export const receiptOf = (path: string, head: string, kind: Receipt["kind"] = "round", code = 0): Receipt => ({
  repo: path,
  head,
  tree: `tree-${head}`,
  kind,
  checks: [{ command: "bun run gate --focused", code, seconds: 3 }],
  at: "2026-11-13T12:00:00.000Z",
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
  postLandEnvs: [],
  postLandHold: Effect.void,
  checkHold: { gate: Effect.void, accept: Effect.void },
  standings: new Map(),
  heads: new Map(),
  records: [],
  load: undefined,
  readings: [],
  pushFails: undefined,
  headOf: () => "abc1234",
  pushes: 0,
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
        }).pipe(Effect.tap(() => state.checkHold[label])),
      postLand: Effect.fn("Landing.postLand")(function* (path: string, _command: string, env: Readonly<Record<string, string>>) {
        state.steps.push(`post-land ${path} ${env["RIFT_LAND_BASE"] ?? ""} ${env["RIFT_LAND_HEAD"] ?? ""}`)
        state.postLandEnvs.push(env)
        yield* state.postLandHold
        state.steps.push(`ended post-land ${path}`)
        const scripted = state.postLandRun ?? { code: 0, output: "post-land ran\n", report: "post-land: nothing to do\n" }
        return { ...scripted, seconds: 4, log: "/logs/post-land.log" } satisfies PostLanded
      }),
      hostLoad: Effect.map(Clock.currentTimeMillis, (at) => {
        state.steps.push("load")
        const load = state.load ?? { load: 0.5, cores: 8 }
        state.readings.push({ at, load })
        return load
      }),
      push: Effect.fn("Landing.push")(function* (path: string, main: string) {
        state.steps.push(`push ${path}`)
        if (state.pushFails !== undefined) return yield* new RiftFailed({ operation: "git push", message: state.pushFails })
        state.pushes += 1
        return `${state.headOf(state.pushes)} Merge into ${main}`
      }),
      pushBranch: Effect.fn("Landing.pushBranch")(function* (unit: Unit) {
        state.steps.push(`push-branch ${unit.branch}`)
        const fails = state.branchFails.get(unit.branch)
        if (fails !== undefined) return yield* new RiftFailed({ operation: "git push", message: fails })
        return `def5678 tip of ${unit.branch}`
      }),
      sync: (path) => Effect.sync(() => void state.steps.push(`sync ${path}`)),
      standing: (path) =>
        Effect.sync(() => {
          state.steps.push(`standing ${path}`)
          return Option.getOrElse(Option.fromUndefinedOr(state.standings.get(path)), () => Standing.Missing())
        }),
      changed: (path) => Effect.succeed([`${path}/changed.ts`]),
      headOf: (path) => Effect.sync(() => headIn(state, path)),
      receipted: (path, kind, command, env) =>
        Effect.sync(() => {
          const label = RECEIPTED[kind]
          state.steps.push(Match.value(kind).pipe(
            Match.when("round", () => `focus ${path} ${command}`),
            Match.when("merge", () => `merge-check ${path} ${env["RIFT_LAND_BASE"]}`),
            Match.orElse(() => `accept ${path} ${env["RIFT_LAND_BASE"]}`),
          ))
          const scripted = Option.getOrElse(Option.fromUndefinedOr(state.checks.get(`${path} ${label}`)), () => ({ code: 0, output: "1 pass\n" }))
          const receipt = { ...receiptOf(path, headIn(state, path), kind), checks: [{ command, code: scripted.code, seconds: 3 }] }
          if (kind === "round") state.standings.set(path, standing(Option.some(receipt), { head: receipt.head, tree: receipt.tree }))
          return { ran: { ...scripted, seconds: 3, log: `/logs/${label}.log` }, receipt }
        }).pipe(Effect.tap(() => state.checkHold[HOLD[kind]])),
      record: (landed) =>
        Effect.sync(() => {
          state.steps.push(`record ${landed.head}`)
          state.records.push(landed)
          return `/logs/receipts/${landed.head}.land.json`
        }),
    }),
  )

/** The check label a receipted run of each kind is scripted by in `checks`. */
const RECEIPTED = { round: "focus", merge: "merge", accept: "accept" } as const

/** The hold (`checkHold`) a receipted run of each kind runs before it ends: a land's own checks the gate's, the accept check its own. */
const HOLD = { round: "gate", merge: "gate", accept: "accept" } as const

/** The head of the checkout at `path`, as the world says, else one named for it. */
const headIn = (state: World, path: string): string => Option.getOrElse(Option.fromUndefinedOr(state.heads.get(path)), () => `head-${path.split("/").at(-1)}`)
