// The world on generated runs, with our real plugins (wakes, idle compaction)
// and a probe plugin whose tool steers a session:
// - determinism: one seed's command sequence, run twice, gives byte-equal
//   traces with no wall-clock value in them, and 50 seeds give at least 10
//   different traces;
// - against a reference model of sessions, their inbox and their idle or busy
//   state, after every command: each steer is delivered exactly once and in
//   the order sent; an idle session never leaves resumable work waiting, and
//   no session runs two executions at once; a restart loses no session,
//   message or stored value, and no timer of the old copies fires; virtual
//   time moves only when a command advances it.
// It also measures what one simulated hour costs in wall time.
import { describe, expect } from "bun:test"
import * as Seed from "./seed.ts"
import { Plugin } from "@opencode/plugin/effect"
import { SessionID } from "@opencode/schema/session-id"
import { Clock, Effect, Option, Schema } from "effect"
import * as Plugins from "./plugins.ts"
import type { InboxItem, Message } from "./host.ts"
import { below, generator, line } from "./runtime.ts"
import { make, say, type World } from "./world.ts"

const SteerInput = Schema.Struct({ sessionID: Schema.String, text: Schema.String, resume: Schema.Boolean })

/** A plugin whose `steer` tool puts a synthetic message into a session, as our plugins' couriers do. */
const probe = Plugin.define({
  id: "sim-probe",
  effect: (ctx) =>
    ctx.tool
      .transform((editor) => {
        editor.add({
          name: "steer",
          description: "steer a session",
          input: SteerInput,
          execute: (input) =>
            ctx.session
              .synthetic({
                sessionID: SessionID.make(input.sessionID),
                text: input.text,
                description: "probe",
                metadata: { source: "probe" },
                resume: input.resume,
              })
              .pipe(
                Effect.as({ content: "sent" }),
                Effect.orElseSucceed(() => ({ content: "refused" })),
              ),
        })
      })
      .pipe(Effect.asVoid),
})

type Command =
  | { readonly type: "session" }
  | { readonly type: "prompt"; readonly session: number }
  | { readonly type: "steer"; readonly session: number; readonly resume: boolean }
  | { readonly type: "alarm"; readonly session: number; readonly seconds: number }
  | { readonly type: "advance"; readonly ms: number }
  | { readonly type: "restart" }
  | { readonly type: "close"; readonly session: number }

/** The command the seed picks from `pick` (0 to 19), for session index `session`. */
const commandOf = (pick: number, session: number, random: ReturnType<typeof generator>): Command => {
  if (pick < 2) return { type: "session" }
  if (pick < 6) return { type: "prompt", session }
  if (pick < 10) return { type: "steer", session, resume: below(random, 3) > 0 }
  if (pick < 12) return { type: "alarm", session, seconds: 1 + below(random, 90) }
  if (pick < 17) return { type: "advance", ms: Math.max(0, below(random, 4) - 1) * (1 + below(random, 120_000)) }
  if (pick < 19) return { type: "restart" }
  return { type: "close", session }
}

/** Up to 40 commands, the seed choosing each. */
const commandsOf = (seed: number): ReadonlyArray<Command> => {
  const random = generator(`commands:${seed}`)
  const count = 10 + below(random, 31)
  return [{ type: "session" }, ...Array.from({ length: count - 1 }, () => commandOf(below(random, 20), below(random, 3), random))]
}

/** The reference model: the sessions made, those alive, and each one's steers in the order sent. */
interface Model {
  readonly sessions: Array<string>
  readonly alive: Set<string>
  readonly sent: Map<string, Array<string>>
  steers: number
}

/** What a check sees after a command. */
interface Step {
  readonly world: World
  readonly model: Model
  readonly command: Command
  readonly before: number
}

/** The world with the wakes and idle compaction plugins and the probe loaded for one directory. */
const worldOf = (seed: number) =>
  Effect.gen(function* () {
    const world = make({ seed, script: (request) => say(`${request.kind} ${request.text.length}`) })
    yield* world.load(Plugins.wake(world), { directory: "/work", options: { backstop: "off" } })
    yield* world.load(Plugins.idleCompact, { directory: "/work", options: { ttlSeconds: 20, shortMarginSeconds: 5, thresholdTokens: 50 } })
    yield* world.load(probe, { directory: "/work" })
    return world
  })

/** The live session a command names, if any: its index among those made. */
const targetOf = (model: Model, index: number) =>
  Option.filter(Option.fromNullishOr(model.sessions[index % Math.max(1, model.sessions.length)]), (id) => model.alive.has(id))

/** One command on the world, and on the model. */
const apply = (world: World, model: Model, command: Command) =>
  Effect.gen(function* () {
    if (command.type === "session") {
      const id = yield* world.session("/work")
      model.sessions.push(id)
      model.alive.add(id)
      model.sent.set(id, [])
    }
    if (command.type === "advance") yield* world.advance(command.ms)
    if (command.type === "restart") yield* world.restart
    if (command.type === "session" || command.type === "advance" || command.type === "restart") return
    const target = targetOf(model, command.session)
    if (Option.isNone(target)) return
    const id = target.value
    if (command.type === "prompt") yield* world.prompt(id, `prompt ${model.steers}`)
    if (command.type === "steer") {
      model.steers += 1
      const text = `steer ${model.steers}`
      yield* world.tool(id, "steer", { sessionID: id, text, resume: command.resume })
      model.sent.get(id)?.push(text)
    }
    if (command.type === "alarm") yield* world.tool(id, "wake", { afterSeconds: command.seconds, note: `alarm ${command.seconds}` })
    if (command.type === "close") {
      yield* world.remove(id)
      model.alive.delete(id)
    }
  })

/** One generated run on a fresh world; after each command, `check` sees the world and the model. */
const runOf = (seed: number, check: (step: Step) => void = () => void 0) =>
  Effect.gen(function* () {
    const world = yield* worldOf(seed)
    const model: Model = { sessions: [], alive: new Set(), sent: new Map(), steers: 0 }
    for (const command of commandsOf(seed)) {
      const before = world.now()
      yield* apply(world, model, command)
      check({ world, model, command, before })
    }
    return world
  })

/** A probe's steer's text, in the conversation or the inbox; nothing else's. */
const probeText = (entry: Message | InboxItem): ReadonlyArray<string> => {
  if (entry.type === "synthetic" && entry.metadata["source"] === "probe") return [entry.text]
  return []
}

/** The steers the session holds: delivered into its conversation, then still waiting in its inbox. */
const steersOf = (world: World, id: string) => {
  const session = world.sessions.get(id)
  return [...(session?.messages ?? []), ...(session?.inbox ?? [])].flatMap(probeText)
}

/** The invariants after one command. */
const invariants = (memory: { stored: Map<string, Map<string, Schema.Json>>; messages: Map<string, number>; lines: number }) => (step: Step) => {
  const { world, model, command, before } = step
  const label = line(command)
  // Time moves only by an advance.
  if (command.type !== "advance") expect(world.now(), label).toBe(before)
  expect([...world.sessions.keys()].filter((id) => model.sessions.includes(id)).toSorted(), label).toEqual([...model.alive].toSorted())
  for (const id of model.alive) {
    // Each steer once, in the order sent: those delivered, then those still waiting.
    expect(steersOf(world, id), label).toEqual(model.sent.get(id) ?? [])
    // An idle session leaves no work that wakes it waiting.
    const session = world.sessions.get(id)
    if (session?.running === false)
      expect(
        session.inbox.filter((item) => item.resume),
        label,
      ).toEqual([])
  }
  // No timer of a closed copy fired.
  expect(world.stale(), label).toEqual([])
  if (command.type === "restart") {
    // What was stored before is there after, unless a copy wrote the key since; no message is lost; only live copies' timers are set.
    const since = world.trace().split("\n").slice(memory.lines).join("\n")
    for (const [plugin, values] of memory.stored)
      for (const [key, value] of values)
        if (!since.includes(`"key":${line(key)}`)) expect(world.storage.get(plugin)?.get(key), `${label}: ${plugin} ${key}`).toEqual(value)
    for (const [id, count] of memory.messages) expect(world.messages(id).length, label).toBeGreaterThanOrEqual(count)
    expect(
      world.timers().filter((owner) => owner !== 0 && !world.live().includes(owner)),
      label,
    ).toEqual([])
  }
  memory.stored = new Map([...world.storage].map(([plugin, values]) => [plugin, new Map(values)]))
  memory.messages = new Map([...world.sessions].map(([id, session]) => [id, session.messages.length]))
  memory.lines = world.trace().split("\n").length
}

const TraceLine = Schema.Struct({
  kind: Schema.String,
  type: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Struct({ sessionID: Schema.optional(Schema.String) })),
})
const traceLine = Schema.decodeUnknownSync(Schema.fromJsonString(TraceLine))

/** No session ran two executions at once: each start ends before the next. */
const oneAtATime = (world: World) => {
  const running = new Set<string>()
  for (const entry of world
    .trace()
    .split("\n")
    .map((text) => traceLine(text))) {
    const id = entry.data?.sessionID ?? ""
    if (entry.type === "session.execution.started") {
      expect(running.has(id), `a second execution of ${id}`).toBe(false)
      running.add(id)
    }
    if (entry.type === "session.execution.succeeded") running.delete(id)
    if (entry.kind === "down") running.clear()
  }
}

const SEEDS = Array.from({ length: 50 }, (_, index) => index + 1)

describe("the world", () => {
  Seed.effect(
    "one seed replays byte for byte, holds no wall-clock value, and 50 seeds give at least 10 different runs",
    Effect.gen(function* () {
      const wall = String(yield* Clock.currentTimeMillis).slice(0, 7)
      const traces = yield* Effect.forEach(SEEDS, (seed) =>
        Effect.gen(function* () {
          const first = (yield* runOf(seed)).trace()
          const second = (yield* runOf(seed)).trace()
          expect(second, `seed ${seed}`).toBe(first)
          // No wall-clock reading: the clock starts at the world's fixed epoch (2001), years off today's.
          expect(first.includes(wall), `seed ${seed}`).toBe(false)
          return first
        }),
      )
      expect(new Set(traces).size).toBeGreaterThanOrEqual(10)
    }),
  )

  Seed.effect(
    "against the reference model: steers once and in order, idle sessions take their work, restarts lose nothing, time moves only when advanced",
    Effect.forEach(SEEDS, (seed) => runOf(seed, invariants({ stored: new Map(), messages: new Map(), lines: 0 })).pipe(Effect.map(oneAtATime)), {
      discard: true,
    }),
  )

  Seed.effect(
    "a simulated hour costs milliseconds",
    Effect.gen(function* () {
      const world = yield* worldOf(7)
      const sessions = yield* Effect.forEach([0, 1, 2], () => world.session("/work"))
      yield* Effect.forEach(sessions, (session, index) =>
        world.prompt(session, "start").pipe(Effect.andThen(world.tool(session, "wake", { afterSeconds: 60 * (index + 1), everySeconds: 300, note: "tick" }))),
      )
      const started = yield* Clock.currentTimeMillis
      yield* world.advance(3_600_000)
      const cost = (yield* Clock.currentTimeMillis) - started
      yield* Effect.logInfo(`sim: one simulated hour (3 sessions, repeating alarms, idle compaction) took ${cost} ms of wall time`)
      expect(world.elapsed()).toBeGreaterThanOrEqual(3_600_000)
      expect(cost).toBeLessThan(2_000)
    }),
  )
})
