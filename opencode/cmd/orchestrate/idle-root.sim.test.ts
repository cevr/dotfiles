// An idle root with units to move, on the simulated host (sim/world.ts) at 20
// seeds: tests/idle-root.test.ts's server claims under its name, moved off
// real OpenCode (scenarios/idle-root.ts waited out a planner and the owner's
// draft in real time). The orchestrate, status and queue plugins are their
// composition roots on the world (sim/plugins.ts); the status script runs in
// the world's shell and prints the table the skill's status.ts prints for the
// scenario's logs (run `p1`: alpha in implement, beta in plan, gamma merged);
// the orchestrate TUI's draft reports come from a client of the world
// (`draftClient`), as the TUI sends them. The model answers by the scenario's
// rules; its planner works for twenty seconds (a foreground shell) where the
// scenario's waited on a deferred. What the TUI draws (the draft in the
// composer, the sidebar's wait) stays in tests/idle-root.test.ts.
import { QUEUE, Snapshot } from "@dotfiles/opencode-queue/queue"
import { Effect, Option, Schema } from "effect"
import * as Plugins from "../../sim/plugins.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = Seed.runner("cmd/orchestrate/idle-root.sim.test.ts")

const WORK = "/scratch/project"
/** A Wednesday afternoon, so the Sabbath never holds a start. */
const PIN = "2026-11-04T15:00:00Z"
/** Where the status plugin finds the orchestrate skill's status script. */
const STATUS_SCRIPT = "/skills/orchestrate/scripts/status.ts"
/** What `bun status.ts tmp/orchestrate/p1` prints for the scenario's three log.md files. */
const TABLE = [
  "| Unit | State | Round | Since | Cause | Cadence |",
  "| ---- | ----- | ----- | ----- | ----- | ------- |",
  "| alpha | implement | 1 | 2026-11-04T15:00Z | spec.md | 3 ready or 30 min |",
  "| beta | plan | 1 | 2026-11-04T15:00Z | plan.md | 3 ready or 30 min |",
  "| gamma | merged abcdef1 | 1 | 2026-11-04T15:00Z | accept.log | 3 ready or 30 min |",
  "",
].join("\n")

/** The project's runs, and the status script over them, in the world's shell. */
const processes = (command: string): World.Process => {
  if (command === `ls -1 ${WORK}/tmp/orchestrate`) return { exitCode: 0, stdout: "p1\n", ms: 5 }
  if (command === `bun ${STATUS_SCRIPT} ${WORK}/tmp/orchestrate/p1`) return { exitCode: 0, stdout: TABLE, ms: 150 }
  return World.PROCESSES(command)
}

const LINE = "idle with units in plan, implement or verify: alpha, beta; start them or name what you wait on."
const PLANNER = { agent: "planner", description: "planner alpha r1", prompt: "Plan alpha now.", background: true }
/** How long the planner works: a foreground shell that long. */
const PLAN = "sleep 20"
const DRAFT = "half a thought"
const WAIT = { set: [{ id: "owner-review", text: "Owner review of alpha", state: "waiting", detail: "owner" }] }

const STARTED = "Started alpha's planner."
const PLANNED = "Alpha's plan is in."
const NAMED = "Named the wait."
const STILL = "Still waiting on the owner's review."

/** The scenario's model, on the world's request text. */
const model: World.Script = (request) => {
  const s = request.text
  if (request.kind === "title") return World.say("Idle fixture")
  // The planner works until its shell ends, then hands back.
  if (request.agent === "planner" && s.includes("tool call_plan")) return World.say("alpha planned")
  if (request.agent === "planner") return World.call("call_plan", "shell", { command: PLAN })
  if (s.endsWith("user: status-check")) return World.say(STILL)
  if (s.includes(LINE) && s.includes("call_wait")) return World.say(NAMED)
  if (s.includes(LINE)) return World.call("call_wait", "queue", WAIT)
  // The planner's notice.
  if (s.includes("alpha planned")) return World.say(PLANNED)
  if (!s.includes("call_start")) return World.call("call_start", "subagent", PLANNER)
  return World.say(STARTED)
}

/** What the root's state is at each of the scenario's frames. */
interface Moment {
  /** The nudges the root holds. */
  readonly nudges: number
  /** Whether it said `text` by then. */
  readonly said: (text: string) => boolean
}

/** The scenario, on one world: each moment the real run saved a frame at, the root's queue, and its requests. */
const boot = (seed: number) =>
  Effect.gen(function* () {
    const world = World.make({ seed, start: Date.parse(PIN), script: model, processes })
    yield* world.load(Plugins.orchestrate(), { directory: WORK, options: { now: PIN } })
    yield* world.load(Plugins.status(world), { directory: WORK, options: { statusScript: STATUS_SCRIPT } })
    yield* world.load(Plugins.queue(), { directory: WORK })
    const tui = Plugins.draftClient(world)
    const root = yield* world.session(WORK)
    const said = (text: string) => world.messages(root).some((message) => message.type === "assistant" && message.text === text)
    const moment = (): Moment => {
      const texts = new Set(
        world
          .messages(root)
          .filter((message) => message.type === "assistant")
          .map((message) => message.text),
      )
      return { nudges: world.messages(root).filter((message) => message.type === "synthetic" && message.text === LINE).length, said: (text) => texts.has(text) }
    }
    const planning = () => [...world.sessions.values()].some((session) => Option.isSome(session.parentID) && session.running)

    yield* tui.show(root, "")
    yield* world.prompt(root, "idle-fixture")
    yield* world.until(() => said(STARTED), 60_000)
    // Long enough for a nudge to land, were the running planner not holding it.
    yield* world.advance(3_000)
    const started = { ...moment(), planning: planning() }

    yield* tui.show(root, DRAFT)
    yield* world.advance(1_000)
    yield* world.until(() => said(PLANNED), 60_000)
    yield* world.advance(4_000)
    const drafted = moment()

    yield* tui.show(root, "")
    yield* world.until(() => said(NAMED), 60_000)
    yield* world.advance(3_000)
    const nudged = moment()
    const queue = Schema.decodeUnknownSync(Snapshot)(yield* world.rpc(QUEUE.id, "get", { sessionID: root }))

    yield* world.prompt(root, "status-check")
    yield* world.until(() => said(STILL), 60_000)
    yield* world.advance(3_000)
    const final = moment()
    const requests = world.asked().filter((asked) => asked.sessionID === root && asked.kind === "primary")
    return { started, drafted, nudged, queue, final, requests }
  })

seeded("is steered once, after its planner ends and the owner's draft clears, and names its wait", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { started, drafted, nudged, queue, final, requests } = yield* boot(seed)

    // Idle with its planner running: no nudge.
    expect(started.said(STARTED)).toBe(true)
    expect(started.planning).toBe(true)
    expect(started.nudges).toBe(0)

    // Idle again after the planner's notice, with a draft in the composer: no nudge.
    expect(drafted.said(PLANNED)).toBe(true)
    expect(drafted.nudges).toBe(0)

    // The draft cleared: one nudge, answered by a named wait the sidebar reads.
    expect(nudged.nudges).toBe(1)
    expect(nudged.said(NAMED)).toBe(true)
    expect(queue.items.map((item) => ({ text: item.text, state: item.state }))).toEqual([{ text: "Owner review of alpha", state: "waiting" }])

    // Idle after the nudge, and after the owner's next prompt, with the wait named: no second nudge.
    expect(final.said(STILL)).toBe(true)
    expect(final.nudges).toBe(1)
    expect(requests.filter((request) => request.text.endsWith(`synthetic: ${LINE}`))).toHaveLength(1)
  }),
)
