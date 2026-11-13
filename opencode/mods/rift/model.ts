// The rift tool's handler: it reads where the calling session runs, finds the
// warm source, and creates, lists, removes and lands Rifts through the Rifts
// and Landing contracts, removing only what `removal` (workspace.ts) allows,
// and runs the workbox's own scripts through Workbox. A land's accept check
// runs in the background, in this layer's scope, and wakes the calling
// session through Notices. A repository with `rift.push` false is checked,
// not pushed: each Rift answered green or red, every Rift kept. With
// `rift.mergeCheck` a land goes by receipts (`cover`, `mergeGate`, `recordOf`, `afterPush`): never the full
// gate. The plugin calls this and nothing else.
import { Array as Arr, Clock, Context, Data, DateTime, Effect, Layer, Option, Predicate, Result, Scope, Semaphore } from "effect"
import { findRift, resolvePath } from "./find.ts"
import { focusLine, shareOf, type Covered, type Receipt, type Standing } from "./receipt.ts"
import { CHECK_EVERY, baseOf, forcedLine, headOf, loadedLine, loadWord, observe, overloaded, owe, pay, pays, phase, ran, unitsOf, type Debts, type Trigger } from "./owed.ts"
import {
  ACCEPT,
  GateMissing,
  INTEGRATION,
  LandRefused,
  LandStopped,
  POST_LAND,
  acceptedText,
  checkAcceptedText,
  checkedText,
  digest,
  explainLand,
  landedText,
  postLandedText,
  ACCEPT_APART,
  RECEIPT_CLI,
  receiptLandedText,
  receiptLines,
  type LandConfig,
  type Landed,
  type Outcome,
  type Ran,
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
import { Landing, Notices, PostLandClaim, PostLandDebts, Rifts, SessionDirectories, Workbox, type NotOnWorkbox, type RiftFailed, type SessionUnreadable, type WorkboxCommand } from "./service.ts"
import { explainRefusal, removal, StepRunning, type RemoveRefused, type Workspace } from "./workspace.ts"

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

/** How a batch's checks went before its push: the full gate's run (`rift.gate`), or the Rifts' receipts and the merge check, when it ran. */
type Gated = Data.TaggedEnum<{
  Gate: { readonly ran: Ran }
  Receipts: { readonly covered: ReadonlyArray<Covered>; readonly merge: Option.Option<{ readonly ran: Ran; readonly receipt: Receipt }> }
}>
const Gated = Data.taggedEnum<Gated>()

/** Why a land ran a Rift's focused gate, by how its newest receipt stood. */
const BY: Readonly<Record<Standing["_tag"], Covered["by"]>> = { Current: "held", Missing: "missing", Moved: "moved", Red: "red" }

/** A red check's exit, time, log and the lines of its output worth reading. */
const ranDetail = (ran: Ran): string => `exit ${ran.code} in ${ran.seconds}s; log: ${ran.log}\n${digest(ran.output)}`

/** The merge check's run, when the land ran one. */
const mergedRan = (gated: Gated): Option.Option<Ran> =>
  Gated.$match(gated, { Gate: () => Option.none(), Receipts: ({ merge }) => Option.map(merge, (done) => done.ran) })

/** A checked land's gate when the merge fast-forwarded to one Rift's checked head: its receipt stands for it. */
const COVERED_RAN: Ran = { code: 0, seconds: 0, log: "(its receipt)", output: "" }

/** How a Rift without a current receipt stood, as the refusal names it. */
const WHY: Readonly<Record<Standing["_tag"], string>> = {
  Current: "it holds a current receipt",
  Missing: "it holds no receipt",
  Moved: "its head or tracked files moved since its receipt",
  Red: "its receipt is red",
}

/** Why a land by receipts cannot cover a Rift with no focused gate to run. */
const uncoveredDetail = (now: Standing): string =>
  `${WHY[now._tag]}, and the repository names no focused gate (rift.focus) for the land to run; the full gate never runs for a Rift. Write the receipt of its round's proof at its head (${RECEIPT_CLI}), or set rift.focus.`

/** The first line of a reason, when there is one. */
const firstLine = (text: Option.Option<string>): string => Option.match(text, { onNone: () => "", onSome: (some) => some.split("\n")[0]! })

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
    const debts = yield* PostLandDebts
    const claim = yield* PostLandClaim
    const scope = yield* Scope.Scope
    // One accept check at a time: each one fills the machine.
    const accepts = yield* Semaphore.make(1)
    /** Finding a kept Rift and marking it busy, and a removal from its check to its trashing, one at a time: neither sees the other half done. */
    const claims = yield* Semaphore.make(1)
    const claimed = claims.withPermits(1)
    // Each kept Rift at work (an integration Rift, a post-land Rift), with what it is doing.
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

    /** Succeeds unless a land's step runs in the Rift at `path` (the integration Rift, the post-land Rift). */
    const idle = (path: string) =>
      Effect.filterOrFail(Effect.sync(() => busy.get(path)), Predicate.isUndefined, (step) => new StepRunning({ path, step: String(step) }))

    const remove = Effect.fn("RiftTool.remove")(function* (directory: string, source: string, input: RiftInput) {
      const workspace = yield* rifts.inspect(yield* locate(directory, source, input))
      const withChildren = input.withChildren === true
      const request = { force: input.force === true, sessionDirectory: directory }
      if (withChildren) {
        // Each Rift that goes holds no unsaved work; the children are going too, so they keep none back.
        const all = yield* subtree(workspace)
        yield* Effect.forEach(all, (each) => Effect.andThen(idle(each.path), removal({ ...each, children: [] }, request)), { discard: true })
      } else yield* Effect.andThen(idle(workspace.path), removal(workspace, request))
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

    /**
     * A batch landed by receipts: its accept check in its own Rift (ACCEPT), put at origin's newest default
     * branch, its receipt written for the verifier. The integration Rift is free meanwhile.
     */
    const acceptApart = (source: string, main: string, units: ReadonlyArray<Unit>, command: string, base: string) => {
      const checkIn = Effect.fn("RiftTool.acceptApart")(function* (path: string) {
        const started = yield* landing.start(path, main)
        yield* landing.install(path, started.previous)
        return (yield* landing.receipted(path, "accept", command, { RIFT_LAND_BASE: base })).ran
      })
      return claimed(Effect.tap(keptRift(source, ACCEPT), (path) => Effect.sync(() => busy.set(path, `the accept check of ${branchList(units)} runs there`)))).pipe(
        Effect.flatMap((path) => checkIn(path).pipe(Effect.ensuring(Effect.sync(() => busy.delete(path))))),
      )
    }

    /** The batch's accept check in the integration Rift (or `checking`, a land by receipts' own), then the wake. Runs in the background. */
    const accept = (
      sessionID: string,
      integration: string,
      units: ReadonlyArray<Unit>,
      command: string,
      base: string,
      checking: Effect.Effect<Ran, RiftFailed> = landing.check(integration, "accept", command, { RIFT_LAND_BASE: base }),
    ) =>
      accepts
        .withPermits(1)(checking)
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

    /** The wake of a post-land step that could not run. */
    const notRun = (units: ReadonlyArray<Unit>, failure: RiftFailed) => ({
      text: `rift land: the post-land step after ${branchList(units)} did not run: ${failureText(failure)}. The batch is already pushed; the next land runs it again.`,
      description: "rift land · post-land did not run",
    })

    /** The source's owed post-land step, if any. */
    const owedOf = (source: string) => Effect.map(debts.read, (kept) => Option.fromNullishOr(kept.owed.find((owed) => owed.source === source)))
    /** Changes the owed steps, as one step against every other writer on the host. */
    const changeOwed = (change: (owed: Debts["owed"]) => Debts["owed"]) => debts.update((kept) => ({ ...kept, owed: change(kept.owed) }))

    /** This instance's readings, one at a time, so its own settle window moves in order. */
    const readOne = (yield* Semaphore.make(1)).withPermits(1)
    /** The start of this instance's unbroken run of load readings under the cores; the newest reading at or past them, by any reader on the host, is kept with the owed steps. */
    let calmSince = Option.none<number>()
    /**
     * One load reading, from any reader (a land's step, the minute check), into the one settle window
     * (`observe`, owed.ts): a reading at or past the cores restarts it, and is kept so a restart and every
     * other plugin instance on the host see it too.
     */
    const reading = readOne(
      Effect.gen(function* () {
        const load = yield* landing.hostLoad
        const now = yield* Clock.currentTimeMillis
        // A reading at or past the cores is kept for every reader on the host; a calm one changes nothing kept.
        let kept = yield* debts.read
        if (overloaded(load)) kept = yield* debts.update((before) => ({ ...before, loadedAt: Option.some(now) }))
        const readings = observe({ calmSince, loadedAt: kept.loadedAt }, load, now)
        calmSince = readings.calmSince
        return { load, readings, now }
      }),
    )

    /**
     * The source's owed post-land step, if one is still owed, in its post-land Rift (POST_LAND), put at
     * origin's newest `main` first, then the wake with its report. It runs under the host's post-land claim
     * (PostLandClaim), never the integration Rift: the next land goes on while it runs, and two post-land
     * steps never overlap, from any plugin instance on the host. A land waits for the claim; the minute check
     * (`holdIfFree`) leaves it to whoever holds it. It reads the owed step once it holds the claim, so a
     * claimer that waited behind another's run finds nothing left to run, and every Git step in the
     * post-land Rift runs under it. Its phase (`phase`, owed.ts) is its RIFT_POST_LAND_LOAD: on a host loaded
     * past its cores a land runs it `loaded`, and so does the minute check every LOADED_EVERY; a loaded run
     * does what a loaded host allows and leaves it owed. Any other run pays it, unless a newer land owes one
     * meanwhile. A loaded run that exits 0 with an empty report wakes no one.
     */
    const runOwed = (source: string, trigger: Trigger) => {
      const step = Effect.gen(function* () {
        const found = yield* owedOf(source)
        if (Option.isNone(found)) return
        const owed = found.value
        const { load, readings, now } = yield* reading
        const decided = phase(owed, readings, now, trigger)
        if (decided === "wait") return
        const result = yield* Effect.result(
          Effect.gen(function* () {
            const path = yield* claimed(Effect.tap(keptRift(source, POST_LAND), (kept) => Effect.sync(() => busy.set(kept, `the post-land step of ${branchList(unitsOf(owed))} runs there`))))
            return yield* Effect.gen(function* () {
              const started = yield* landing.start(path, owed.main)
              yield* landing.install(path, started.previous)
              return yield* landing.postLand(path, owed.command, { RIFT_LAND_BASE: baseOf(owed), RIFT_LAND_HEAD: headOf(owed), RIFT_POST_LAND_LOAD: loadWord(decided) })
            }).pipe(Effect.ensuring(Effect.sync(() => busy.delete(path))))
          }),
        )
        // Paid once it ran, red or not: a failed run would fail the same at the next check. A loaded run only
        // records when it ended, from which the minute check counts to its next loaded run.
        const ended = yield* Clock.currentTimeMillis
        yield* changeOwed((all) => Option.match(Option.liftPredicate(decided, pays), { onNone: () => ran(all, source, ended), onSome: () => pay(all, source, headOf(owed)) }))
        if (result._tag === "Failure") return yield* notices.wake(owed.sessionID, notRun(unitsOf(owed), result.failure))
        const done = result.success
        const blank = Option.exists(Option.fromUndefinedOr(done.report), (report) => report.trim() === "")
        if (decided === "loaded" && done.code === 0 && blank) return
        const lines = [postLandedText(unitsOf(owed), done)]
        if (decided === "forced") lines.unshift(forcedLine(owed, load, readings, now))
        if (decided === "loaded") lines.unshift(loadedLine(owed, load, readings, now))
        const how = { run: "", forced: "", loaded: " loaded" }[decided]
        yield* notices.wake(owed.sessionID, { text: lines.join("\n"), description: `rift land · post-land ${done.code === 0 ? "ran" : "failed"}${how}` })
      })
      if (trigger === "land") return claim.hold(step)
      return Effect.asVoid(claim.holdIfFree(step))
    }

    /**
     * After a pushed batch: the batch's post-land step becomes the source's owed one (replacing an older one),
     * then runs now unless the host is loaded. Runs in the background.
     */
    const postLand = (sessionID: string, source: string, main: string, units: ReadonlyArray<Unit>, command: string, base: string, head: string) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        yield* changeOwed((all) => owe(all, { source, main, command, sessionID, land: { base, head, units, at: now } }))
        yield* runOwed(source, "land")
      }).pipe(Effect.catch((failure: RiftFailed) => notices.wake(sessionID, notRun(units, failure))))

    /**
     * One periodic check: read the load while a step is owed, and run each owed step once the readings settled,
     * or loaded once LOADED_EVERY has passed since its last run; never while another run holds the claim.
     */
    const check = Effect.gen(function* () {
      const all = (yield* debts.read).owed
      if (all.length === 0) return
      const { readings, now } = yield* reading
      const due = all.filter((owed) => phase(owed, readings, now, "settled") !== "wait")
      yield* Effect.forEach(due, (owed) => runOwed(owed.source, "settled"), { discard: true })
    }).pipe(Effect.catch((failure) => Effect.logWarning("rift: the post-land check failed", failure)))
    yield* Effect.forkIn(Effect.forever(Effect.andThen(Effect.sleep(CHECK_EVERY), check)), scope)

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
      if (baseName(path) === POST_LAND) return yield* new LandRefused({ path, reason: "is the Rift the post-land step runs in; it holds no work to land." })
      if (baseName(path) === ACCEPT) return yield* new LandRefused({ path, reason: "is the Rift a land's accept check runs in; it holds no work to land." })
      if (!workspace.git || workspace.branch === undefined) return yield* new LandRefused({ path, reason: "is not on a Git branch." })
      const own = yield* landing.ownChanges(path, source)
      if (own.length > 0) return yield* new LandRefused({ path, reason: `holds uncommitted changes; commit them first:\n${some(own)}` })
      return { path, branch: workspace.branch } satisfies Unit
    })

    /** The source's Rift named `name` on its own branch (INTEGRATION, POST_LAND), made on first use and kept. */
    const keptRift = (source: string, name: string) =>
      rifts.list(source).pipe(
        Effect.flatMap((paths) => {
          const found = paths.find((path) => baseName(path) === name)
          return found === undefined ? rifts.create({ source, from: source, name, branch: name }) : Effect.succeed(found)
        }),
      )

    /**
     * One Rift's cover in a land by receipts, before any merge: its current round receipt, else its focused
     * gate (`rift.focus`) run in the Rift now, its receipt kept there. Red, or no focused gate to run (the
     * full gate never runs for it), fails.
     */
    const coverOne = Effect.fn("RiftTool.coverOne")(function* (unit: Unit, config: LandConfig, threads: number) {
      const now = yield* landing.standing(unit.path)
      if (now._tag === "Current") return { branch: unit.branch, path: unit.path, receipt: now.receipt, by: "held" } satisfies Covered
      const focus = config.focus
      if (Option.isNone(focus)) return yield* new LandStopped({ path: unit.path, step: "focus", detail: uncoveredDetail(now) })
      const done = yield* landing.receipted(unit.path, "round", focusLine(focus.value, yield* landing.changed(unit.path, config.main), threads), {})
      if (done.ran.code !== 0) return yield* new LandStopped({ path: unit.path, step: "focus", detail: ranDetail(done.ran) })
      return { branch: unit.branch, path: unit.path, receipt: done.receipt, by: BY[now._tag] } satisfies Covered
    })

    /** Each Rift's cover in a land by receipts, in order, one at a time: the receipt it lands on, or why it has none. */
    const cover = (units: ReadonlyArray<Unit>, config: LandConfig) =>
      Effect.flatMap(landing.hostLoad, (load) =>
        Effect.forEach(units, (unit) =>
          coverOne(unit, config, shareOf(load.cores)).pipe(
            Effect.catchTag("RiftFailed", (failure) => Effect.fail(new LandStopped({ path: unit.path, step: "focus", detail: failure.message }))),
            Effect.result,
          ),
        ),
      )

    /** The full gate's run on the batch, as the land by `rift.gate` takes it: none merged or red stops the land. */
    const fullGate = Effect.fn("RiftTool.fullGate")(function* (integration: string, ran: Option.Option<Ran>) {
      if (Option.isNone(ran)) return yield* new LandStopped({ path: integration, step: "gate", detail: "no Rift merged" })
      const gate = ran.value
      if (gate.code !== 0) return yield* new LandStopped({ path: integration, step: "gate", detail: ranDetail(gate) })
      return Gated.Gate({ ran: gate })
    })

    /**
     * A land by receipts' one check of its own: the merged tree's `rift.mergeCheck`, unless the land
     * fast-forwarded to one Rift's own checked head, whose receipt covers the tree that lands.
     */
    const mergeGate = Effect.fn("RiftTool.mergeGate")(function* (integration: string, covered: ReadonlyArray<Covered>, command: string, base: string) {
      const head = yield* landing.headOf(integration)
      if (covered.length === 1 && covered.every((each) => each.receipt.head === head)) return Gated.Receipts({ covered, merge: Option.none() })
      const done = yield* landing.receipted(integration, "merge", command, { RIFT_LAND_BASE: base })
      return Gated.Receipts({ covered, merge: Option.some(done) })
    })

    /** A pushed land's merge check: red stops the push. */
    const pushedMergeGate = (integration: string, covered: ReadonlyArray<Covered>, command: string, base: string) =>
      mergeGate(integration, covered, command, base).pipe(
        Effect.catchTag("RiftFailed", (failure) => Effect.fail(new LandStopped({ path: integration, step: "merge-check", detail: failure.message }))),
        Effect.filterOrFail(
          (gated) => !Option.exists(mergedRan(gated), (ran) => ran.code !== 0),
          (gated) => new LandStopped({ path: integration, step: "merge-check", detail: Option.match(mergedRan(gated), { onNone: () => "", onSome: ranDetail }) }),
        ),
      )

    /** The land's record (what it took and ran) under the pushed head, for the next batch's verifier; a failed write is named, never fatal. */
    const recordOf = Effect.fn("RiftTool.recordOf")(
      function* (integration: string, base: string, gated: Gated) {
        if (gated._tag === "Gate") return ""
        const head = yield* landing.headOf(integration)
        const at = DateTime.formatIso(yield* DateTime.now)
        return yield* landing.record({ head, base, units: gated.covered, merge: Option.map(gated.merge, (done) => done.receipt), at })
      },
      (effect) => Effect.catch(effect, (failure: RiftFailed) => Effect.succeed(`not written (${failureText(failure)})`)),
    )

    /**
     * After the push, in the background and in order: the accept check, then the post-land step. By `rift.gate`
     * the accept check holds the integration Rift (busy until it ends); by receipts it runs in a Rift of its own.
     * Answers whether it holds the integration Rift.
     */
    const afterPush = Effect.fn("RiftTool.afterPush")(function* (
      sessionID: string,
      source: string,
      integration: string,
      units: ReadonlyArray<Unit>,
      config: LandConfig,
      base: string,
      head: string,
      gated: Gated,
    ) {
      const after = Option.match(Option.fromUndefinedOr(config.postLand), {
        onNone: () => Effect.void,
        onSome: (step) => postLand(sessionID, source, config.main, units, step, base, head),
      })
      const holding = (accepted: string) =>
        Effect.sync(() => busy.set(integration, `the accept check of ${branchList(units)} runs there`)).pipe(
          Effect.andThen(Effect.forkIn(Effect.andThen(accept(sessionID, integration, units, accepted, base).pipe(Effect.ensuring(Effect.sync(() => busy.delete(integration)))), after), scope)),
          Effect.as(true),
        )
      const apart = (accepted: string) =>
        Effect.forkIn(Effect.andThen(accept(sessionID, integration, units, accepted, base, acceptApart(source, config.main, units, accepted, base)), after), scope).pipe(Effect.as(false))
      return yield* Option.match(Option.fromUndefinedOr(config.accept), {
        onNone: () => Effect.as(Effect.forkIn(after, scope), false),
        onSome: (accepted) => Gated.$match(gated, { Gate: () => holding(accepted), Receipts: () => apart(accepted) }),
      })
    })

    const land = Effect.fn("RiftTool.land")(function* (sessionID: string, directory: string, source: string, input: RiftInput) {
      // A `{ path, unit }` entry is its path here: the unit is the orchestrate plugin's.
      const targets = (input.rifts ?? []).map((target) => (typeof target === "string" ? target : target.path))
      if (targets.length === 0) return yield* new RiftsMissing()
      // Every Rift is found and checked before any is touched.
      const paths = yield* Effect.forEach(targets, (target) => findRift(directory, source, target).pipe(Effect.provideService(Rifts, rifts)))
      const units = yield* Effect.forEach(paths, (path) => unitOf(path, source))
      const config = yield* landing.config(source)
      const gateCommand = config.gate
      if (gateCommand === undefined) return yield* new GateMissing({ source })
      // A land by receipts (`rift.mergeCheck`): the Rifts' receipts and one merge check, never the full gate.
      const byReceipts = config.mergeCheck

      // One batch at a time in an integration Rift, its accept check included.
      const integration = yield* claimed(
        Effect.gen(function* () {
          const path = yield* keptRift(source, INTEGRATION).pipe(Effect.mapError((failure) => new LandStopped({ path: source, step: "start", detail: failure.message })))
          if (busy.has(path)) return yield* new LandRefused({ path, reason: `is busy: ${busy.get(path)}. Land again after its wake.` })
          busy.set(path, "a batch is landing")
          return path
        }),
      )
      let accepting = false
      return yield* Effect.gen(function* () {
        const stopped = (step: LandStopped["step"], detail: string, path = integration) => new LandStopped({ path, step, detail })
        const coverage = yield* Option.match(byReceipts, { onNone: () => Effect.succeed([]), onSome: () => cover(units, config) })
        // A pushed land stops at a Rift it cannot cover; a checked one reds that Rift alone and merges it not.
        const failed = coverage.flatMap((each) => Result.match(each, { onSuccess: () => [], onFailure: (failure) => [failure] }))
        if (config.push && Arr.isReadonlyArrayNonEmpty(failed)) return yield* failed[0]
        const uncovered = new Map(failed.map((failure) => [failure.path, failure.detail]))
        const covered = coverage.flatMap((each) => Result.match(each, { onSuccess: (one) => [one], onFailure: () => [] }))
        const started = yield* landing.start(integration, config.main).pipe(Effect.mapError((failure) => stopped("start", failure.message)))
        const locks: Array<string> = []
        // A batch that is not pushed checks the Rifts that merge; a conflict reds only its own Rift.
        const conflicts = new Map<string, ReadonlyArray<string>>()
        for (const unit of units.filter((each) => !uncovered.has(each.path))) {
          const merged = yield* landing.merge(integration, unit, config).pipe(Effect.mapError((failure) => stopped("merge", failure.message, unit.path)))
          if (merged._tag === "Conflict") {
            if (config.push) return yield* stopped("conflict", some(merged.files, 50), unit.path)
            conflicts.set(unit.path, merged.files)
            continue
          }
          locks.push(...merged.regenerated)
        }
        const merged = units.filter((unit) => !conflicts.has(unit.path) && !uncovered.has(unit.path))
        locks.push(...(yield* landing.install(integration, started.previous).pipe(Effect.mapError((failure) => stopped("install", failure.message)))))
        // A clean merge can still leave a generated file stale (its sources changed in another Rift): write them again every batch.
        if (config.regenerate !== undefined && merged.length > 0)
          locks.push(...(yield* landing.regenerate(integration, config).pipe(Effect.mapError((failure) => stopped("regenerate", failure.message)))))
        const gate = merged.length === 0 || Option.isSome(byReceipts) ? undefined : yield* landing.check(integration, "gate", gateCommand, {})

        if (!config.push) {
          const conflicted = (unit: Unit): Outcome => ({ unit, verdict: "red", note: `conflicts with the batch: ${conflicts.get(unit.path)!.join(", ")}` })
          const unreceipted = (unit: Unit): Outcome => ({ unit, verdict: "red", note: `no current receipt: ${firstLine(Option.fromUndefinedOr(uncovered.get(unit.path)))}` })
          const answer = (outcomes: ReadonlyArray<Outcome>, ran = gate, extra: ReadonlyArray<string> = []) => ({
            text: [
              checkedText({
                units,
                main: config.main,
                base: started.base,
                integration,
                gate: ran,
                locks: [...new Set(locks)],
                outcomes: inOrder(units, [...outcomes, ...units.filter((unit) => conflicts.has(unit.path)).map(conflicted), ...units.filter((unit) => uncovered.has(unit.path)).map(unreceipted)]),
                accepting,
                pushBranches: config.pushBranches,
              }),
              ...extra,
            ].join("\n"),
            metadata: { action: "land" as const, source, path: integration, rifts: paths },
          })
          if (Option.isSome(byReceipts) && Arr.isReadonlyArrayNonEmpty(merged)) {
            // By receipts: the merge check is the batch's gate; the accept check runs apart, a receipt for the next verifier that holds no Rift.
            const command = byReceipts.value
            const by = yield* mergeGate(integration, covered, command, started.base).pipe(Effect.mapError((failure) => stopped("merge-check", failure.message)))
            const ran = Option.getOrElse(mergedRan(by), () => COVERED_RAN)
            const lines = receiptLines(covered, mergedRan(by), yield* recordOf(integration, started.base, by))
            if (ran.code !== 0) return answer(merged.map((unit) => ({ unit, verdict: "red" as const, note: "the merge check failed" })), ran, lines)
            const apart = Option.map(Option.fromUndefinedOr(config.accept), (accepted) =>
              accept(sessionID, integration, merged, accepted, started.base, acceptApart(source, config.main, merged, accepted, started.base)),
            )
            yield* Effect.forkIn(Option.getOrElse(apart, () => Effect.void), scope)
            return answer(yield* greens(merged, config.pushBranches), ran, [...lines, ...Option.toArray(Option.map(apart, () => ACCEPT_APART))])
          }
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

        const gated = yield* Option.match(byReceipts, {
          onNone: () => fullGate(integration, Option.fromUndefinedOr(gate)),
          onSome: (command) => pushedMergeGate(integration, covered, command, started.base),
        })
        const pushed = yield* landing.push(integration, config.main).pipe(Effect.mapError((failure) => stopped("push", failure.message)))
        const record = yield* recordOf(integration, started.base, gated)

        const kept: Array<{ path: string; why: string }> = []
        for (const unit of units) {
          const why = yield* removeLanded(unit.path, source, directory)
          if (why !== undefined) kept.push({ path: unit.path, why })
        }
        const landed = { units, main: config.main, base: started.base, pushed, locks: [...new Set(locks)], kept }
        accepting = yield* afterPush(sessionID, source, integration, units, config, started.base, pushed.split(" ")[0] ?? "", gated)
        const acceptsAfter = Predicate.isNotUndefined(config.accept)
        const postLands = Predicate.isNotUndefined(config.postLand)
        return {
          text: Gated.$match(gated, {
            Gate: ({ ran }) => landedText({ ...landed, gate: ran } satisfies Landed, integration, acceptsAfter, postLands),
            Receipts: (by) => receiptLandedText({ ...landed, covered: by.covered, merge: Option.map(by.merge, (done) => done.ran), record }, acceptsAfter, postLands),
          }),
          metadata: { action: "land" as const, source, path: integration, rifts: paths },
        }
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
          return yield* claimed(remove(directory, yield* source(), input))
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
    case "StepRunning":
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
