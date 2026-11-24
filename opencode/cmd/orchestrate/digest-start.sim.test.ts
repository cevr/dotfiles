// @reads all
// @reads-reason computed read at mods/guard/filesystem/repo-roots.ts: return yield* Effect.tryPromise({ try: () => stat(join(path, ".git")), catch: (cause) => cause
// A step's Start line in the digest, on the simulated host (sim/world.ts): the orchestrate plugin writes it only once
// the host runs the subagent call, with the child's session. A call refused after the plugin's own `execute.before`
// (by a later plugin's hook, as the fork's registry refuses a tool the kernel does not offer) starts no agent, so it
// writes no Start: the page never shows an agent that never ran.
import { describe } from "bun:test"
import { Plugin, Tool } from "@opencode/plugin/effect"
import { Effect, Option, Ref } from "effect"
import { decodeLine } from "@dotfiles/opencode-digest/event"
import * as MemoryDigest from "@dotfiles/opencode-digest/memory/log"
import * as Plugins from "../../sim/plugins.ts"
import { simulationRunner } from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = simulationRunner("cmd/orchestrate/digest-start.sim.test.ts")

const WORK = "/scratch/project"
const STEP = { agent: "implementor", description: "implementor demo r1", prompt: "Build demo.", background: true }
const STARTED = "Started demo's implementor."
const REFUSAL = "No tool named subagent is currently available."

/** A plugin loaded after orchestrate whose `execute.before` refuses every subagent call. */
const refuser = Plugin.define({
  id: "test.refuse-subagent",
  effect: (ctx) =>
    ctx.tool.hook("execute.before", (event) => Effect.when(Effect.fail(new Tool.Error({ message: REFUSAL })), Effect.succeed(event.tool === "subagent")).pipe(Effect.asVoid)),
})

const model: World.Script = (request) => {
  if (request.kind === "title") return World.say("Start fixture")
  if (request.agent === "implementor") return World.say("implementor demo r1: ready /nonexistent/loop-probe-x/round-1-request.md")
  if (!request.text.includes("call_start")) return World.call("call_start", "subagent", STEP)
  return World.say(STARTED)
}

/** The Start lines the digest holds once the root's turn ended, with or without a refusing plugin. */
const startsOf = (seed: number, refused: boolean) =>
  Effect.gen(function* () {
    const memory = MemoryDigest.empty()
    const world = World.make({ seed, script: model })
    yield* world.load(Plugins.digest(memory), { directory: WORK })
    yield* world.load(Plugins.orchestrate(), { directory: WORK })
    if (refused) yield* world.load(refuser, { directory: WORK })
    const root = yield* world.session(WORK)
    yield* world.prompt(root, "start-fixture")
    yield* world.until(() => world.messages(root).some((message) => message.type === "assistant" && message.text === STARTED), 60_000)
    yield* world.advance(10_000)
    const children = [...world.sessions.values()].flatMap((session) => Option.toArray(Option.as(Option.filter(session.parentID, (parent) => parent === root), session.id)))
    const starts = (yield* Ref.get(memory.lines)).flatMap((line) =>
      Option.toArray(Option.flatMap(decodeLine(line), (event) => Option.liftPredicate(event, (each) => each._tag === "Start"))),
    )
    return { root, children, starts }
  })

describe("a step's Start line", () => {
  seeded("an accepted subagent call writes one Start, under its root, naming the child it started", ({ seed, expect }) =>
    Effect.gen(function* () {
      const { root, children, starts } = yield* startsOf(seed, false)
      expect(children).toHaveLength(1)
      expect(starts.map((start) => start._tag === "Start" && [start.root, start.session, start.role, start.unit, start.round])).toEqual([[root, children[0], "implementor", "demo", 1]])
    }),
  )

  seeded("a subagent call refused after the plugin's hook starts nothing and writes no Start", ({ seed, expect }) =>
    Effect.gen(function* () {
      const { children, starts } = yield* startsOf(seed, true)
      expect(children).toEqual([])
      expect(starts).toEqual([])
    }),
  )
})
