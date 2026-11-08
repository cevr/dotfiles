// The rift tool's handler: it reads where the calling session runs, finds the
// warm source, and creates, lists, removes and lands Rifts through the Rifts
// and Landing contracts, removing only what `removal` (workspace.ts) allows,
// and runs the workbox's own scripts through Workbox. A land's accept check
// runs in the background, in this layer's scope, and wakes the calling
// session through Notices. A repository with `rift.push` false is checked,
// not pushed: each Rift answered green or red, every Rift kept. The plugin
// calls this and nothing else.
import { Context, Effect, Layer, Scope, Semaphore } from "effect"
import { findRift, resolvePath } from "./find.ts"
import {
  GateMissing,
  INTEGRATION,
  LandRefused,
  LandStopped,
  acceptedText,
  checkAcceptedText,
  checkedText,
  digest,
  explainLand,
  landedText,
  type LandConfig,
  type Landed,
  type Outcome,
  type Unit,
} from "./land.ts"
import {
  BranchMissing,
  NoSuchRift,
  RepositoryMissing,
  RiftsMissing,
  TargetMissing,
  baseName,
  created,
  explainInput,
  listed,
  notOnWorkbox,
  ranOnWorkbox,
  removed,
  workspaceName,
  type InputRefused,
  type RiftInput,
} from "./rift.ts"
import { Landing, Notices, Rifts, SessionDirectories, Workbox, type NotOnWorkbox, type RiftFailed, type SessionUnreadable, type WorkboxCommand } from "./service.ts"
import { explainRefusal, removal, type RemoveRefused, type Workspace } from "./workspace.ts"

export { resolvePath }

/** One answer: the text the model reads and what the transcript keeps. */
export interface Answer {
  readonly text: string
  readonly metadata: {
    readonly action: RiftInput["action"]
    readonly source?: string
    readonly path?: string
    readonly branch?: string
    readonly rifts?: ReadonlyArray<string>
  }
}

export type Failure = InputRefused | RemoveRefused | RiftFailed | SessionUnreadable | GateMissing | LandRefused | LandStopped | NotOnWorkbox

export class RiftTool extends Context.Service<
  RiftTool,
  {
    /** Acts on one call of the tool from `sessionID`. */
    readonly run: (sessionID: string, input: RiftInput) => Effect.Effect<Answer, Failure>
  }
>()("dotfiles-opencode/rift/RiftTool") {}

/** The outcomes in the order of `units`, the order the land named them. */
const inOrder = (units: ReadonlyArray<Unit>, outcomes: ReadonlyArray<Outcome>): ReadonlyArray<Outcome> =>
  units.flatMap((unit) => outcomes.filter((outcome) => outcome.unit.path === unit.path))

const branchList = (units: ReadonlyArray<Unit>): string => units.map((unit) => unit.branch).join(", ")

/** At most `limit` lines, indented, and how many more there are. */
const some = (lines: ReadonlyArray<string>, limit = 10): string =>
  [...lines.slice(0, limit).map((line) => `  ${line}`), ...(lines.length > limit ? [`  … and ${lines.length - limit} more`] : [])].join("\n")

/** The command line a workbox action runs, as the answer names it. */
const commandLine = (command: WorkboxCommand): string => {
  switch (command._tag) {
    case "init":
      return ["workrift init", command.repository, ...(command.path === undefined ? [] : [command.path])].join(" ")
    case "prune":
      return "workrift prune --dry-run"
    case "storage":
      return "workbox-rift-storage --check"
    default:
      return `workrift ${command._tag}`
  }
}

export const layer = Layer.effect(
  RiftTool,
  Effect.gen(function* () {
    const rifts = yield* Rifts
    const sessions = yield* SessionDirectories
    const landing = yield* Landing
    const notices = yield* Notices
    const workbox = yield* Workbox
    const scope = yield* Scope.Scope
    // One accept check at a time: each one fills the machine.
    const accepts = yield* Semaphore.make(1)
    // Each integration Rift at work, with what it is doing.
    const busy = new Map<string, string>()

    /** The Rift `target` names among `source`'s: a path (absolute, or against `directory`), else a name. */
    const locate = Effect.fn("RiftTool.locate")(function* (directory: string, source: string, target: { readonly name?: string | undefined; readonly path?: string | undefined }) {
      if (target.path !== undefined) return resolvePath(directory, target.path)
      if (target.name === undefined) return yield* new TargetMissing()
      const name = target.name
      const paths = yield* rifts.list(source)
      const match = paths.find((path) => baseName(path) === name) ?? paths.find((path) => baseName(path) === workspaceName(name))
      if (match === undefined) return yield* new NoSuchRift({ name, source, rifts: [...paths] })
      return match
    })

    /** The Rift at `path` and every Rift below it, deepest last. */
    const subtree = (workspace: Workspace): Effect.Effect<ReadonlyArray<Workspace>, RiftFailed> =>
      Effect.forEach(workspace.children, (child) => rifts.inspect(child).pipe(Effect.flatMap(subtree)), { concurrency: 4 }).pipe(
        Effect.map((below) => [workspace, ...below.flat()]),
      )

    const create = Effect.fn("RiftTool.create")(function* (directory: string, source: string, input: RiftInput) {
      const branch = input.branch ?? input.name
      if (branch === undefined || branch.trim() === "") return yield* new BranchMissing()
      const name = input.name ?? workspaceName(branch)
      const path = yield* rifts.create({ source, from: directory, name, branch })
      const workspace = yield* rifts.inspect(path)
      return {
        text: created(workspace, source),
        metadata: { action: "create" as const, source, path, ...(workspace.branch === undefined ? {} : { branch: workspace.branch }) },
      }
    })

    const list = Effect.fn("RiftTool.list")(function* (source: string) {
      const workspaces: ReadonlyArray<Workspace> = yield* Effect.forEach(yield* rifts.list(source), rifts.inspect, { concurrency: 4 })
      return { text: listed(source, workspaces), metadata: { action: "list" as const, source } }
    })

    const remove = Effect.fn("RiftTool.remove")(function* (directory: string, source: string, input: RiftInput) {
      const workspace = yield* rifts.inspect(yield* locate(directory, source, input))
      const withChildren = input.withChildren === true
      const request = { force: input.force === true, sessionDirectory: directory }
      if (withChildren) {
        // Each Rift that goes holds no unsaved work; the children are going too, so they keep none back.
        const all = yield* subtree(workspace)
        yield* Effect.forEach(all, (each) => removal({ ...each, children: [] }, request), { discard: true })
      } else yield* removal(workspace, request)
      yield* rifts.remove(workspace.path, { withChildren })
      return {
        text: removed(workspace),
        metadata: { action: "remove" as const, source, path: workspace.path, ...(workspace.branch === undefined ? {} : { branch: workspace.branch }) },
      }
    })

    /** Trashes a landed Rift when nothing of its own would go with it; answers why it stays, if it does. Never fails. */
    const removeLanded = (path: string, source: string, directory: string): Effect.Effect<string | undefined> =>
      Effect.gen(function* () {
        // Its branch is on origin now; a fetch lets it read so.
        yield* landing.sync(path)
        const workspace = yield* rifts.inspect(path)
        // A change also in the warm source (a private file it holds uncommitted) is found elsewhere.
        const uncommitted = yield* landing.ownChanges(path, source)
        const allowed = yield* Effect.result(removal({ ...workspace, uncommitted }, { force: false, sessionDirectory: directory }))
        if (allowed._tag === "Failure") return explainRefusal(allowed.failure)
        yield* rifts.remove(path)
        return undefined
      }).pipe(Effect.catch((failure: RiftFailed) => Effect.succeed(failureText(failure))))

    /** The batch's accept check in the integration Rift, then the wake. Runs in the background. */
    const accept = (sessionID: string, integration: string, units: ReadonlyArray<Unit>, command: string, base: string) =>
      accepts
        .withPermits(1)(landing.check(integration, "accept", command, { RIFT_LAND_BASE: base }))
        .pipe(
          Effect.flatMap((ran) =>
            notices.wake(sessionID, {
              text: acceptedText(units, ran),
              description: `rift land · accept ${ran.code === 0 ? "passed" : "failed"}`,
            }),
          ),
          Effect.catch((failure: RiftFailed) =>
            notices.wake(sessionID, {
              text: `rift land: the accept check for ${units.map((unit) => unit.branch).join(", ")} did not run: ${failureText(failure)}. The batch is already pushed.`,
              description: "rift land · accept did not run",
            }),
          ),
        )

    /** Each Rift green, its own branch pushed when `pushBranches` is set; a refused push is named, never fatal. */
    const greens = (merged: ReadonlyArray<Unit>, pushBranches: boolean): Effect.Effect<ReadonlyArray<Outcome>> =>
      Effect.forEach(merged, (unit) =>
        pushBranches
          ? landing.pushBranch(unit).pipe(
              Effect.map((pushed): Outcome => ({ unit, verdict: "green", note: `branch pushed: ${pushed}` })),
              Effect.catch((failure: RiftFailed) => Effect.succeed<Outcome>({ unit, verdict: "green", note: `branch not pushed: ${failureText(failure)}` })),
            )
          : Effect.succeed<Outcome>({ unit, verdict: "green" }),
      )

    /** A checked batch's accept check in the integration Rift, then the wake with each Rift's result. Runs in the background. */
    const acceptChecked = (
      sessionID: string,
      integration: string,
      merged: ReadonlyArray<Unit>,
      reds: ReadonlyArray<Outcome>,
      units: ReadonlyArray<Unit>,
      command: string,
      base: string,
      config: LandConfig,
    ) =>
      accepts
        .withPermits(1)(landing.check(integration, "accept", command, { RIFT_LAND_BASE: base }))
        .pipe(
          Effect.flatMap((ran) =>
            (ran.code === 0 ? greens(merged, config.pushBranches) : Effect.succeed(merged.map((unit): Outcome => ({ unit, verdict: "red", note: "the accept check failed" })))).pipe(
              Effect.flatMap((outcomes) =>
                notices.wake(sessionID, {
                  text: checkAcceptedText(config.main, merged, ran, inOrder(units, [...outcomes, ...reds])),
                  description: `rift land · accept ${ran.code === 0 ? "passed" : "failed"}`,
                }),
              ),
            ),
          ),
          Effect.catch((failure: RiftFailed) =>
            notices.wake(sessionID, {
              text: `rift land: the accept check for ${branchList(merged)} did not run: ${failureText(failure)}. ${config.main} was not pushed; land again.`,
              description: "rift land · accept did not run",
            }),
          ),
        )

    /** The Rift at `path` as a unit of the batch, or why it cannot be one. */
    const unitOf = Effect.fn("RiftTool.unitOf")(function* (path: string, source: string) {
      const workspace = yield* rifts.inspect(path)
      if (workspace.source) return yield* new LandRefused({ path, reason: "is a warm source; land a Rift made from one." })
      if (baseName(path) === INTEGRATION) return yield* new LandRefused({ path, reason: "is the integration Rift land merges in; land the Rifts it merged." })
      if (!workspace.git || workspace.branch === undefined) return yield* new LandRefused({ path, reason: "is not on a Git branch." })
      const own = yield* landing.ownChanges(path, source)
      if (own.length > 0) return yield* new LandRefused({ path, reason: `holds uncommitted changes; commit them first:\n${some(own)}` })
      return { path, branch: workspace.branch } satisfies Unit
    })

    /** The source's integration Rift: the one named INTEGRATION, made on first use. */
    const integrationOf = (source: string) =>
      rifts.list(source).pipe(
        Effect.flatMap((paths) => {
          const found = paths.find((path) => baseName(path) === INTEGRATION)
          return found === undefined ? rifts.create({ source, from: source, name: INTEGRATION, branch: INTEGRATION }) : Effect.succeed(found)
        }),
      )

    const land = Effect.fn("RiftTool.land")(function* (sessionID: string, directory: string, source: string, input: RiftInput) {
      const targets = input.rifts ?? []
      if (targets.length === 0) return yield* new RiftsMissing()
      // Every Rift is found and checked before any is touched.
      const paths = yield* Effect.forEach(targets, (target) => findRift(directory, source, target).pipe(Effect.provideService(Rifts, rifts)))
      const units = yield* Effect.forEach(paths, (path) => unitOf(path, source))
      const config = yield* landing.config(source)
      const gateCommand = config.gate
      if (gateCommand === undefined) return yield* new GateMissing({ source })

      const integration = yield* integrationOf(source).pipe(Effect.mapError((failure) => new LandStopped({ path: source, step: "start", detail: failure.message })))
      // One batch at a time in an integration Rift, its accept check included.
      if (busy.has(integration)) return yield* new LandRefused({ path: integration, reason: `is busy: ${busy.get(integration)}. Land again after its wake.` })
      busy.set(integration, "a batch is landing")
      let accepting = false
      return yield* Effect.gen(function* () {
        const stopped = (step: LandStopped["step"], detail: string, path = integration) => new LandStopped({ path, step, detail })
        const started = yield* landing.start(integration, config.main).pipe(Effect.mapError((failure) => stopped("start", failure.message)))
        const locks: Array<string> = []
        // A batch that is not pushed checks the Rifts that merge; a conflict reds only its own Rift.
        const conflicts = new Map<string, ReadonlyArray<string>>()
        for (const unit of units) {
          const merged = yield* landing.merge(integration, unit, config).pipe(Effect.mapError((failure) => stopped("merge", failure.message, unit.path)))
          if (merged._tag === "Conflict") {
            if (config.push) return yield* stopped("conflict", some(merged.files, 50), unit.path)
            conflicts.set(unit.path, merged.files)
            continue
          }
          locks.push(...merged.regenerated)
        }
        const merged = units.filter((unit) => !conflicts.has(unit.path))
        locks.push(...(yield* landing.install(integration, started.previous).pipe(Effect.mapError((failure) => stopped("install", failure.message)))))
        // A clean merge can still leave a generated file stale (its sources changed in another Rift): write them again every batch.
        if (config.regenerate !== undefined && merged.length > 0)
          locks.push(...(yield* landing.regenerate(integration, config).pipe(Effect.mapError((failure) => stopped("regenerate", failure.message)))))
        const gate = merged.length === 0 ? undefined : yield* landing.check(integration, "gate", gateCommand, {})

        if (!config.push) {
          const conflicted = (unit: Unit): Outcome => ({ unit, verdict: "red", note: `conflicts with the batch: ${conflicts.get(unit.path)!.join(", ")}` })
          const answer = (outcomes: ReadonlyArray<Outcome>) => ({
            text: checkedText({
              units,
              main: config.main,
              base: started.base,
              integration,
              gate,
              locks: [...new Set(locks)],
              outcomes: inOrder(units, [...outcomes, ...units.filter((unit) => conflicts.has(unit.path)).map(conflicted)]),
              accepting,
              pushBranches: config.pushBranches,
            }),
            metadata: { action: "land" as const, source, path: integration, rifts: paths },
          })
          if (gate === undefined) return answer([])
          if (gate.code !== 0) return answer(merged.map((unit) => ({ unit, verdict: "red" as const, note: "the batch gate failed" })))
          if (config.accept === undefined) return answer(yield* greens(merged, config.pushBranches))
          busy.set(integration, `the accept check of ${branchList(merged)} runs there`)
          accepting = true
          const reds = units.filter((unit) => conflicts.has(unit.path)).map(conflicted)
          yield* Effect.forkIn(
            acceptChecked(sessionID, integration, merged, reds, units, config.accept, started.base, config).pipe(Effect.ensuring(Effect.sync(() => busy.delete(integration)))),
            scope,
          )
          return answer(merged.map((unit) => ({ unit, verdict: "pending" as const, note: "the accept check runs" })))
        }

        if (gate === undefined) return yield* stopped("gate", "no Rift merged")
        if (gate.code !== 0) return yield* stopped("gate", `exit ${gate.code} in ${gate.seconds}s; log: ${gate.log}\n${digest(gate.output)}`)
        const pushed = yield* landing.push(integration, config.main).pipe(Effect.mapError((failure) => stopped("push", failure.message)))

        const kept: Array<{ path: string; why: string }> = []
        for (const unit of units) {
          const why = yield* removeLanded(unit.path, source, directory)
          if (why !== undefined) kept.push({ path: unit.path, why })
        }
        const landed: Landed = { units, main: config.main, base: started.base, pushed, gate, locks: [...new Set(locks)], kept }
        if (config.accept !== undefined) {
          busy.set(integration, `the accept check of ${units.map((unit) => unit.branch).join(", ")} runs there`)
          accepting = true
          yield* Effect.forkIn(accept(sessionID, integration, units, config.accept, started.base).pipe(Effect.ensuring(Effect.sync(() => busy.delete(integration)))), scope)
        }
        return { text: landedText(landed, integration, accepting), metadata: { action: "land" as const, source, path: integration, rifts: paths } }
      }).pipe(Effect.ensuring(Effect.sync(() => (accepting ? undefined : busy.delete(integration)))))
    })

    const onWorkbox = Effect.fn("RiftTool.onWorkbox")(function* (directory: string, input: RiftInput, action: WorkboxCommand["_tag"]) {
      const sourceOf = () => rifts.source(input.source === undefined ? directory : resolvePath(directory, input.source))
      switch (action) {
        case "init": {
          if (input.repository === undefined || input.repository.trim() === "") return yield* new RepositoryMissing()
          const command = { _tag: "init" as const, repository: input.repository, path: input.path === undefined ? undefined : resolvePath(directory, input.path) }
          return { text: ranOnWorkbox(commandLine(command), yield* workbox.run(command, directory)), metadata: { action } }
        }
        case "deps": {
          // In the named Rift, else where the session runs.
          const where = input.name === undefined && input.path === undefined ? directory : yield* locate(directory, yield* sourceOf(), input)
          return { text: ranOnWorkbox(`${commandLine({ _tag: action })} in ${where}`, yield* workbox.run({ _tag: action }, where)), metadata: { action, path: where } }
        }
        case "refresh":
        case "check": {
          const source = yield* sourceOf()
          return { text: ranOnWorkbox(`${commandLine({ _tag: action })} of ${source}`, yield* workbox.run({ _tag: action }, directory, source)), metadata: { action, source } }
        }
        case "sources":
        case "prune":
        case "storage":
          return { text: ranOnWorkbox(commandLine({ _tag: action }), yield* workbox.run({ _tag: action }, directory)), metadata: { action } }
      }
    })

    const run = Effect.fn("RiftTool.run")(function* (sessionID: string, input: RiftInput) {
      const directory = yield* sessions.directoryOf(sessionID)
      const source = () => rifts.source(input.source === undefined ? directory : resolvePath(directory, input.source))
      switch (input.action) {
        case "create":
          return yield* create(directory, yield* source(), input)
        case "list":
          return yield* list(yield* source())
        case "remove":
          return yield* remove(directory, yield* source(), input)
        case "land":
          return yield* land(sessionID, directory, yield* source(), input)
        default:
          return yield* onWorkbox(directory, input, input.action)
      }
    })

    return RiftTool.of({ run })
  }),
)

/** What the model reads when a command fails or the session cannot be read. */
export const failureText = (failure: RiftFailed | SessionUnreadable): string =>
  failure._tag === "RiftFailed" ? `${failure.operation} failed: ${failure.message}` : `Cannot tell where this session runs (${failure.message}).`

/** What the model reads when a call does not act. */
export const explain = (failure: Failure): string => {
  switch (failure._tag) {
    case "BranchMissing":
    case "TargetMissing":
    case "NoSuchRift":
    case "AmbiguousRift":
    case "RiftsMissing":
    case "RepositoryMissing":
      return explainInput(failure)
    case "SourceKept":
    case "SessionInside":
    case "ChildrenKept":
    case "WorkUnsaved":
      return explainRefusal(failure)
    case "GateMissing":
    case "LandRefused":
    case "LandStopped":
      return explainLand(failure)
    case "NotOnWorkbox":
      return notOnWorkbox(failure.command)
    case "RiftFailed":
    case "SessionUnreadable":
      return failureText(failure)
  }
}
