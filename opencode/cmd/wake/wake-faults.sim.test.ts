// A generated property over the world's faults, on the simulated host at 20
// seeds: the wakes plugin (`cmd/wake/server.ts`'s `make`, sim/plugins.ts) in
// up to three sessions, the seed choosing up to 40 commands of alarms set,
// alarms cancelled, time passing, and the faults the world has for a server
// plugin: a reload at any point (every copy closed and built again from its
// root), and an outage (the server down for up to ten minutes, then up on the
// same storage and sessions).
//
// After each command: no alarm fired twice, none before it was due, none that
// a cancel answered for; no timer of a closed copy fired. Then, the server up
// and every due time past: each alarm not cancelled fired exactly once; a
// fire is late, and says so naming the server that was not running, only when
// an outage covered its due time, and otherwise goes within a second of it;
// while the server was down nothing was asked of the model.
import { Effect } from "effect"
import { lateBy } from "@dotfiles/opencode-wake/message"
import * as Plugins from "../../sim/plugins.ts"
import { below, generator } from "../../sim/runtime.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = Seed.runner("cmd/wake/wake-faults.sim.test.ts")

const WORK = "/scratch/project"
const MINUTE = 60_000
const LATE = /It fired \S+ late: no OpenCode server was running at /

type Command =
  | { readonly type: "session" }
  | { readonly type: "alarm"; readonly session: number; readonly seconds: number }
  | { readonly type: "cancel"; readonly alarm: number }
  | { readonly type: "advance"; readonly ms: number }
  | { readonly type: "restart" }
  | { readonly type: "outage"; readonly ms: number }

const commandOf = (pick: number, random: ReturnType<typeof generator>): Command => {
  if (pick < 1) return { type: "session" }
  if (pick < 6) return { type: "alarm", session: below(random, 3), seconds: 1 + below(random, 600) }
  if (pick < 8) return { type: "cancel", alarm: below(random, 40) }
  if (pick < 12) return { type: "advance", ms: 1 + below(random, 5 * MINUTE) }
  if (pick < 13) return { type: "restart" }
  return { type: "outage", ms: 1 + below(random, 10 * MINUTE) }
}

/** Up to 40 commands, the seed choosing each; the first opens a session. */
const commandsOf = (seed: number): ReadonlyArray<Command> => {
  const random = generator(`wake-faults:${seed}`)
  const count = 10 + below(random, 31)
  return [{ type: "session" }, ...Array.from({ length: count - 1 }, () => commandOf(below(random, 14), random))]
}

interface Alarm {
  readonly id: string
  readonly session: string
  readonly dueAt: number
  cancelled: boolean
}

/** What the run set and did, beside the world. */
interface Run {
  readonly world: World.World
  readonly sessions: Array<string>
  readonly alarms: Array<Alarm>
  /** The spans the server was down: [from, to) in world time. */
  readonly outages: Array<readonly [number, number]>
  /** Answers of `wake` that named no alarm set. */
  readonly unset: Array<string>
}

/** A wake's fire in the conversation: the synthetic message its letter came in. */
const wakeMessage = (message: World.Message) => {
  if (message.type === "synthetic" && message.metadata["source"] === "wake") return [message]
  return []
}

const firesOf = (run: Run, alarm: Alarm) =>
  run.sessions.flatMap((session) => run.world.messages(session).flatMap(wakeMessage)).filter((message) => message.metadata["id"] === alarm.id)

/** An alarm set as a session's model would: its id, due time and session. */
const setAlarm = (run: Run, command: Extract<Command, { type: "alarm" }>) =>
  Effect.gen(function* () {
    const session = run.sessions[command.session % run.sessions.length] ?? ""
    const answer = yield* run.world.tool(session, "wake", { afterSeconds: command.seconds, note: `N${run.alarms.length}` })
    const id = /Alarm (w[0-9a-z]+) set/.exec(answer.output)?.[1]
    if (id === void 0) return void run.unset.push(answer.output)
    run.alarms.push({ id, session, dueAt: run.world.now() + command.seconds * 1_000, cancelled: false })
  })

/** A cancel that answers for the alarm holds; one that finds it gone (fired already) changes nothing. */
const cancel = (run: Run, command: Extract<Command, { type: "cancel" }>) =>
  Effect.gen(function* () {
    const alarm = run.alarms[command.alarm % Math.max(1, run.alarms.length)]
    if (alarm === void 0) return
    const answer = yield* run.world.tool(alarm.session, "wake_cancel", { id: alarm.id })
    if (answer.output.includes(`Cancelled ${alarm.id}`)) alarm.cancelled = true
  })

const outage = (run: Run, ms: number) =>
  Effect.gen(function* () {
    const from = run.world.now()
    yield* run.world.down
    yield* run.world.advance(ms)
    run.outages.push([from, run.world.now()])
    yield* run.world.up
  })

const apply = (run: Run, command: Command): Effect.Effect<void, World.SimError> => {
  switch (command.type) {
    case "session":
      return run.world.session(WORK).pipe(Effect.map((session) => void run.sessions.push(session)))
    case "alarm":
      return setAlarm(run, command)
    case "cancel":
      return cancel(run, command)
    case "advance":
      return run.world.advance(command.ms)
    case "restart":
      return run.world.restart
    case "outage":
      return outage(run, command.ms)
  }
}

/** The fires an alarm should have had by the end: none once cancelled, else one. */
const owed = (alarm: Alarm) => {
  if (alarm.cancelled) return 0
  return 1
}

seeded("an alarm fires once, never early and never after a cancel, across reloads and outages, and a late one says why", ({ seed, expect }) =>
  Effect.gen(function* () {
    const world = World.make({ seed, script: () => World.say("Noted.") })
    yield* world.load(Plugins.wake(world), { directory: WORK, options: { backstop: "off" } })
    const run: Run = { world, sessions: [], alarms: [], outages: [], unset: [] }

    const check = () => {
      expect(run.unset).toEqual([])
      for (const alarm of run.alarms) {
        const own = firesOf(run, alarm)
        expect(own.length).toBeLessThanOrEqual(1)
        if (alarm.cancelled) expect(own).toEqual([])
        for (const message of own) expect(Number(message.metadata["firedAt"])).toBeGreaterThanOrEqual(alarm.dueAt)
      }
      expect(world.stale()).toEqual([])
    }

    for (const command of commandsOf(seed)) {
      yield* apply(run, command)
      check()
    }

    // Every due time past, the sessions at rest.
    const last = Math.max(world.now(), ...run.alarms.map((alarm) => alarm.dueAt))
    yield* world.advance(last - world.now() + MINUTE)
    yield* world.until(() => run.sessions.every((session) => world.sessions.get(session)?.running !== true), 10 * MINUTE)
    check()

    for (const alarm of run.alarms) {
      const own = firesOf(run, alarm)
      expect(own).toHaveLength(owed(alarm))
      for (const message of own) {
        const firedAt = Number(message.metadata["firedAt"])
        const late = lateBy(alarm.dueAt, firedAt) !== void 0
        expect(LATE.test(message.text)).toBe(late)
        // Only an outage over its due time makes a fire late; with the server up it goes at its time.
        const missed = run.outages.some(([from, to]) => alarm.dueAt >= from && alarm.dueAt < to)
        if (late) expect(missed).toBe(true)
        if (!missed) expect(firedAt - alarm.dueAt).toBeLessThan(1_000)
      }
    }
    // Nothing was asked of the model while the server was down.
    const asked = world.asked().map((request) => world.start + request.at)
    expect(asked.filter((at) => run.outages.some(([from, to]) => at > from && at < to))).toEqual([])
  }),
)
