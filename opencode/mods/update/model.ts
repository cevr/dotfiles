import { Array as Arr, Clock, Context, Duration, Effect, Layer, Option, Ref } from "effect"
import { describeGate, Gate, gate, rootsOf } from "./gate.ts"
import { describeHealth, final, Health, healthOf, provenNotice, recover, Recovery, type Stage } from "./health.ts"
import { type Build, buildOf, goodOf, promoted, proven, rolledBack } from "./record.ts"
import { Builder, Configs, Handoff, HandoffMark, Log, Notice, Records, Rejections, Service, Sessions, Source, type UpdateFailed } from "./service.ts"
import { shortTarget, type Target } from "./target.ts"
import { ask, ended, IDLE, Plan, plan, runningOf, superseded } from "./update.ts"

/** How often a held restart reads the sessions again. */
export const GATE_POLL = Duration.seconds(30)

/** How long the handoff reads a restarted service before it believes a plugin is missing. */
export const HEALTH_DEADLINE = Duration.minutes(2)

/** How often it reads it meanwhile. */
export const HEALTH_POLL = Duration.seconds(2)

/** How the in-server update runs. */
export interface Policy {
  /** How often a run looks for a newer target while a built one waits for the gate. */
  readonly fetchEvery: Duration.Duration
}

/** The host's update, as the plugin runs it. */
export class Updater extends Context.Service<
  Updater,
  {
    /**
     * Looks for the verified target and installs it: advance, build, wait for the gate, hand the
     * restart off. A request while a run goes asks for one more run after it.
     */
    readonly check: (reason: string) => Effect.Effect<void>
  }
>()("dotfiles-opencode/update/Updater") {}

/** How a waiting run ended: the gate opened, or a newer target came first. */
type Waited = "open" | "superseded"

/** The updater's handlers over the contracts. */
export const updaterLayer = (policy: Policy) =>
  Layer.effect(
    Updater,
    Effect.gen(function* () {
      const source = yield* Source
      const builder = yield* Builder
      const sessions = yield* Sessions
      const handoff = yield* Handoff
      const records = yield* Records
      const mark = yield* HandoffMark
      const rejections = yield* Rejections
      const configs = yield* Configs
      const log = yield* Log
      const runs = yield* Ref.make(IDLE)
      const handedOff = yield* Ref.make(Option.none<Target>())

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
          const held = gate(now, rootsOf(yield* sessions.all))
          if (Gate.$is("Open")(held)) {
            yield* log.line(`restart: ${describeGate(held)} after ${Duration.format(Duration.millis(now - since))} of waiting`)
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
        yield* log.line(`update: ${shortTarget(target)} is built; waiting for every root session to be idle`)
        const waited = yield* waitForGate(target)
        if (waited === "superseded") return true
        yield* handoff.start(shortTarget(target))
        yield* Ref.set(handedOff, Option.some(target))
        yield* log.line("update: the restart is handed off")
        return false
      })

      const install = Effect.fn("Updater.install")(function* (target: Target) {
        const prior = yield* source.head
        yield* log.line(`update: ${shortTarget(target)}; advancing the dotfiles from ${prior.slice(0, 10)}`)
        yield* source.advance(target.dotfiles).pipe(Effect.tapError((failed) => reject(target, "advance", failed.message)))
        yield* configs.keep
        yield* builder.stage(target).pipe(
          Effect.tapError((failed) =>
            Effect.all([source.advance(prior), configs.restore], { discard: true }).pipe(
              Effect.andThen(log.line(`update: the dotfiles and the config moved back to ${prior.slice(0, 10)} after the failed build`)),
              Effect.catch((back) => log.line(`update: moving back after the failed build failed: ${back.message}`)),
              Effect.andThen(reject(target, "build", failed.message)),
            ),
          ),
        )
        return yield* restart(target)
      })

      const once = Effect.fn("Updater.once")(function* (reason: string) {
        const waiting = yield* Ref.get(handedOff)
        if (Option.isSome(waiting)) return yield* log.line(`check (${reason}): the restart onto ${shortTarget(waiting.value)} is handed off`).pipe(Effect.as(false))
        const held = yield* mark.read
        const alive = yield* Option.match(held, { onNone: () => Effect.succeed(false), onSome: (each) => mark.alive(each.pid) })
        const running = runningOf(held, alive, yield* Clock.currentTimeMillis)
        const target = yield* source.verified
        const next = plan(target, yield* records.read, yield* rejections.read, running)
        return yield* Plan.$match(next, {
          HandingOff: ({ running: handing }) =>
            log.line(`check (${reason}): a handoff runs (pid ${handing.pid}); nothing builds or restarts until it ends`).pipe(Effect.as(false)),
          NoTarget: () => log.line(`check (${reason}): the origin names no verified target`).pipe(Effect.as(false)),
          Current: ({ target: current }) => log.line(`check (${reason}): installed is ${shortTarget(current)}`).pipe(Effect.as(false)),
          Rejected: ({ target: failed, rejected }) =>
            log.line(`check (${reason}): ${shortTarget(failed)} failed at ${rejected.step} (${rejected.cause}); waiting for another target`).pipe(Effect.as(false)),
          Restart: ({ target: built }) => log.line(`check (${reason}): ${shortTarget(built)} is built and not yet proven`).pipe(Effect.andThen(restart(built))),
          Update: ({ target: wanted }) => install(wanted),
        })
      })

      const loop: (reason: string) => Effect.Effect<void> = Effect.fn("Updater.loop")(function* (reason: string) {
        const rerun = yield* once(reason).pipe(
          Effect.catchTag("UpdateFailed", (failed: UpdateFailed) => log.line(`update failed at ${failed.step}: ${failed.message}`).pipe(Effect.as(false))),
        )
        const [again] = yield* Ref.modify(runs, (state) => {
          const [next, runsNext] = ended(state)
          return [[next || rerun] as const, runsNext]
        })
        if (again) yield* loop("again")
      })

      const check = Effect.fn("Updater.check")(function* (reason: string) {
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

/** A step that failed on the restart path, as the health it leaves: sick, for good. */
const failedStep = (step: string) => (failed: UpdateFailed) => Health.Sick({ plugin: step, cause: failed.message, final: true })

/**
 * The handoff: install the staged build, restart the service, read its health, and recover. A sick
 * restart reinstalls the dependencies and restarts once; still sick, it rolls back to the last good
 * build, its dotfiles commit and its config, and restarts onto it. A step that fails (the restart,
 * the reinstall, the rollback's checkout move) is a sick reading, so it goes down the same ladder:
 * the handoff ends healthy, rolled back, or given up with the owner's notice, and never fails. A
 * build that does not end proven is rejected, so no check builds or restarts onto it again.
 */
const steps: (reason: string) => Effect.Effect<Outcome, never, Service | Source | Records | Rejections | Configs | Notice | Log> = Effect.fn("Update.handoffSteps")(function* (reason: string) {
  const service = yield* Service
  const source = yield* Source
  const records = yield* Records
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

  const reject = (build: Option.Option<Build>, failure: Health) =>
    Effect.forEach(Option.toArray(build), (each) => rejections.write({ dotfiles: each.dotfiles, fork: each.fork, step: "health", cause: describeHealth(failure) }), { discard: true })

  const end = Effect.fn("Update.end")(function* (outcome: Exclude<Outcome, "proven">, tried: Option.Option<Build>, failure: Health, said: string) {
    yield* notice.show(said)
    yield* reject(tried, failure)
    yield* log.line(`handoff: ${outcome}; ${said}`)
    return outcome
  })

  yield* log.line(`handoff: ${reason}`)
  const before = yield* records.read
  const tried = Option.flatMap(Option.map(before, promoted), buildOf)
  const installing = yield* Effect.forEach(Option.toArray(before), (record) => records.write(promoted(record)), { discard: true }).pipe(
    Effect.as(Option.none<Health>()),
    Effect.catch((failed) => Effect.succeed(Option.some(failedStep("installed record")(failed)))),
  )
  if (Option.isSome(installing)) return yield* end("gave-up", tried, installing.value, `${describeHealth(installing.value)}; the service was not restarted`)
  const hadLogins = yield* loginsBefore
  let stage: Stage = "first"
  let health = yield* restartAndRead(stage, hadLogins)
  let failure = health
  for (;;) {
    if (Health.$is("Sick")(health)) failure = health
    const recovery = recover(stage, health, yield* canRollBack)
    if (Recovery.$is("Proven")(recovery)) {
      const record = yield* records.read
      yield* Effect.forEach(Option.toArray(record), (current) => records.write(proven(current)), { discard: true }).pipe(
        Effect.catch((failed) => log.line(`handoff: recording the good build failed: ${failed.message}`)),
      )
      yield* Option.match(provenNotice(health), { onNone: () => notice.clear, onSome: notice.show })
      yield* log.line("handoff: the build is proven and recorded as the good build")
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
      const back = yield* rollBack()
      if (Option.isSome(back)) return yield* end("gave-up", tried, failure, `${describeHealth(failure)}; ${describeHealth(back.value)}`)
      stage = "rolled-back"
    }
    health = yield* restartAndRead(stage, hadLogins)
  }
})

/**
 * The handoff under its mark (`HandoffMark`): held before it names the staged build installed and
 * dropped once its outcome, good or rejected, is recorded. The restarted service's own check reads
 * the mark and waits, so one handoff runs at a time.
 */
export const handoff = (reason: string): Effect.Effect<Outcome, never, HandoffMark | Service | Source | Records | Rejections | Configs | Notice | Log> =>
  HandoffMark.use((mark) => mark.hold.pipe(Effect.andThen(steps(reason)), Effect.ensuring(mark.release)))
