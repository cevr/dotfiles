import { Array as Arr, Clock, Context, Duration, Effect, Layer, Option, Ref, Schedule } from "effect"
import { describeGate, Gate, gate } from "./gate.ts"
import { describeHealth, digestSaid, final, Health, healthOf, provenNotice, recover, Recovery, type Stage } from "./health.ts"
import { type Build, buildOf, goodOf, promoted, proven, type Record, rolledBack } from "./record.ts"
import { Builder, Builds, Configs, Handoff, HandoffMark, Heartbeat, Log, Notice, Records, Rejections, Service, Source, stageInTree, Trees, UpdateFailed } from "./service.ts"
import { shortTarget, type Target } from "./target.ts"
import { ask, ended, HANDOFF_LIMIT, IDLE, Plan, plan, runningOf, superseded } from "./update.ts"

/** How often a restart the Sabbath rest holds looks at the clock again. */
export const GATE_POLL = Duration.seconds(30)

/**
 * How long the handoff reads a restarted service before it believes a plugin is missing. A loaded
 * host (load 20 to 30 on the workbox) boots a location's plugins in half a minute or more, and each
 * read waits for them; four minutes keeps three restarts' reads inside `HANDOFF_LIMIT`.
 */
export const HEALTH_DEADLINE = Duration.minutes(4)

/** How often it reads it meanwhile. */
export const HEALTH_POLL = Duration.seconds(2)

/** How the in-server update runs. */
export interface Policy {
  /** How often a run looks for a newer target while a built one waits out the Sabbath rest. */
  readonly fetchEvery: Duration.Duration
}

/** The host's update, as the plugin runs it. */
export class Updater extends Context.Service<
  Updater,
  {
    /**
     * Looks for the verified target and installs it: build it ahead with its own plugin tree, wait for
     * the gate, hand the restart off. A request while a run goes asks for one more run after it.
     */
    readonly check: (reason: string) => Effect.Effect<void>
  }
>()("dotfiles-opencode/update/Updater") {}

/**
 * The interval checks: one `GATE_POLL` after the start, then every `every` after each ends. A
 * check never fails (`Updater.check`), so the repeat never ends.
 */
export const intervalChecks = (check: (reason: string) => Effect.Effect<void>, every: Duration.Duration) =>
  check("interval").pipe(Effect.delay(GATE_POLL), Effect.repeat(Schedule.spaced(every)))

/** How a waiting run ended: the gate opened, or a newer target came first. */
type Waited = "open" | "superseded"

/** The updater's handlers over the contracts. */
export const updaterLayer = (policy: Policy) =>
  Layer.effect(
    Updater,
    Effect.gen(function* () {
      const source = yield* Source
      const builder = yield* Builder
      const handoff = yield* Handoff
      const records = yield* Records
      const trees = yield* Trees
      const mark = yield* HandoffMark
      const rejections = yield* Rejections
      const log = yield* Log
      const heartbeat = yield* Heartbeat
      const runs = yield* Ref.make(IDLE)
      /**
       * The target this copy handed the restart off for, and when. A handoff that ends without a
       * restart (a refusal, a failed record write) leaves this service running: past `HANDOFF_LIMIT`
       * the hand-off no longer holds the checks, so the next one plans again.
       */
      const handedOff = yield* Ref.make(Option.none<{ readonly target: Target; readonly at: number }>())

      const reject = (target: Target, step: string, cause: string) =>
        rejections
          .write({ dotfiles: target.dotfiles, fork: target.fork, step, cause })
          .pipe(Effect.andThen(log.line(`update: ${shortTarget(target)} failed at ${step}; it is not tried again until another target comes`)))

      const waitForGate = Effect.fn("Updater.waitForGate")(function* (target: Target) {
        const since = yield* Clock.currentTimeMillis
        const said = yield* Ref.make("")
        const fetched = yield* Ref.make(since)
        for (;;) {
          const now = yield* Clock.currentTimeMillis
          const held = gate(now)
          if (Gate.$is("Open")(held)) {
            if (now > since) yield* log.line(`restart: the Sabbath rest ended after ${Duration.format(Duration.millis(now - since))} of waiting`)
            return "open" satisfies Waited
          }
          const line = describeGate(held)
          if ((yield* Ref.getAndSet(said, line)) !== line) yield* log.line(`restart held: ${line}`)
          yield* Effect.sleep(GATE_POLL)
          if (now - (yield* Ref.get(fetched)) < Duration.toMillis(policy.fetchEvery)) continue
          yield* Ref.set(fetched, now)
          const latest = yield* source.verified.pipe(Effect.orElseSucceed(() => Option.none<Target>()))
          if (superseded(target, latest)) {
            yield* log.line(`restart: a newer target supersedes ${shortTarget(target)}; building it ahead`)
            return "superseded" satisfies Waited
          }
        }
      })

      const restart = Effect.fn("Updater.restart")(function* (target: Target) {
        yield* log.line(`update: ${shortTarget(target)} is built; restarting onto it`)
        const waited = yield* waitForGate(target)
        if (waited === "superseded") return true
        yield* handoff.start(shortTarget(target))
        yield* Ref.set(handedOff, Option.some({ target, at: yield* Clock.currentTimeMillis }))
        yield* log.line("update: the restart is handed off")
        return false
      })

      /**
       * Builds the target with its own plugin tree: the dotfiles commit fetched into the live
       * checkout's object store (which never moves), the tree made from it beside where the binary
       * goes (`trees.ts`), then daily's stage run from that tree. A tree build's version ends in
       * `.tree` (`pin.ts` `versionOf`), so its tree never lands beside a binary that runs, even when
       * the target is the running build's own commits. Nothing a running process loads changes, so the
       * build is never a reload. A tree that does not make or a build that fails is rejected, the failed
       * build's tree deleted; a fetch that fails is not (the next check tries).
       */
      const installTree = Effect.fn("Updater.installTree")(function* (target: Target) {
        yield* log.line(`update: ${shortTarget(target)}; building it ahead with its own plugin tree; nothing running loads from it`)
        yield* source.fetch(target.dotfiles)
        const version = yield* builder.version(target)
        // A failed stage takes its tree with it when its make made it; a tree that stood (a recorded build's) stays whole.
        yield* stageInTree(trees, version, target.dotfiles, (tree) => builder.stage(target, tree)).pipe(Effect.tapError((failed) => reject(target, "build", failed.message)))
        return yield* restart(target)
      })

      const once = Effect.fn("Updater.once")(function* (reason: string) {
        const now = yield* Clock.currentTimeMillis
        const waiting = Option.filter(yield* Ref.get(handedOff), (each) => now - each.at < Duration.toMillis(HANDOFF_LIMIT))
        if (Option.isSome(waiting)) return yield* log.line(`check (${reason}): the restart onto ${shortTarget(waiting.value.target)} is handed off`).pipe(Effect.as(false))
        const held = yield* mark.read
        const alive = yield* Option.match(held, { onNone: () => Effect.succeed(false), onSome: (each) => mark.alive(each.pid) })
        const running = runningOf(held, alive, now)
        const target = yield* source.verified
        const record = yield* records.read
        const treed = yield* Effect.forEach(Option.toArray(record), (each) => trees.has(each.version)).pipe(Effect.map((has) => has.includes(true)))
        const next = plan(target, record, yield* rejections.read, running, treed)
        return yield* Plan.$match(next, {
          HandingOff: ({ running: handing }) =>
            log.line(`check (${reason}): a handoff runs (pid ${handing.pid}); nothing builds or restarts until it ends`).pipe(Effect.as(false)),
          NoTarget: () => log.line(`check (${reason}): the origin names no verified target`).pipe(Effect.as(false)),
          Current: ({ target: current }) => log.line(`check (${reason}): installed is ${shortTarget(current)}`).pipe(Effect.as(false)),
          Rejected: ({ target: failed, rejected }) =>
            log.line(`check (${reason}): ${shortTarget(failed)} failed at ${rejected.step} (${rejected.cause}); waiting for another target`).pipe(Effect.as(false)),
          Restart: ({ target: built }) => log.line(`check (${reason}): ${shortTarget(built)} is built and not yet proven`).pipe(Effect.andThen(restart(built))),
          Update: ({ target: update }) => installTree(update),
        })
      })

      // A run that fails, or dies, is logged and ends like any other: the run state goes back to
      // idle and the next check runs, so neither the interval's repeat nor a later request stops.
      const loop: (reason: string) => Effect.Effect<void> = Effect.fn("Updater.loop")(function* (reason: string) {
        const rerun = yield* once(reason).pipe(
          Effect.catchTag("UpdateFailed", (failed: UpdateFailed) => log.line(`update failed at ${failed.step}: ${failed.message}`).pipe(Effect.as(false))),
          Effect.catchDefect((defect) => log.line(`check (${reason}) died: ${String(defect).split("\n")[0]}`).pipe(Effect.as(false))),
        )
        const [again] = yield* Ref.modify(runs, (state) => {
          const [next, runsNext] = ended(state)
          return [[next || rerun] as const, runsNext]
        })
        if (again) yield* loop("again")
      })

      const check = Effect.fn("Updater.check")(function* (reason: string) {
        yield* heartbeat.beat
        const start = yield* Ref.modify(runs, (state) => {
          const [go, next] = ask(state)
          return [go, next]
        })
        if (!start) return yield* log.line(`check (${reason}): a run is going; one more follows it`)
        yield* loop(reason)
      })

      return Updater.of({ check })
    }),
  )

/** How a handoff ended. */
export type Outcome = "proven" | "rolled-back" | "gave-up"

/** The handoff process's exit code for each outcome: only a proven build exits 0. */
export const EXIT_CODES = { proven: 0, "rolled-back": 2, "gave-up": 1 } satisfies { readonly [outcome in Outcome]: number }

/** Megabytes, to one decimal, for the log. */
const megabytes = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)} MB`

/**
 * The old builds deleted once a build is proven (`Builds`), each logged with its size: the handoff's
 * last step, never before the health check passed, and never on a rollback or a give-up. The record
 * is read inside the prune, under the builds lock. A prune that cannot take the lock or read what
 * runs deletes nothing, and says so; it never changes the handoff's outcome.
 */
const pruneBuilds = Effect.gen(function* () {
  const builds = yield* Builds
  const records = yield* Records
  const log = yield* Log
  yield* builds.prune(records.read).pipe(
    Effect.tap((pruned) => Effect.forEach(pruned, (each) => log.line(`prune: deleted the old build ${each.name} (${megabytes(each.bytes)})`), { discard: true })),
    Effect.tap((pruned) => log.line(`prune: ${pruned.length} old builds deleted, ${megabytes(pruned.reduce((sum, each) => sum + each.bytes, 0))} freed`)),
    Effect.catch((failed) => log.line(`prune: every build kept: ${failed.step}: ${failed.message}`)),
  )
})

/**
 * The host's commands (`Source.commands`), after a proven handoff: its links into a plugin tree go
 * through `current.plugins`, which the record write pointed at the proven build. A failure is logged;
 * it never changes the outcome.
 */
const hostCommands = Effect.gen(function* () {
  const source = yield* Source
  const log = yield* Log
  yield* source.commands.pipe(Effect.catch((failed) => log.line(`handoff: the host's commands were not installed: ${failed.step}: ${failed.message}`)))
})

/** A step that failed on the restart path, as the health it leaves: sick, for good. */
const failedStep = (step: string) => (failed: UpdateFailed) => Health.Sick({ plugin: step, cause: failed.message, final: true })

/** What a refusal's notice and log line add: the update changed nothing. */
const UNCHANGED = "nothing changed and the service was not restarted"

/**
 * The handoff, for a staged build with its plugin tree beside it: read the logins and what refuses the
 * build, install the staged build in the record (which points the launcher at it), restart the service,
 * read its health, and recover. No step moves the live checkout, writes a config or reloads a running
 * process's plugins: each process binds the tree beside its own executable. A sick restart rolls back to
 * the last good build, a record write (`rollBackTree`), and restarts onto it.
 *
 * Read before any write, each a refusal that ends the handoff given up, its target rejected, with nothing
 * changed: a staged build with no tree beside it (R1, step `tree`), and a server config that lists an
 * entry of ours or does not read (R2, step `config`: such a host would start the build with our plugins
 * twice). A good build with no tree is no rollback (R3): it would start with no plugins.
 *
 * A step that fails (the restart, the rollback) is a sick reading, so it goes down the same ladder: the
 * handoff ends healthy, rolled back, or given up with the owner's notice, and never fails. A build that
 * does not end proven is rejected, so no check builds or restarts onto it again.
 */
const steps: (reason: string) => Effect.Effect<Outcome, never, Builds | Service | Source | Records | Rejections | Configs | Trees | Notice | Log> = Effect.fn("Update.handoffSteps")(function* (reason: string) {
  const service = yield* Service
  const records = yield* Records
  const trees = yield* Trees
  const rejections = yield* Rejections
  const configs = yield* Configs
  const notice = yield* Notice
  const log = yield* Log

  const healthNow = Effect.fn("Update.health")(function* (before: ReadonlyArray<string>) {
    const start = yield* Clock.currentTimeMillis
    for (;;) {
      const health = yield* service.read.pipe(
        Effect.map((reading) => healthOf(reading, before)),
        Effect.catchTag("UpdateFailed", (failed: UpdateFailed) => Effect.succeed(Health.Sick({ plugin: "service", cause: failed.message, final: false }))),
      )
      if (final(health) || (yield* Clock.currentTimeMillis) - start >= Duration.toMillis(HEALTH_DEADLINE)) return health
      yield* Effect.sleep(HEALTH_POLL)
    }
  })

  const restartAndRead = Effect.fn("Update.restartAndRead")(function* (stage: Stage, before: ReadonlyArray<string>) {
    yield* log.line(`handoff (${stage}): restarting the service`)
    const restarted = yield* service.restart.pipe(Effect.as(Option.none<Health>()), Effect.catch((failed) => Effect.succeed(Option.some(failedStep("service restart")(failed)))))
    const health = yield* Option.match(restarted, { onNone: () => healthNow(before), onSome: Effect.succeed })
    yield* log.line(`handoff (${stage}): ${describeHealth(health)}`)
    yield* log.line(`handoff (${stage}): ${digestSaid(yield* service.digest)}`)
    return health
  })

  /**
   * The providers the running service has a login for, read before the restart. Logins that do not
   * read count as none: a login missing after the restart is then reported, never rolled back.
   */
  const loginsBefore = service.logins.pipe(
    Effect.tap((logins) => log.line(`handoff: logins before the restart: ${Arr.match(logins, { onEmpty: () => "none", onNonEmpty: (each) => each.join(", ") })}`)),
    Effect.catchTag("UpdateFailed", (failed: UpdateFailed) =>
      log.line(`handoff: the logins before the restart do not read (${failed.message}); a missing login is reported, not rolled back`).pipe(Effect.as<ReadonlyArray<string>>([])),
    ),
  )

  /**
   * Why a rollback cannot go back, as the give-up's line says it: none when it can (a good build other
   * than the record's, with its tree beside it); empty with no good build to go back to; R3 for a good
   * build with no tree, which would start with no plugins.
   */
  const noRollBack = Effect.gen(function* () {
    const record = yield* records.read
    const good = Option.filter(Option.flatMap(record, goodOf), () => Option.isSome(Option.flatMap(record, rolledBack)))
    if (Option.isNone(good)) return Option.some<ReadonlyArray<string>>([])
    if (yield* trees.has(good.value.version)) return Option.none<ReadonlyArray<string>>()
    return Option.some<ReadonlyArray<string>>([`the good build ${good.value.version} has no plugin tree; not rolled back`])
  })

  const reject = (build: Option.Option<Build>, failure: Health, step: string) =>
    Effect.forEach(Option.toArray(build), (each) => rejections.write({ dotfiles: each.dotfiles, fork: each.fork, step, cause: describeHealth(failure) }), { discard: true })

  const end = Effect.fn("Update.end")(function* (outcome: Exclude<Outcome, "proven">, tried: Option.Option<Build>, failure: Health, said: string, step = "health") {
    yield* notice.show(said)
    yield* reject(tried, failure, step)
    yield* log.line(`handoff: ${outcome}; ${said}`)
    return outcome
  })

  /** A refusal read before any write: given up at `step`, the target rejected, nothing changed. */
  const refuse = (tried: Option.Option<Build>, step: string, cause: string) => {
    const failure = Health.Sick({ plugin: step, cause, final: true })
    return end("gave-up", tried, failure, `${describeHealth(failure)}; ${UNCHANGED}`, step)
  }

  /** The installed record names the staged build: the step before the restart; answers the failure's health, if it failed. */
  const install = (before: Option.Option<Record>) =>
    Effect.forEach(Option.toArray(before), (record) => records.write(promoted(record)), { discard: true }).pipe(
      Effect.as(Option.none<Health>()),
      Effect.catch((failed) => Effect.succeed(Option.some(failedStep("installed record")(failed)))),
    )

  /** Goes back to the good build: a record write. The good build's binary and tree are kept by the prune, and nothing else changed. */
  const rollBackTree = Effect.fn("Update.rollBackTree")(function* () {
    const record = yield* records.read
    const back = Option.flatMap(record, rolledBack)
    const good = Option.flatMap(record, goodOf)
    if (Option.isNone(back) || Option.isNone(good)) return Option.some(Health.Sick({ plugin: "rollback", cause: "no good build to roll back to", final: true }))
    yield* log.line(`handoff: rolling back to ${good.value.version}`)
    return yield* records.write(back.value).pipe(
      Effect.as(Option.none<Health>()),
      Effect.catch((failed) => Effect.succeed(Option.some(failedStep(`rollback at ${failed.step}`)(failed)))),
    )
  })

  /**
   * R2: the server config lists an entry of ours (the old writer's), or does not read. Answers the
   * refusal's cause; none when the config lists none of ours.
   */
  const listedOurs = configs.ours.pipe(
    Effect.map(
      Option.map(
        (listed) =>
          `the server config ${listed.file} lists our plugin entries: remove the entries under ${listed.under} from "plugins" in ${listed.file}, or install commit 51fc7c9f first, which strips them`,
      ),
    ),
    Effect.catch((failed) => Effect.succeed(Option.some(`the server config does not read: ${failed.message}`))),
  )

  /** The recovery after the first restart, down the ladder (`recover`), to an outcome: proven (recorded good, then the prune and the host's commands), rolled back, or given up. */
  const ladder = Effect.fn("Update.ladder")(function* (tried: Option.Option<Build>, hadLogins: ReadonlyArray<string>) {
    let stage: Stage = "first"
    let health = yield* restartAndRead(stage, hadLogins)
    let failure = health
    for (;;) {
      if (Health.$is("Sick")(health)) failure = health
      const blocked = yield* noRollBack
      const recovery = recover(stage, health, Option.isNone(blocked))
      if (Recovery.$is("Proven")(recovery)) {
        const record = yield* records.read
        yield* Effect.forEach(Option.toArray(record), (current) => records.write(proven(current)), { discard: true }).pipe(
          Effect.catch((failed) => log.line(`handoff: recording the good build failed: ${failed.message}`)),
        )
        yield* Option.match(provenNotice(health), { onNone: () => notice.clear, onSome: notice.show })
        yield* log.line("handoff: the build is proven and recorded as the good build")
        // The handoff's last steps. The prune reads the record and lists the share directory under the
        // builds lock daily's stage holds from its copy to its record write (`Builds`), not under this
        // mark, which daily never reads.
        yield* pruneBuilds
        yield* hostCommands
        return "proven" satisfies Outcome
      }
      if (Recovery.$is("RolledBack")(recovery)) return yield* end("rolled-back", tried, failure, `${describeHealth(failure)}; rolled back`)
      if (Recovery.$is("GaveUp")(recovery)) return yield* end("gave-up", tried, failure, [describeHealth(failure), ...Option.getOrElse(blocked, () => [])].join("; "))
      const backed = yield* rollBackTree()
      if (Option.isSome(backed)) return yield* end("gave-up", tried, failure, `${describeHealth(failure)}; ${describeHealth(backed.value)}`)
      stage = "rolled-back"
      health = yield* restartAndRead(stage, hadLogins)
    }
  })

  yield* log.line(`handoff: ${reason}`)
  const before = yield* records.read
  const tried = Option.flatMap(Option.map(before, promoted), buildOf)
  // Read from the running service before anything changes under it.
  const hadLogins = yield* loginsBefore
  // R1: only a build with its tree beside it installs.
  const treed = yield* Effect.forEach(Option.toArray(tried), (build) => trees.has(build.version)).pipe(Effect.map((has) => has.includes(true)))
  if (!treed) {
    const name = Option.match(tried, { onNone: () => "the record's next build", onSome: (build) => build.version })
    return yield* refuse(tried, "tree", `${name} has no plugin tree beside it; this update installs only tree builds`)
  }
  // R2: a server config with our entries would start the build with our plugins twice, the tree's and the config's.
  const listed = yield* listedOurs
  if (Option.isSome(listed)) return yield* refuse(tried, "config", listed.value)
  const failedInstall = yield* install(before)
  if (Option.isSome(failedInstall)) return yield* end("gave-up", tried, failedInstall.value, `${describeHealth(failedInstall.value)}; the service was not restarted`)
  return yield* ladder(tried, hadLogins)
})

/**
 * The handoff under its mark (`HandoffMark`): held before it names the staged build installed and
 * dropped once its outcome, good or rejected, is recorded. The restarted service's own check reads
 * the mark and waits, so one handoff runs at a time.
 */
export const handoff = (reason: string): Effect.Effect<Outcome, never, Builds | HandoffMark | Service | Source | Records | Rejections | Configs | Trees | Notice | Log> =>
  HandoffMark.use((mark) => mark.hold.pipe(Effect.andThen(steps(reason)), Effect.ensuring(mark.release)))
