// A repeating monitor on the simulated host (sim/world.ts), at 20 seeds:
// tests/wake-repeat.test.ts's name and the claims it reads off the model's
// requests and the transcript, moved off real OpenCode (it waited out a
// one-second monitor and two status changes in real time). The plugin is
// `cmd/wake/server.ts`'s `make` on the world's context (sim/plugins.ts), the
// host with `experimental.schedules` on, so the schedule tools are built in
// (the law "a tool a transform adds is offered, and a built-in tool it removes
// is not"); the model answers by scenarios/wake-repeat.ts's rules. The status
// file is the world's shell: `cat` prints what the test last wrote. What only
// the real host shows (the server's command list without `/schedule`, with
// the built-in schedule plugin off as daily writes it) stays in the real file.
import { Effect } from "effect"
import * as Plugins from "../../sim/plugins.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = Seed.runner("cmd/wake/wake-repeat.sim.test.ts")

const WORK = "/scratch/project"
const STATUS = "/scratch/wake-repeat-status.txt"
const READ = `cat ${STATUS}`

/** scenarios/wake-repeat.ts's model: the reply to whatever came last in the conversation. */
const rules: ReadonlyArray<readonly [string, (text: string) => World.Reply]> = [
  ["step-tools", () => World.say("Tools noted.")],
  [
    "step-watch",
    () => World.call("call_monitor_watch", "monitor", { command: READ, intervalSeconds: 1, repeat: "change", timeoutSeconds: 300, note: "WATCH: the status changed" }),
  ],
  ["call_monitor_watch", () => World.say("Watch set.")],
  ["Note: WATCH", (text) => World.say(`Saw fire ${/\(fire (\d+)\)/.exec(text.slice(text.lastIndexOf("Note: WATCH") - 400))?.[1] ?? "?"}.`)],
  [
    "step-stop",
    (text) => World.call("call_stop_watch", "wake_cancel", { id: /Monitor (w[0-9a-z]+) set/.exec(text.slice(text.lastIndexOf("call_monitor_watch")))?.[1] ?? "missing" }),
  ],
  ["call_stop_watch", (text) => World.say(stopped(text))],
]

const stopped = (text: string) => {
  if (text.includes("Cancelled w")) return "Watch stopped."
  return "Watch not stopped."
}

/** The rule whose marker comes last in the conversation answers; with none, nothing to do. */
const reply = (text: string) => {
  const [last] = rules.map(([marker, respond]) => ({ at: text.lastIndexOf(marker), respond })).toSorted((left, right) => right.at - left.at)
  if (last === void 0 || last.at < 0) return World.say("Nothing to do.")
  return last.respond(text)
}

/** An assistant's text reply, alone; nothing for a tool call or another message. */
const replyText = (message: World.Message) => {
  if (message.type === "assistant" && message.text !== "") return [message.text]
  return []
}

/** A wake's fire in the conversation: the synthetic message its letter came in. */
const wakeMessage = (message: World.Message) => {
  if (message.type === "synthetic" && message.metadata["source"] === "wake") return [message]
  return []
}

/** A prompt the owner typed: its text. */
const typed = (message: World.Message) => {
  if (message.type === "user") return [message.text]
  return []
}

seeded("the schedule tools are gone, and a repeating monitor wakes the session once per change with a short notice", ({ seed, expect }) =>
  Effect.gen(function* () {
    const status = { text: "status one\n" }
    /** Each primary request's offered tools, as the model saw them. */
    const offered: Array<ReadonlyArray<string>> = []
    const world = World.make({
      seed,
      schedules: true,
      script: (request) => {
        if (request.kind === "title") return World.say("Repeat fixture")
        if (request.kind === "primary") offered.push(request.tools)
        return reply(request.text)
      },
      processes: (command) => {
        if (command === READ) return { exitCode: 0, stdout: status.text, ms: 10 }
        return World.PROCESSES(command)
      },
    })
    yield* world.load(Plugins.wake(world), { directory: WORK, options: { backstop: "off" } })
    const session = yield* world.session(WORK)
    const idle = () => world.sessions.get(session)?.running !== true
    const replies = () => world.messages(session).flatMap(replyText)
    const step = (text: string, done: () => boolean) => world.prompt(session, text).pipe(Effect.andThen(world.until(() => idle() && done(), 60_000)))
    const replied = (text: string) => () => replies().includes(text)

    // The flag is on, yet no schedule tool is offered on any request; ours are.
    yield* step("step-tools", replied("Tools noted."))

    yield* step("step-watch", replied("Watch set."))
    // Room for the baseline and a few unchanged checks: nothing fires.
    yield* world.advance(3_000)
    const set = replies()

    status.text = "status two\n"
    yield* world.until(() => idle() && replies().includes("Saw fire 1."), 30_000)
    const first = replies()

    status.text = "status three\n"
    yield* world.until(() => idle() && replies().includes("Saw fire 2."), 30_000)
    // Room for a third fire, were the unchanged output to fire again.
    yield* world.advance(3_000)
    const second = replies()

    yield* step("step-stop", () => replies().some((text) => text.startsWith("Watch stopped") || text.startsWith("Watch not stopped")))
    // Past the cancel, a change the monitor would have woken on wakes nothing: it is stopped, not only answered for.
    status.text = "status four\n"
    yield* world.advance(5_000)

    expect(offered.length).toBeGreaterThan(0)
    for (const tools of offered) {
      expect(tools.filter((name) => /schedule_(create|list|pause|resume|delete)/.test(name))).toEqual([])
      expect(tools).toContain("wake_cancel")
    }

    // The baseline fired nothing; each change woke the idle session once, and the unchanged output never again.
    expect(set.some((text) => text.startsWith("Saw fire"))).toBe(false)
    expect(first).toContain("Saw fire 1.")
    expect(second).toContain("Saw fire 2.")
    expect(second).not.toContain("Saw fire 3.")
    expect(replies()).toContain("Watch stopped.")
    expect(replies().filter((text) => text.startsWith("Saw fire"))).toEqual(["Saw fire 1.", "Saw fire 2."])

    const messages = world.messages(session)
    const fired = messages.flatMap(wakeMessage)
    expect(fired.map((message) => [message.type, message.metadata["kind"], message.metadata["outcome"], message.metadata["repeat"], message.metadata["fires"]])).toEqual([
      ["synthetic", "monitor", "matched", "change", 1],
      ["synthetic", "monitor", "matched", "change", 2],
    ])
    expect(fired[0]?.text).toContain("Note: WATCH: the status changed\nOutput (exit 0):\nstatus two")
    expect(fired[1]?.text).toContain("Output (exit 0):\nstatus three")
    for (const message of fired) expect(message.text.length).toBeLessThan(600)
    // No user message carries the note: the only prompts are the three steps typed.
    expect(messages.flatMap(typed).filter((text) => text.includes("WATCH"))).toEqual([])
    expect(messages.flatMap(typed)).toEqual([
      "step-tools",
      "step-watch",
      "step-stop",
    ])
    expect(world.stale()).toEqual([])
  }),
)
