import { Clock, Context, Duration, Effect, Layer, Option, Ref } from "effect"
import { describeGate, Gate, gate, rootsOf } from "./gate.ts"
import { describeHealth, final, Health, healthOf, recover, Recovery, type Stage } from "./health.ts"
import { goodOf, proven, rolledBack } from "./record.ts"
import { Builder, Configs, Handoff, Log, Notice, Records, Service, Sessions, Source, type UpdateFailed } from "./service.ts"
import { shortTarget, type Target } from "./target.ts"
import { ask, ended, IDLE, Plan, plan, superseded } from "./update.ts"

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
      const configs = yield* Configs
      const log = yield* Log
      const runs = yield* Ref.make(IDLE)

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

      const install = Effect.fn("Updater.install")(function* (target: Target) {
        const prior = yield* source.head
        yield* log.line(`update: ${shortTarget(target)}; advancing the dotfiles from ${prior.slice(0, 10)}`)
        yield* source.advance(target.dotfiles)
        yield* configs.keep
        yield* builder.stage(target).pipe(
          Effect.tapError(() =>
            source.advance(prior).pipe(
              Effect.andThen(log.line(`update: the dotfiles moved back to ${prior.slice(0, 10)} after the failed build`)),
              Effect.catch((failed) => log.line(`update: moving the dotfiles back failed: ${failed.message}`)),
            ),
          ),
        )
        yield* log.line(`update: built ${shortTarget(target)}; waiting for every root session to be idle`)
        const waited = yield* waitForGate(target)
        if (waited === "superseded") return true
        yield* handoff.start(`${shortTarget(target)}`)
        yield* log.line("update: the restart is handed off")
        return false
      })

      const once = Effect.fn("Updater.once")(function* (reason: string) {
        const target = yield* source.verified
        const next = plan(target, yield* records.read)
        return yield* Plan.$match(next, {
          NoTarget: () => log.line(`check (${reason}): the origin names no verified target`).pipe(Effect.as(false)),
          Current: ({ target: current }) => log.line(`check (${reason}): installed is ${shortTarget(current)}`).pipe(Effect.as(false)),
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

/**
 * The handoff: restart the service, read its health, and recover. A sick restart reinstalls the
 * dependencies and restarts once; still sick, it rolls back to the last good build, its dotfiles
 * commit and its config, and restarts onto it. Every step is a line in the log; a failure the
 * owner must see goes to the TUI's corner as well.
 */
export const handoff = Effect.fn("Update.handoff")(function* (reason: string) {
  const service = yield* Service
  const source = yield* Source
  const records = yield* Records
  const configs = yield* Configs
  const notice = yield* Notice
  const log = yield* Log

  const healthNow = Effect.fn("Update.health")(function* () {
    const start = yield* Clock.currentTimeMillis
    for (;;) {
      const health = yield* service.read.pipe(
        Effect.map(healthOf),
        Effect.catchTag("UpdateFailed", (failed: UpdateFailed) => Effect.succeed(Health.Sick({ plugin: "service", cause: failed.message, final: false }))),
      )
      if (final(health) || (yield* Clock.currentTimeMillis) - start >= Duration.toMillis(HEALTH_DEADLINE)) return health
      yield* Effect.sleep(HEALTH_POLL)
    }
  })

  const restartAndRead = Effect.fn("Update.restartAndRead")(function* (stage: Stage) {
    yield* log.line(`handoff (${stage}): restarting the service`)
    yield* service.restart
    const health = yield* healthNow()
    yield* log.line(`handoff (${stage}): ${describeHealth(health)}`)
    return health
  })

  const rollBack = Effect.fn("Update.rollBack")(function* () {
    const record = yield* records.read
    const back = Option.flatMap(record, rolledBack)
    const good = Option.flatMap(record, goodOf)
    if (Option.isNone(back) || Option.isNone(good)) return yield* log.line("handoff: no good build to roll back to")
    yield* log.line(`handoff: rolling back to ${good.value.version} (dotfiles ${good.value.dotfiles.slice(0, 10)})`)
    yield* source.advance(good.value.dotfiles)
    yield* configs.restore
    yield* records.write(back.value)
  })

  const canRollBack = records.read.pipe(Effect.map((record) => Option.isSome(Option.flatMap(record, rolledBack))))

  yield* log.line(`handoff: ${reason}`)
  let stage: Stage = "first"
  let health = yield* restartAndRead(stage)
  let failure = health
  for (;;) {
    if (Health.$is("Sick")(health)) failure = health
    const recovery = recover(stage, health, yield* canRollBack)
    if (Recovery.$is("Proven")(recovery)) {
      const record = yield* records.read
      yield* Effect.forEach(Option.toArray(record), (current) => records.write(proven(current)), { discard: true })
      yield* notice.clear
      yield* log.line("handoff: the build is proven and recorded as the good build")
      return "proven" satisfies Outcome
    }
    if (Recovery.$is("RolledBack")(recovery)) {
      yield* notice.show(`${describeHealth(failure)}; rolled back`)
      yield* log.line(`handoff: rolled back; the failed build: ${describeHealth(failure)}`)
      return "rolled-back" satisfies Outcome
    }
    if (Recovery.$is("GaveUp")(recovery)) {
      yield* notice.show(describeHealth(failure))
      yield* log.line(`handoff: gave up; ${describeHealth(failure)}`)
      return "gave-up" satisfies Outcome
    }
    if (Recovery.$is("Reinstall")(recovery)) {
      yield* log.line("handoff: installing the dependencies again")
      yield* source.reinstall
      stage = "reinstalled"
    }
    if (Recovery.$is("RollBack")(recovery)) {
      yield* rollBack()
      stage = "rolled-back"
    }
    health = yield* restartAndRead(stage)
  }
})
