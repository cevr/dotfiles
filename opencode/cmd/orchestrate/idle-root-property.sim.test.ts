// A generated property of the idle-root rules (mods/orchestrate/idle.ts), on
// the simulated host at 20 seeds: the orchestrate, status and queue plugins
// on the world, the status script printing run `p1` (alpha in implement, beta
// in plan), and the orchestrate TUI's draft reports from a client of the
// world. The seed chooses up to 14 commands: the owner's prompt, a planner
// start (it works 1 to 40 s), a draft shown or cleared in the composer, a
// wait named or cleared in the root's queue, and the clock moving on.
//
// Over the whole run, the root is nudged only once it owns the run, never
// while the owner's draft shows, a planner of its runs or a named wait holds
// it, and at most once between two inputs (the owner's prompt, a notice).
// Then, with nothing holding it, the owner's next prompt brings exactly one
// nudge.
import { Effect, Option } from "effect"
import * as Plugins from "../../sim/plugins.ts"
import { below, generator } from "../../sim/runtime.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = Seed.runner("cmd/orchestrate/idle-root-property.sim.test.ts")

const WORK = "/scratch/project"
/** Wednesday 4 November 2026, 10:00 in Knowlton: 14 commands at most a minute apart stay clear of the Sabbath. */
const PIN = "2026-11-04T15:00:00Z"
const STATUS_SCRIPT = "/skills/orchestrate/scripts/status.ts"
const TABLE = [
  "| Unit | State | Round | Since | Cause | Cadence |",
  "| ---- | ----- | ----- | ----- | ----- | ------- |",
  "| alpha | implement | 1 | 2026-11-04T15:00Z | spec.md | 3 ready or 30 min |",
  "| beta | plan | 1 | 2026-11-04T15:00Z | plan.md | 3 ready or 30 min |",
  "",
].join("\n")
const LINE = "idle with units in plan, implement or verify: alpha, beta; start them or name what you wait on."

const processes = (command: string): World.Process => {
  if (command === `ls -1 ${WORK}/tmp/orchestrate`) return { exitCode: 0, stdout: "p1\n", ms: 5 }
  if (command === `bun ${STATUS_SCRIPT} ${WORK}/tmp/orchestrate/p1`) return { exitCode: 0, stdout: TABLE, ms: 150 }
  return World.PROCESSES(command)
}

const UNITS = ["alpha", "beta"] as const

/** What the owner does: each prompt is the root's input, `show` is what the composer holds. */
type Command =
  | { readonly type: "prompt"; readonly text: string }
  | { readonly type: "show"; readonly composer: string }
  | { readonly type: "advance"; readonly ms: number }

const commandOf = (pick: number, random: ReturnType<typeof generator>): Command => {
  if (pick < 2) return { type: "prompt", text: "go" }
  if (pick < 4) return { type: "prompt", text: `start ${UNITS[below(random, UNITS.length)] ?? "alpha"} ${1 + below(random, 40)}` }
  if (pick < 6) return { type: "show", composer: ["a draft", ""][below(random, 2)] ?? "" }
  if (pick < 7) return { type: "prompt", text: ["wait", "unwait"][below(random, 2)] ?? "wait" }
  return { type: "advance", ms: 1 + below(random, 60_000) }
}

const commandsOf = (seed: number): ReadonlyArray<Command> => {
  const random = generator(`idle-root:${seed}`)
  return Array.from({ length: 4 + below(random, 11) }, () => commandOf(below(random, 9), random))
}

/** The last line of a request's text: what the model answers. */
const lastLine = (text: string) => text.slice(text.lastIndexOf("\n") + 1)

/** A planner's work: a foreground shell as long as its prompt says. */
const planner = (text: string) => {
  if (text.includes("tool call_plan")) return World.say("planned")
  const seconds = Option.getOrElse(Option.fromNullishOr(/for (\d+) s/.exec(text)?.[1]), () => "1")
  return World.call("call_plan", "shell", { command: `sleep ${seconds}` })
}

/**
 * The root's model: `start <unit> <s>` starts a planner of the unit that works `s` seconds, `wait` names a wait and
 * `unwait` clears it; anything else (a prompt, a notice, the nudge, a tool's answer) it answers in a line.
 */
const model: World.Script = (request) => {
  if (request.kind === "title") return World.say("Idle property")
  if (request.agent === "planner") return planner(request.text)
  const last = lastLine(request.text)
  const id = `${request.text.split("\n").length}`
  const start = /^user: start (\w+) (\d+)$/.exec(last)
  if (start) return World.call(`call_start_${id}`, "subagent", { agent: "planner", description: `planner ${start[1]} r1`, prompt: `Plan ${start[1]} for ${start[2]} s.`, background: true })
  if (last === "user: wait") return World.call(`call_wait_${id}`, "queue", { set: [{ id: "owner-review", text: "Owner review", state: "waiting" }] })
  if (last === "user: unwait") return World.call(`call_unwait_${id}`, "queue", { set: [] })
  return World.say("ok")
}

/** A span of virtual time. */
interface Span {
  readonly from: number
  readonly to: number
}

const within = (at: number, span: Span) => at > span.from && at < span.to

/** The spans a state held, from when it turned on and off; one still on ends at `end`. */
const spansOf = (toggles: ReadonlyArray<{ readonly at: number; readonly on: boolean }>, end: number): ReadonlyArray<Span> => {
  const spans: Array<Span> = []
  let since = Option.none<number>()
  for (const toggle of toggles) {
    if (toggle.on && Option.isNone(since)) since = Option.some(toggle.at)
    if (!toggle.on && Option.isSome(since)) {
      spans.push({ from: since.value, to: toggle.at })
      since = Option.none()
    }
  }
  return [...spans, ...Option.toArray(Option.map(since, (from) => ({ from, to: end })))]
}

/** How many nudges came between each two inputs (the owner's prompts, the notices). */
const nudgesBetween = (messages: ReadonlyArray<World.Message>) => {
  const between: Array<number> = [0]
  for (const message of messages) {
    const nudge = message.type === "synthetic" && message.text === LINE
    if (message.type === "user" || (message.type === "synthetic" && !nudge)) between.push(0)
    if (nudge) between.push((between.pop() ?? 0) + 1)
  }
  return between
}

const run = (seed: number) =>
  Effect.gen(function* () {
    const world = World.make({ seed, start: Date.parse(PIN), script: model, processes })
    yield* world.load(Plugins.orchestrate(), { directory: WORK, options: { now: PIN } })
    yield* world.load(Plugins.status(world), { directory: WORK, options: { statusScript: STATUS_SCRIPT } })
    yield* world.load(Plugins.queue(), { directory: WORK })
    const tui = Plugins.draftClient(world)
    const root = yield* world.session(WORK)
    const rested = () => Option.match(Option.fromNullishOr(world.sessions.get(root)), { onNone: () => true, onSome: (session) => !session.running && session.inbox.length === 0 })
    const children = () => [...world.sessions.values()].filter((session) => Option.contains(session.parentID, root))
    const shown: Array<{ readonly at: number; readonly on: boolean }> = []
    const apply = (command: Command) => {
      if (command.type === "prompt") return world.prompt(root, command.text).pipe(Effect.andThen(world.until(rested, 60_000)), Effect.ignore)
      if (command.type === "advance") return world.advance(command.ms)
      shown.push({ at: world.now(), on: command.composer !== "" })
      return tui.show(root, command.composer)
    }

    for (const command of commandsOf(seed)) yield* apply(command)
    // Nothing holds it now: the draft cleared, the wait cleared, every planner done.
    yield* apply({ type: "show", composer: "" })
    yield* apply({ type: "prompt", text: "unwait" })
    yield* world.until(() => children().every((child) => !child.running), 120_000).pipe(Effect.ignore)
    yield* world.until(rested, 60_000).pipe(Effect.ignore)
    yield* world.advance(10_000)
    const before = world.now()
    yield* apply({ type: "prompt", text: "go" })
    yield* world.advance(10_000)

    const messages = world.messages(root)
    const nudges = messages.filter((message) => message.type === "synthetic" && message.text === LINE).map((message) => message.created)
    // Each planner's span: from its first message to its last.
    const planners = children().flatMap((child): ReadonlyArray<Span> => {
      const times = world.messages(child.id).map((message) => message.created)
      return Option.toArray(Option.map(Option.liftPredicate(times, (all) => all.length > 0), (all) => ({ from: Math.min(...all), to: Math.max(...all) })))
    })
    // The named wait's spans, from the queue tool's answers.
    const queued = messages
      .filter((message) => message.type === "tool")
      .filter((message) => message.name === "queue")
      .map((message) => ({ at: message.created, on: message.callID.startsWith("call_wait_") }))
    return {
      nudges,
      planners,
      owned: Math.min(...planners.map((span) => span.from)),
      drafts: spansOf(shown, world.now()),
      waits: spansOf(queued, world.now()),
      between: nudgesBetween(messages),
      last: nudges.filter((at) => at > before).length,
      owns: Number(planners.length > 0),
    }
  })

seeded("an idle root is nudged at most once per idle period, only when it owns a run and nothing holds it, and always then", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { nudges, planners, owned, drafts, waits, between, last, owns } = yield* run(seed)
    expect(nudges.filter((at) => at < owned)).toEqual([])
    expect(nudges.filter((at) => drafts.some((span) => within(at, span)))).toEqual([])
    expect(nudges.filter((at) => planners.some((span) => within(at, span)))).toEqual([])
    expect(nudges.filter((at) => waits.some((span) => within(at, span)))).toEqual([])
    expect(between.filter((count) => count > 1)).toEqual([])
    expect(last).toBe(owns)
  }),
)
