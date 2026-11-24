// The `principles` tool on the simulated host (sim/world.ts): the real orchestrate plugin (sim/plugins.ts), loaded
// with its `skill` option at this checkout's orchestrate skill, so the tool reads this checkout's principle-* skills
// from disk. A root and a subagent each call it; every answer is checked against the skill files themselves.
import { file, fileURLToPath, Glob } from "bun"
import { Array as Arr, Effect, Option, Order } from "effect"
import * as Plugins from "../../sim/plugins.ts"
import { simulationRunner } from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = simulationRunner("cmd/orchestrate/principles.sim.test.ts")

const WORK = "/scratch/project"
/** A Wednesday afternoon: no Sabbath rest refuses the calls. */
const PIN = "2026-11-04T15:00:00Z"
/**
 * This checkout's skills, as the test reads them itself: the directory (the tool reads `<dirname of the skill
 * option>/principle-*\/SKILL.md`), its principle folders by name, and one principle's file.
 */
const disk = Effect.gen(function* () {
  const skills = fileURLToPath(new URL("../../../skills", import.meta.url))
  const onDisk = Arr.sort(
    Array.from(new Glob("principle-*/SKILL.md").scanSync({ cwd: skills }), (found) => found.slice(0, found.indexOf("/"))),
    Order.String,
  )
  const subtract = yield* Effect.promise(() => file(`${skills}/principle-subtract-before-you-add/SKILL.md`).text())
  return { skills, onDisk, subtract }
})

/** A principles call's input. */
interface Input {
  readonly action: string
  readonly query?: string
  readonly name?: string
}

/** A tool's answer in a session. */
type ToolMessage = Extract<World.Message, { readonly type: "tool" }>

const boot = Effect.fn("Principles.boot")(function* (seed: number, skills: string) {
  /** The call each session makes on its next turn. */
  const pending = new Map<string, Input>()
  /** The tools each session's last request offered, as its agent's permissions leave them. */
  const offered = new Map<string, ReadonlyArray<string>>()
  // The model: a session with a call pending makes it, then stops.
  const script: World.Script = (request) => {
    if (request.kind !== "primary") return World.say("principles")
    offered.set(request.sessionID, request.tools)
    return Option.match(Option.fromNullishOr(pending.get(request.sessionID)), {
      onNone: () => World.say("done"),
      onSome: (input) => {
        pending.delete(request.sessionID)
        return World.call(`call_${request.sessionID}`, "principles", { ...input })
      },
    })
  }
  const world = World.make({ seed, start: Date.parse(PIN), script })
  yield* world.load(Plugins.orchestrate(), { directory: WORK, options: { now: PIN, skill: `${skills}/orchestrate` } })
  const idle = (sessionID: string) => Option.exists(Option.fromNullishOr(world.sessions.get(sessionID)), (session) => !session.running && session.inbox.length === 0)
  /** One call from `sessionID`: the tool's answer and whether it failed. */
  const call = Effect.fn("Principles.call")(function* (sessionID: string, input: Input) {
    const from = world.messages(sessionID).length
    pending.set(sessionID, input)
    yield* world.prompt(sessionID, "call the principles tool")
    yield* world.until(() => idle(sessionID), 60_000)
    const answered = Arr.findFirst(world.messages(sessionID).slice(from), (message): message is ToolMessage => message.type === "tool")
    return Option.match(answered, {
      onNone: () => ({ text: "", error: true }),
      onSome: (tool) => ({ text: tool.output, error: tool.error }),
    })
  })
  return { world, call, offered }
})

seeded("list answers every principle-* skill with its 'Apply when' description, to a root and to a subagent", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { skills, onDisk } = yield* disk
    const run = yield* boot(seed, skills)
    const root = yield* run.world.session(WORK)
    const child = yield* run.world.session(WORK, { parentID: root, agent: "implementor" })
    for (const session of [root, child]) {
      const listed = yield* run.call(session, { action: "list" })
      expect(listed.error).toBe(false)
      const rows = listed.text.split("\n").filter((line) => line.startsWith("principle-"))
      expect(rows.map((row) => row.slice(0, row.indexOf(":")))).toEqual(onDisk)
      for (const row of rows) expect(row).toMatch(/^principle-[a-z0-9-]+: Apply /)
      // Offered, not only callable: the role agent's deny-all permissions allow it (scripts/agents.ts).
      expect(run.offered.get(session)).toContain("principles")
    }
  }),
)

seeded("search finds a principle by a phrase from its body, and shows the line", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { skills } = yield* disk
    const run = yield* boot(seed, skills)
    const root = yield* run.world.session(WORK)
    const found = yield* run.call(root, { action: "search", query: "two workers writing their own field" })
    expect(found.error).toBe(false)
    const lines = found.text.split("\n")
    expect(lines.find((line) => line.startsWith("principle-"))).toStartWith("principle-separate-before-serializing-shared-state:")
    expect(lines.some((line) => line.startsWith("  > ") && line.toLowerCase().includes("two workers writing their own field"))).toBe(true)
  }),
)

seeded("search finds nothing-is-hard first or second by each of its trigger words, and list shows its Apply-when line", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { skills } = yield* disk
    const run = yield* boot(seed, skills)
    const root = yield* run.world.session(WORK)
    const NAME = "principle-nothing-is-hard"
    for (const query of ["hard", "effort", "defer", "later", "first cut", "out of scope", "recommend", "workaround", "blocked"]) {
      const found = yield* run.call(root, { action: "search", query })
      expect(found.error).toBe(false)
      const ranked = found.text.split("\n").filter((line) => line.startsWith("principle-")).map((line) => line.slice(0, line.indexOf(":")))
      expect({ query, top: ranked.slice(0, 2) }).toEqual({ query, top: expect.arrayContaining([NAME]) })
    }
    const listed = yield* run.call(root, { action: "list" })
    expect(listed.text.split("\n").find((line) => line.startsWith(`${NAME}:`))).toStartWith(`${NAME}: Apply when effort is about to decide`)
  }),
)

seeded("get answers the skill file's full text, by either name", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { skills, subtract } = yield* disk
    const run = yield* boot(seed, skills)
    const root = yield* run.world.session(WORK)
    for (const name of ["subtract-before-you-add", "principle-subtract-before-you-add"]) {
      const got = yield* run.call(root, { action: "get", name })
      expect(got.error).toBe(false)
      expect(got.text).toContain(subtract.trim())
    }
  }),
)

seeded("get of an unknown name fails and names the closest principle first", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { skills } = yield* disk
    const run = yield* boot(seed, skills)
    const root = yield* run.world.session(WORK)
    const got = yield* run.call(root, { action: "get", name: "subtract-before-add" })
    expect(got.error).toBe(true)
    expect(got.text).toContain("no principle subtract-before-add")
    expect(got.text).toContain("Closest: principle-subtract-before-you-add,")
  }),
)
