import { Array as Arr, Clock, Context, Duration, Effect, Layer, Match, Option, Ref, Result, Schedule } from "effect"
import { describeGate, Gate, gate } from "./gate.ts"
import { describeHealth, final, Health, healthOf, provenNotice, recover, Recovery, type Stage } from "./health.ts"
import { type Build, buildOf, goodOf, promoted, proven, type Record, rolledBack } from "./record.ts"
import { Builder, Builds, type CheckoutStuck, Configs, Handoff, HandoffMark, Heartbeat, Log, Notice, Records, Rejections, Service, Source, Trees, UpdateFailed } from "./service.ts"
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
     * Looks for the verified target and installs it: build it ahead with its own plugin tree (or, on
     * the old scheme, from the unmoved checkout), wait for the gate, hand the restart off. A request
     * while a run goes asks for one more run after it.
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
       * restart (a checkout git refused to move, a failed configure) leaves this service running:
       * past `HANDOFF_LIMIT` the hand-off no longer holds the checks, so the next one plans again.
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
       * Builds the target from the checkout as it stands: the checkout and the configs move only in
       * the handoff, right before the restart (`steps`), since the running service and every open
       * TUI reload a plugin whose files change. A failed build has moved nothing.
       */
      const install = Effect.fn("Updater.install")(function* (target: Target) {
        const at = yield* source.head
        yield* log.line(`update: ${shortTarget(target)}; building it ahead, the dotfiles stay at ${at.slice(0, 10)} until the restart`)
        yield* builder.stage(target, Option.none()).pipe(Effect.tapError((failed) => reject(target, "build", failed.message)))
        return yield* restart(target)
      })

      /**
       * Builds the target with its own plugin tree: the dotfiles commit fetched into the live
       * checkout's object store (which never moves), the tree made from it beside where the binary
       * goes (`trees.ts`), then daily's stage run from that tree. A tree build's version ends in
       * `.tree` (`pin.ts` `versionOf`), so its tree never lands beside a binary that runs: not even on
       * a host's first tree install, whose target is the running build's own commits. Nothing a running
       * process loads changes, so the build is never a reload. A target whose fork binds no tree, a
       * tree that does not make or a build that fails is rejected, the failed build's tree deleted; a
       * fetch that fails is not (the next check tries).
       */
      const installTree = Effect.fn("Updater.installTree")(function* (target: Target) {
        yield* log.line(`update: ${shortTarget(target)}; building it ahead with its own plugin tree; nothing running loads from it`)
        yield* source.fetch(target.dotfiles)
        const version = yield* builder.version(target)
        yield* Effect.gen(function* () {
          if (!(yield* builder.binds(target.fork)))
            return yield* new UpdateFailed({ step: "build", message: `the target's fork ${target.fork.slice(0, 10)} binds no tree (it lacks packages/cli/src/adjacent-config.ts): no tree build` })
          const tree = yield* trees.make(version, target.dotfiles)
          // A failed stage takes its tree with it: nothing will run that build, and nothing is left for a start to bind.
          yield* builder.stage(target, Option.some(tree)).pipe(Effect.tapError(() => trees.remove(version)))
        }).pipe(Effect.tapError((failed) => reject(target, "build", failed.message)))
        return yield* restart(target)
      })

      /**
       * Whether this host's builds take a tree: yes unless the record's good build's fork binds none
       * (a host whose good build predates the fork's adjacent binding). Then the old scheme stays (the
       * install says so in the log): a rollback from a tree build must land on a fork that drops an
       * inherited overlay.
       */
      const treeScheme = Effect.fn("Updater.treeScheme")(function* (record: Option.Option<Record>) {
        const good = Option.flatMap(record, goodOf)
        if (Option.isNone(good)) return true
        return yield* builder.binds(good.value.fork)
      })

      /** The old scheme's install, said so in the log first. */
      const installOld = (target: Target, record: Option.Option<Record>) =>
        Effect.forEach(Option.toArray(Option.flatMap(record, goodOf)), (good) =>
          log.line(`update: the good build's fork ${good.fork.slice(0, 10)} binds no plugin tree (no packages/cli/src/adjacent-config.ts); staying on the old scheme`),
        ).pipe(Effect.andThen(install(target)))

      const once = Effect.fn("Updater.once")(function* (reason: string) {
        const now = yield* Clock.currentTimeMillis
        const waiting = Option.filter(yield* Ref.get(handedOff), (each) => now - each.at < Duration.toMillis(HANDOFF_LIMIT))
        if (Option.isSome(waiting)) return yield* log.line(`check (${reason}): the restart onto ${shortTarget(waiting.value.target)} is handed off`).pipe(Effect.as(false))
        const held = yield* mark.read
        const alive = yield* Option.match(held, { onNone: () => Effect.succeed(false), onSome: (each) => mark.alive(each.pid) })
        const running = runningOf(held, alive, now)
        const target = yield* source.verified
        const record = yield* records.read
        const wanted = yield* treeScheme(record)
        const installed = wanted && (yield* Effect.forEach(Option.toArray(record), (each) => trees.has(each.version)).pipe(Effect.map((has) => has.includes(true))))
        const next = plan(target, record, yield* rejections.read, running, { wanted, installed })
        return yield* Plan.$match(next, {
          HandingOff: ({ running: handing }) =>
            log.line(`check (${reason}): a handoff runs (pid ${handing.pid}); nothing builds or restarts until it ends`).pipe(Effect.as(false)),
          NoTarget: () => log.line(`check (${reason}): the origin names no verified target`).pipe(Effect.as(false)),
          Current: ({ target: current }) => log.line(`check (${reason}): installed is ${shortTarget(current)}`).pipe(Effect.as(false)),
          Rejected: ({ target: failed, rejected }) =>
            log.line(`check (${reason}): ${shortTarget(failed)} failed at ${rejected.step} (${rejected.cause}); waiting for another target`).pipe(Effect.as(false)),
          Restart: ({ target: built }) => log.line(`check (${reason}): ${shortTarget(built)} is built and not yet proven`).pipe(Effect.andThen(restart(built))),
          Update: ({ target: update }) =>
            Match.value(wanted).pipe(
              Match.when(true, () => installTree(update)),
              Match.orElse(() => installOld(update, record)),
            ),
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
export type Outcome = "proven" | "rolled-back" | "gave-up" | "held"

/** The handoff process's exit code for each outcome: only a proven build exits 0. */
export const EXIT_CODES = { proven: 0, "rolled-back": 2, "gave-up": 1, held: 3 } satisfies { readonly [outcome in Outcome]: number }

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
 * The late strip, after a proven tree handoff's prune: the TUI config (`cli.json`) loses our plugin
 * entries, its own copy kept first (`Configs.stripTui`), once no running executable is an old-format
 * build (`Builds.oldRunning`). Until then an open TUI of the old scheme still reads its plugins there,
 * and a write would reload or blank them; a TUI of a tree build ignores that list (its overlay replaces
 * it). A config that lists none of ours is not touched. It never changes the handoff's outcome: a step
 * that fails is logged, and the next proven handoff tries again.
 */
const lateStrip = Effect.gen(function* () {
  const builds = yield* Builds
  const configs = yield* Configs
  const log = yield* Log
  yield* Effect.gen(function* () {
    if (!(yield* configs.tuiOurs)) return
    const old = yield* builds.oldRunning
    if (old.length > 0) return yield* log.line(`late strip: the TUI config keeps our plugin entries while an old-format build runs (${old.join(", ")})`)
    yield* configs.stripTui
    yield* log.line("late strip: our plugin entries left the TUI config (a copy kept); no old-format build runs")
  }).pipe(Effect.catch((failed) => log.line(`late strip: the TUI config is left as it is: ${failed.step}: ${failed.message}`)))
})

/** A step that failed on the restart path, as the health it leaves: sick, for good. */
const failedStep = (step: string) => (failed: UpdateFailed | CheckoutStuck) => Health.Sick({ plugin: step, cause: failed.message, final: true })

/** Why the checkout did not move onto the build: held (nothing changed, a later check tries again), or failed at `step`. */
interface Unmoved {
  readonly held: boolean
  readonly step: string
  readonly cause: string
}

/**
 * A step before the move that failed, or a move git refused: held. Its cause is the line that names
 * the files in the way when there is one, else what was said first.
 */
const heldBy = (failed: UpdateFailed | CheckoutStuck, what: string = failed.step): Unmoved => {
  const said = failed.message.split("\n")
  const why = Option.getOrElse(Option.orElse(Arr.findFirst(said, (line) => line.startsWith("untracked files")), () => Arr.head(said)), () => failed.step)
  return { held: true, step: failed.step, cause: `${what}: ${why}` }
}

const failedAt = (step: string, failed: UpdateFailed): Unmoved => ({ held: false, step, cause: `${failed.step}: ${failed.message}` })

/**
 * The handoff, for a staged build with its plugin tree beside it (the tree scheme): read the logins,
 * strip our entries from the server config on the first tree install alone (`migrate`), install the
 * staged build in the record (which points the launcher at it), restart the service, read its
 * health, and recover. No step moves the live checkout or reloads a running process's plugins: each
 * process binds the tree beside its own executable. A sick restart rolls back to the last good build,
 * a record write (`rollBackTree`), and restarts onto it.
 *
 * For a staged build with no tree (the old scheme, kept while the good build's fork binds no tree):
 * move the live checkout onto the build's dotfiles commit and write its configs (`moveOnto`), install
 * the staged build, restart, read its health, and recover. The checkout moves here, seconds before the
 * restart: the running service and every open TUI reload a plugin whose files change (2026-11-19). A
 * sick restart reinstalls the dependencies and restarts once; still sick, it rolls back to the last
 * good build, its dotfiles commit and its config.
 *
 * Either way a step that fails (the restart, the reinstall, the rollback) is a sick reading, so it goes
 * down the same ladder: the handoff ends healthy, rolled back, or given up with the owner's notice,
 * and never fails. A build that does not end proven is rejected, so no check builds or restarts onto
 * it again.
 */
const steps: (reason: string) => Effect.Effect<Outcome, never, Builder | Builds | Service | Source | Records | Rejections | Configs | Trees | Notice | Log> = Effect.fn("Update.handoffSteps")(function* (reason: string) {
  const service = yield* Service
  const builder = yield* Builder
  const source = yield* Source
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
    return health
  })

  /** Goes back to the good build; a failed step is the health it leaves. */
  const rollBack = Effect.fn("Update.rollBack")(function* () {
    const record = yield* records.read
    const back = Option.flatMap(record, rolledBack)
    const good = Option.flatMap(record, goodOf)
    if (Option.isNone(back) || Option.isNone(good)) return Option.some(Health.Sick({ plugin: "rollback", cause: "no good build to roll back to", final: true }))
    yield* log.line(`handoff: rolling back to ${good.value.version} (dotfiles ${good.value.dotfiles.slice(0, 10)})`)
    return yield* source.advance(good.value.dotfiles).pipe(
      Effect.andThen(configs.restore),
      Effect.andThen(records.write(back.value)),
      Effect.as(Option.none<Health>()),
      Effect.catch((failed) => Effect.succeed(Option.some(failedStep(`rollback at ${failed.step}`)(failed)))),
    )
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

  const canRollBack = records.read.pipe(Effect.map((record) => Option.isSome(Option.flatMap(record, rolledBack))))

  const reject = (build: Option.Option<Build>, failure: Health, step: string) =>
    Effect.forEach(Option.toArray(build), (each) => rejections.write({ dotfiles: each.dotfiles, fork: each.fork, step, cause: describeHealth(failure) }), { discard: true })

  const end = Effect.fn("Update.end")(function* (outcome: Exclude<Outcome, "proven" | "held">, tried: Option.Option<Build>, failure: Health, said: string, step = "health") {
    yield* notice.show(said)
    yield* reject(tried, failure, step)
    yield* log.line(`handoff: ${outcome}; ${said}`)
    return outcome
  })

  /**
   * Back to the commit `at` and the kept config, after `moveOnto` wrote the configs and the record
   * then does not install the build. A checkout still at `at` does not move.
   */
  const moveBack = (at: string) =>
    source.head.pipe(
      Effect.flatMap((now) => Effect.when(source.advance(at), Effect.succeed(now !== at))),
      Effect.andThen(configs.restore),
      Effect.andThen(log.line(`handoff: the dotfiles and the config moved back to ${at.slice(0, 10)}`)),
      Effect.catch((back) => log.line(`handoff: moving back failed: ${back.message}`)),
    )

  /**
   * Moves the live checkout onto the build's dotfiles commit and writes the configs from it: the
   * last steps before the record installs the build and the service restarts, since the running
   * service and every open TUI reload a plugin whose files change. The config the running build
   * runs with is kept first, for a rollback. A checkout already there (a build by hand) does not
   * move. A failure before the move holds the update (nothing changed, nothing is rejected); a
   * failed move (its install; the checkout went back) or configure (the checkout and the config
   * go back) fails it.
   */
  const moveOnto = Effect.fn("Update.moveOnto")(function* (build: Build) {
    const at = yield* source.head.pipe(Effect.mapError((failed) => heldBy(failed)))
    yield* configs.keep.pipe(Effect.mapError((failed) => heldBy(failed)))
    if (at !== build.dotfiles) {
      yield* log.line(`handoff: moving the dotfiles from ${at.slice(0, 10)} to ${build.dotfiles.slice(0, 10)}, right before the restart`)
      yield* source.advance(build.dotfiles).pipe(
        Effect.catchTags({
          CheckoutStuck: (stuck) => Effect.fail(heldBy(stuck, "the dotfiles checkout could not move")),
          UpdateFailed: (failed) => Effect.fail(failedAt("advance", failed)),
        }),
      )
    }
    yield* builder.configure.pipe(
      Effect.tapError(() => moveBack(at)),
      Effect.mapError((failed) => failedAt("configure", failed)),
    )
    return at
  })

  /** A handoff whose checkout did not move onto the build: held with the notice, or failed and rejected; no restart either way. */
  const unmovedEnd = Effect.fn("Update.unmovedEnd")(function* (unmoved: Unmoved, tried: Option.Option<Build>) {
    if (!unmoved.held) {
      const failure = Health.Sick({ plugin: unmoved.step, cause: unmoved.cause, final: true })
      return yield* end("gave-up", tried, failure, `${describeHealth(failure)}; the service was not restarted`, unmoved.step)
    }
    const said = `update ${reason} is held: ${unmoved.cause}`
    yield* notice.show(said)
    yield* log.line(`handoff: held; ${said}; nothing changed and the service was not restarted, a later check tries again`)
    return "held" satisfies Outcome
  })

  /** The installed record names the staged build: the step before the restart; answers the failure's health, if it failed. */
  const install = (before: Option.Option<Record>) =>
    Effect.forEach(Option.toArray(before), (record) => records.write(promoted(record)), { discard: true }).pipe(
      Effect.as(Option.none<Health>()),
      Effect.catch((failed) => Effect.succeed(Option.some(failedStep("installed record")(failed)))),
    )

  /**
   * Goes back to the good build with trees: a record write. The good build's binary and tree are kept
   * by the prune, and the live checkout never moved. Only a good build with no tree (the old scheme's,
   * before the first tree install) gets the kept configs back first, so it finds the plugin entries
   * it ran with (a strip this handoff made, or one a handoff that died after its strip left).
   */
  const rollBackTree = Effect.fn("Update.rollBackTree")(function* () {
    const record = yield* records.read
    const back = Option.flatMap(record, rolledBack)
    const good = Option.flatMap(record, goodOf)
    if (Option.isNone(back) || Option.isNone(good)) return Option.some(Health.Sick({ plugin: "rollback", cause: "no good build to roll back to", final: true }))
    const treed = yield* trees.has(good.value.version)
    yield* log.line(`handoff: rolling back to ${good.value.version}`)
    const restore = !treed
    if (restore) yield* log.line(`handoff: ${good.value.version} has no plugin tree: the kept configs go back first`)
    return yield* Effect.when(configs.restore, Effect.succeed(restore)).pipe(
      Effect.andThen(records.write(back.value)),
      Effect.as(Option.none<Health>()),
      Effect.catch((failed) => Effect.succeed(Option.some(failedStep(`rollback at ${failed.step}`)(failed)))),
    )
  })

  /**
   * The first tree install's one config step, right before the record and the restart: when the
   * server config still lists our plugin entries (the old scheme wrote them), a copy is kept, then
   * they are stripped, every other key and entry kept (`Configs.strip`). The old service unloads our
   * plugins for the seconds before its restart. Answers whether it stripped. A config that does not
   * read, keep or strip holds the update with nothing changed (a failed strip puts the copy back).
   */
  const migrate = Effect.fn("Update.migrate")(function* () {
    const ours = yield* configs.ours.pipe(Effect.mapError((failed) => heldBy(failed, "the server config does not read")))
    if (!ours) return false
    // A handoff killed between this strip and the record write leaves the old build installed with none of
    // our server plugins, the updater among them, and nothing of ours runs at its next launch to heal it
    // (the launcher is written by the record write that did not happen): the line says the one repair.
    yield* log.line(
      "handoff: the first tree install: our plugin entries leave the server config (a copy kept), right before the restart; if no install record follows this line, `bun run daily` in the checkout writes them back",
    )
    yield* configs.keep.pipe(Effect.mapError((failed) => heldBy(failed, "the server config could not be kept")))
    yield* configs.strip.pipe(
      Effect.tapError(() => configs.restore.pipe(Effect.ignore)),
      Effect.mapError((failed) => heldBy(failed, "our plugin entries could not leave the server config")),
    )
    return true
  })

  /**
   * The recovery after the first restart, down the ladder (`recover`), to an outcome: proven
   * (recorded good, then the prune), rolled back, or given up. `reinstall` is the old scheme's rung.
   */
  const ladder = Effect.fn("Update.ladder")(function* (
    tried: Option.Option<Build>,
    hadLogins: ReadonlyArray<string>,
    reinstall: boolean,
    back: () => Effect.Effect<Option.Option<Health>>,
    last: Effect.Effect<void, never, Builds | Configs | Log> = Effect.void,
  ) {
    let stage: Stage = "first"
    let health = yield* restartAndRead(stage, hadLogins)
    let failure = health
    for (;;) {
      if (Health.$is("Sick")(health)) failure = health
      const recovery = recover(stage, health, yield* canRollBack, reinstall)
      if (Recovery.$is("Proven")(recovery)) {
        const record = yield* records.read
        yield* Effect.forEach(Option.toArray(record), (current) => records.write(proven(current)), { discard: true }).pipe(
          Effect.catch((failed) => log.line(`handoff: recording the good build failed: ${failed.message}`)),
        )
        yield* Option.match(provenNotice(health), { onNone: () => notice.clear, onSome: notice.show })
        yield* log.line("handoff: the build is proven and recorded as the good build")
        // The handoff's last step. The prune reads the record and lists the share directory under the
        // builds lock daily's stage holds from its copy to its record write (`Builds`), not under this
        // mark, which daily never reads.
        yield* pruneBuilds
        yield* last
        return "proven" satisfies Outcome
      }
      if (Recovery.$is("RolledBack")(recovery)) return yield* end("rolled-back", tried, failure, `${describeHealth(failure)}; rolled back`)
      if (Recovery.$is("GaveUp")(recovery)) return yield* end("gave-up", tried, failure, describeHealth(failure))
      if (Recovery.$is("Reinstall")(recovery)) {
        yield* log.line("handoff: installing the dependencies again")
        stage = "reinstalled"
        const reinstalled = yield* source.reinstall.pipe(Effect.as(Option.none<Health>()), Effect.catch((failed) => Effect.succeed(Option.some(failedStep("reinstall")(failed)))))
        if (Option.isSome(reinstalled)) {
          yield* log.line(`handoff (${stage}): ${describeHealth(reinstalled.value)}`)
          health = reinstalled.value
          continue
        }
      }
      if (Recovery.$is("RollBack")(recovery)) {
        const backed = yield* back()
        if (Option.isSome(backed)) return yield* end("gave-up", tried, failure, `${describeHealth(failure)}; ${describeHealth(backed.value)}`)
        stage = "rolled-back"
      }
      health = yield* restartAndRead(stage, hadLogins)
    }
  })

  yield* log.line(`handoff: ${reason}`)
  const before = yield* records.read
  const tried = Option.flatMap(Option.map(before, promoted), buildOf)
  // Read from the running service before anything changes under it.
  const hadLogins = yield* loginsBefore
  // A build with its tree beside it runs on trees: no checkout move, no config write but the first
  // install's strip, no reinstall rung. One without (the old scheme's build) moves the checkout.
  const treed = yield* Effect.forEach(Option.toArray(tried), (build) => trees.has(build.version)).pipe(Effect.map((has) => has.includes(true)))
  if (treed) {
    const migrated = yield* migrate().pipe(Effect.result)
    if (Result.isFailure(migrated)) return yield* unmovedEnd(migrated.failure, tried)
    const failedInstall = yield* install(before)
    if (Option.isSome(failedInstall)) {
      if (migrated.success) yield* configs.restore.pipe(Effect.catch((back) => log.line(`handoff: putting the config back failed: ${back.message}`)))
      return yield* end("gave-up", tried, failedInstall.value, `${describeHealth(failedInstall.value)}; the service was not restarted`)
    }
    return yield* ladder(tried, hadLogins, false, rollBackTree, lateStrip)
  }
  const moved = yield* Effect.forEach(Option.toArray(tried), moveOnto).pipe(Effect.map(Arr.head), Effect.result)
  if (Result.isFailure(moved)) return yield* unmovedEnd(moved.failure, tried)
  const installing = yield* install(before)
  if (Option.isSome(installing)) {
    yield* Effect.forEach(Option.toArray(moved.success), moveBack, { discard: true })
    return yield* end("gave-up", tried, installing.value, `${describeHealth(installing.value)}; the service was not restarted`)
  }
  return yield* ladder(tried, hadLogins, true, rollBack)
})

/**
 * The handoff under its mark (`HandoffMark`): held before it names the staged build installed and
 * dropped once its outcome, good or rejected, is recorded. The restarted service's own check reads
 * the mark and waits, so one handoff runs at a time.
 */
export const handoff = (reason: string): Effect.Effect<Outcome, never, Builder | Builds | HandoffMark | Service | Source | Records | Rejections | Configs | Trees | Notice | Log> =>
  HandoffMark.use((mark) => mark.hold.pipe(Effect.andThen(steps(reason)), Effect.ensuring(mark.release)))
