// Wakes on the simulated host (sim/world.ts), each test at 20 seeds:
// tests/wake.test.ts's names and the claims it reads off the model's requests,
// the transcripts, the tray and the plugin's starts, moved off real OpenCode
// (it waited out alarms seconds away, and a server down for 75 s, in real
// time). The plugin is `cmd/wake/server.ts`'s `make` on the world's plugin
// context, with OpenCode's adapters (sim/plugins.ts); the model answers by the
// scenarios' rules (scenarios/wake.ts, scenarios/wake-downtime.ts). The tray
// is Prime's own reading (`wakeItem`) of the plugin's `pending` RPC, taken as
// Prime's reader takes it. What the TUI draws (the ◈ rows, the frames' text)
// stays in tests/wake.test.ts.
import { Effect, Schema } from "effect"
import { wakeItem } from "../../mods/prime/wakes.ts"
import * as Plugins from "../../sim/plugins.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = Seed.runner("cmd/wake/wake.sim.test.ts")

const WORK = "/scratch/project"
const WAKES = "dotfiles-opencode.wake"
const OPTIONS = { backstop: "off" }
/** The monitor's command: it prints READY once the clock reaches the run's ready time, else waiting. */
const PROBE = "probe-ready"

/** scenarios/wake.ts's model: the reply to whatever came last in the conversation. */
const rules: ReadonlyArray<readonly [string, (text: string) => World.Reply]> = [
  ["step-wake", () => World.call("call_wake_alpha", "wake", { afterSeconds: 3, note: "ALPHA: check that the build finished" })],
  ["call_wake_alpha", () => World.say("Alpha alarm set.")],
  ["Note: ALPHA", () => World.say("Woke on alpha.")],
  ["step-notify", () => World.call("call_notify_beta", "wake", { afterSeconds: 2, mode: "notify", note: "BETA: glance at the deploy" })],
  ["call_notify_beta", () => World.say("Beta notice set.")],
  ["step-after-notice", (text) => World.say(sawBeta(text))],
  [
    "step-monitor",
    () => World.call("call_monitor_gamma", "monitor", { command: PROBE, intervalSeconds: 1, until: "^READY$", note: "GAMMA: the service is up" }),
  ],
  ["call_monitor_gamma", () => World.say("Gamma monitor set.")],
  ["Note: GAMMA", () => World.say("Woke on gamma.")],
  ["step-cancel", () => World.call("call_wake_delta", "wake", { afterSeconds: 4, note: "DELTA: should never fire" })],
  [
    "call_wake_delta",
    (text) =>
      World.call("call_cancel_delta", "wake_cancel", { id: /Alarm (w[0-9a-z]+) set/.exec(text.slice(text.lastIndexOf("call_wake_delta")))?.[1] ?? "missing" }),
  ],
  ["call_cancel_delta", (text) => World.say(cancelled(text))],
  ["Note: DELTA", () => World.say("Delta fired after all.")],
  ["step-reload", () => World.call("call_wake_epsilon", "wake", { afterSeconds: 8, note: "EPSILON: survive the reload" })],
  ["call_wake_epsilon", () => World.say("Epsilon alarm set.")],
  ["Note: EPSILON", () => World.say("Woke on epsilon.")],
]

const sawBeta = (text: string) => {
  if (text.includes("Note: BETA")) return "Saw the beta notice."
  return "Missed the beta notice."
}
const cancelled = (text: string) => {
  if (text.includes("Cancelled w")) return "Delta cancelled."
  return "Delta not cancelled."
}

/** The rule whose marker comes last in the conversation answers; with none, nothing to do. */
const reply = (text: string) => {
  const [last] = rules.map(([marker, respond]) => ({ at: text.lastIndexOf(marker), respond })).toSorted((left, right) => right.at - left.at)
  if (last === void 0 || last.at < 0) return World.say("Nothing to do.")
  return last.respond(text)
}

/** scenarios/wake-downtime.ts's model. */
const downtime = (text: string) => {
  if (text.includes("Note: ZETA") && text.includes("no OpenCode server was running")) return World.say("Woke late on zeta.")
  if (text.includes("Note: ZETA")) return World.say("Woke on zeta, not late.")
  if (text.includes("call_wake_zeta")) return World.say("Zeta alarm set.")
  return World.call("call_wake_zeta", "wake", { afterSeconds: 5, note: "ZETA: look again after the outage" })
}

/** The answer of the plugin's `pending` RPC as Prime's reader (mods/prime/opencode/wakes.ts) decodes it. */
const Pending = Schema.Struct({
  now: Schema.Number,
  entries: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      kind: Schema.Literals(["alarm", "monitor", "latch"]),
      dueAt: Schema.Number,
      note: Schema.String,
      mode: Schema.Literals(["wake", "notify"]),
    }),
  ),
  notices: Schema.Array(Schema.Unknown),
})

/** The monitor's probe: READY once the clock passes `ready.at`. */
const probe = (ready: { at: number }) => (command: string, now: number) => {
  if (command !== PROBE) return World.PROCESSES(command)
  if (now >= ready.at) return { exitCode: 0, stdout: "READY\n", ms: 20 }
  return { exitCode: 0, stdout: "waiting\n", ms: 20 }
}

/** The scenarios' model: the session's title as the fixture's, every other request by `script`. */
const titled =
  (script: (text: string) => World.Reply): World.Script =>
  (request) => {
    if (request.kind === "title") return World.say("Wake fixture")
    return script(request.text)
  }

/** One world with the wakes plugin loaded for the project, its root session, and the readings the claims take. */
const boot = (seed: number, script: (text: string) => World.Reply, ready = { at: Number.POSITIVE_INFINITY }) =>
  Effect.gen(function* () {
    const world = World.make({ seed, script: titled(script), processes: probe(ready) })
    yield* world.load(Plugins.wake(world), { directory: WORK, options: OPTIONS })
    const session = yield* world.session(WORK)
    const idle = () => world.sessions.get(session)?.running !== true
    const replies = () => world.messages(session).flatMap(replyText)
    /** The tray as Prime draws it: its words, or undefined with nothing pending or unread. */
    const tray = world.rpc(WAKES, "pending", { sessionIDs: [session] }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Pending)),
      Effect.map(({ now, entries, notices }) => wakeItem({ now, entries: entries.flatMap(alarmOrMonitor), notices: notices.length }, 100)?.text),
    )
    /** The owner's prompt, then the session's turns until it is idle again with `done` true. */
    const step = (text: string, done: () => boolean) => world.prompt(session, text).pipe(Effect.andThen(world.until(() => idle() && done(), 60_000)))
    const root = () => world.asked().filter((request) => request.sessionID === session && request.kind === "primary")
    const fired = () => world.messages(session).flatMap(wakeMessage)
    return { world, idle, replies, tray, step, root, fired }
  })

/** An assistant's text reply, alone; nothing for a tool call or another message. */
const replyText = (message: World.Message) => {
  if (message.type === "assistant" && message.text !== "") return [message.text]
  return []
}

/** A pending entry Prime's dock counts: an alarm or a monitor, not a latch. */
const alarmOrMonitor = <E extends { readonly kind: "alarm" | "monitor" | "latch" }>(entry: E) => {
  if (entry.kind === "latch") return []
  return [{ ...entry, kind: entry.kind }]
}

/** A wake's fire in the conversation: the synthetic message its letter came in. */
const wakeMessage = (message: World.Message) => {
  if (message.type === "synthetic" && message.metadata["source"] === "wake") return [message]
  return []
}

seeded(
  "an alarm wakes the idle session, a notice waits for the next turn, a monitor wakes on its match, a cancel holds, and a reload fires once",
  ({ seed, expect }) =>
    Effect.gen(function* () {
      const ready = { at: Number.POSITIVE_INFINITY }
      const { world, idle, replies, tray, step, root, fired } = yield* boot(seed, reply, ready)

      // The alarm: the tray counts it while it waits; its fire wakes the idle session, and the model answers it.
      yield* step("step-wake", () => replies().includes("Alpha alarm set."))
      expect(yield* tray).toBe("1 wake")
      yield* world.until(() => idle() && replies().includes("Woke on alpha."), 10_000)
      expect(yield* tray).toBeUndefined()
      // The letter: what fired, when it was set and due, the note verbatim; on time, so it does not say late.
      const woken = root().find((request) => request.text.includes("Note: ALPHA"))
      expect(woken?.text).toMatch(
        /⏰ Wake w[0-9a-z]+ fired: the alarm you set at \d{4}-\d\d-\d\dT[\d:.]+Z, due \d{4}-\d\d-\d\dT[\d:.]+Z\.\nNote: ALPHA: check that the build finished/,
      )
      expect(woken?.text).not.toContain("no OpenCode server was running")

      // The notice: counted in the tray at its time, but it starts no turn; the next turn reads it.
      yield* step("step-notify", () => replies().includes("Beta notice set."))
      const requested = root().length
      yield* world.advance(5_000)
      expect(yield* tray).toBe("1 notice")
      expect(root()).toHaveLength(requested)
      yield* step("step-after-notice", () => replies().some((text) => text.includes("beta notice.")))
      const sawBeta = root().findIndex((request) => request.text.includes("Note: BETA"))
      expect(sawBeta).toBeGreaterThan(0)
      expect(root()[sawBeta]?.text).toContain("step-after-notice")
      expect(root()[sawBeta]?.text).toContain("This is a notice: it started no turn, and you are reading it at your next one.")
      expect(replies()).toContain("Saw the beta notice.")
      expect(yield* tray).toBeUndefined()

      // The monitor: counted while it polls, then a wake with the match, the note and the last output.
      ready.at = world.now() + 4_000
      yield* step("step-monitor", () => replies().includes("Gamma monitor set."))
      expect(yield* tray).toBe("1 monitor")
      yield* world.until(() => idle() && replies().includes("Woke on gamma."), 20_000)
      const gamma = root().find((request) => request.text.includes("Note: GAMMA"))?.text ?? ""
      expect(gamma).toMatch(/⏰ Monitor w[0-9a-z]+ matched: `.*` printed a match for \/\^READY\$\/ after \d+ checks\./)
      expect(gamma).toContain("Note: GAMMA: the service is up\nLast output (exit 0):\nREADY")

      // The cancel: the alarm is gone, and past its time it never fired.
      yield* step("step-cancel", () => replies().some((text) => text.startsWith("Delta")))
      yield* world.advance(6_000)
      expect(replies()).toContain("Delta cancelled.")
      expect(root().some((request) => request.text.includes("Note: DELTA"))).toBe(false)
      expect(fired().some((message) => message.text.includes("DELTA"))).toBe(false)

      // The reload: the plugin is built again from its composition root before the alarm is due, and the alarm fires once, from the second.
      yield* step("step-reload", () => replies().includes("Epsilon alarm set."))
      expect(yield* tray).toBe("1 wake")
      yield* world.restart
      const reloadedAt = world.now()
      yield* world.until(() => idle() && replies().includes("Woke on epsilon."), 20_000)
      // Room for a second fire, were there one.
      yield* world.advance(4_000)
      const starts = world
        .trace()
        .split("\n")
        .filter((entry) => entry.includes('"kind":"plugin-loading"') && entry.includes(WAKES))
      expect(starts).toHaveLength(2)
      expect(world.stale()).toEqual([])
      const epsilon = fired().filter((message) => message.text.includes("EPSILON"))
      expect(epsilon).toHaveLength(1)
      expect(Number(epsilon[0]?.metadata["firedAt"] ?? 0)).toBeGreaterThan(reloadedAt)
      expect((root().at(-1)?.text ?? "").split("Note: EPSILON").length - 1).toBe(1)
      expect(replies()).toContain("Woke on epsilon.")

      // One message per fire, each a wake or a notice as set.
      expect(fired().map((message) => `${message.metadata["kind"]}/${message.metadata["mode"]}`)).toEqual([
        "alarm/wake",
        "alarm/notify",
        "monitor/wake",
        "alarm/wake",
      ])
    }),
)

seeded("an alarm due while no server ran fires when one starts, and says it went late", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { world, idle, replies, tray, step, root, fired } = yield* boot(seed, downtime)
    yield* step("downtime-fixture", () => replies().includes("Zeta alarm set."))
    expect(yield* tray).toBe("1 wake")

    // The server stops: the plugin closes; 75 s pass, past the alarm and past the minute after which a fire says it went late.
    yield* world.down
    const stopped = world.elapsed()
    yield* world.advance(75_000)
    yield* world.up
    const started = world.elapsed()
    yield* world.until(() => idle() && replies().some((text) => text.startsWith("Woke")), 30_000)

    // The fire came after the start, and its letter says how late and why.
    const late = root().find((request) => request.text.includes("Note: ZETA"))
    expect(late?.at ?? 0).toBeGreaterThanOrEqual(started)
    expect(late?.text).toMatch(
      /It fired \d+m late: no OpenCode server was running at \d{4}-\d\d-\d\dT[\d:.]+Z, so it went when one started\.\nNote: ZETA: look again after the outage/,
    )
    expect(world.asked().some((request) => request.at > stopped && request.at < started)).toBe(false)
    expect(replies()).toContain("Woke late on zeta.")
    expect(yield* tray).toBeUndefined()

    expect(fired()).toHaveLength(1)
    expect(Number(fired()[0]?.metadata["lateMs"] ?? 0)).toBeGreaterThanOrEqual(60_000)
  }),
)
