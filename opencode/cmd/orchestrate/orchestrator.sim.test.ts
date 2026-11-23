// @reads all
// @reads-reason computed read at mods/guard/filesystem/repo-roots.ts: return yield* Effect.tryPromise({ try: () => stat(join(path, ".git")), catch: (cause) => cause
// The orchestrator agent on the simulated host (sim/world.ts): the real orchestrate plugin (sim/plugins.ts) defines
// it from build, makes it the default a new session opens with, and puts its section after build's prompt in its own
// requests only. The config's `default_agent` (the world's `defaultAgent`, applied after every plugin as the fork's
// config agent plugin runs last) and a later plugin's override of the agent still win.
import { Plugin } from "@opencode/plugin/effect"
import { Effect, Option } from "effect"
import { WINDOW } from "@dotfiles/opencode-orchestrate/compaction"
import { definitions, ORCHESTRATOR, orchestrator, ROLES } from "@dotfiles/opencode-orchestrate/role"
import * as Plugins from "../../sim/plugins.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = Seed.runner("cmd/orchestrate/orchestrator.sim.test.ts")

const WORK = "/scratch/project"
/** A Wednesday afternoon: no Sabbath rest holds a request. */
const PIN = "2026-11-04T15:00:00Z"
/** The skill's rule the section carries word for word. */
const RULE = "**Never block on the shell.**"
/** How many times a request's system carries the orchestrator's section: one, never two. */
const sections = (request: World.Request) => request.system.split(orchestrator.section).length - 1

/** A world with the orchestrate plugin loaded, recording each request the model gets. */
const boot = Effect.fn("Orchestrator.boot")(function* (seed: number, host: { readonly defaultAgent?: string } = {}, after: ReadonlyArray<Plugin.Plugin> = []) {
  const requests: Array<World.Request> = []
  const world = World.make({
    seed,
    start: Date.parse(PIN),
    ...host,
    script: (request) => {
      requests.push(request)
      return World.say("done")
    },
  })
  yield* world.load(Plugins.orchestrate(), { directory: WORK, options: { now: PIN } })
  for (const plugin of after) yield* world.load(plugin, { directory: WORK })
  const idle = (sessionID: string) => Option.exists(Option.fromNullishOr(world.sessions.get(sessionID)), (session) => !session.running && session.inbox.length === 0)
  /** One prompt to `sessionID`, answered: the requests it made (a child's report also wakes its parent, which is not it). */
  const turn = Effect.fn("Orchestrator.turn")(function* (sessionID: string) {
    const from = requests.length
    yield* world.prompt(sessionID, "hello")
    yield* world.until(() => idle(sessionID), 60_000)
    return requests.slice(from).filter((request) => request.sessionID === sessionID)
  })
  const agent = (id: string) => world.agents(WORK).find((candidate) => candidate.id === id)
  return { world, requests, turn, agent }
})

seeded("the orchestrator is a primary agent, the default, with build's permissions and the 400k window", ({ seed, expect }) =>
  Effect.gen(function* () {
    const run = yield* boot(seed)
    const agents = run.world.agents(WORK)
    const first = agents[0]
    expect(String(first?.id)).toBe(ORCHESTRATOR)
    expect(first?.mode).toBe("primary")
    expect(first?.hidden).toBe(false)
    expect(first?.description).toBe(orchestrator.description)
    expect(first?.request.settings["compactionWindow"]).toBe(WINDOW)
    expect(WINDOW).toBe(400_000)
    const build = yield* Effect.fromOption(Option.fromNullishOr(run.agent("build")))
    expect(first?.permissions).toEqual(build.permissions)
    expect(first?.system).toBe(build.system)
    // The roles stay as their definitions make them.
    for (const role of ROLES) {
      const defined = run.agent(role)
      expect([role, defined?.mode, defined?.description, defined?.system]).toEqual([role, "subagent", definitions[role].description, definitions[role].system])
    }
  }),
)

seeded("a new session runs as the orchestrator with its section after build's prompt; a subagent and a build session get none", ({ seed, expect }) =>
  Effect.gen(function* () {
    const run = yield* boot(seed)
    const root = yield* run.world.session(WORK)
    const asked = yield* run.turn(root)
    expect(asked.map((request) => [request.kind, request.agent])).toContainEqual(["primary", ORCHESTRATOR])
    for (const request of asked.filter((request) => request.kind === "primary")) {
      expect(sections(request)).toBe(1)
      expect(request.system).toContain(RULE)
    }
    // The summary request carries the same section, once, so it keeps the turn's cached prefix.
    const from = run.requests.length
    yield* run.world.compact(root)
    yield* run.world.until(() => run.requests.slice(from).some((request) => request.kind === "compaction"), 60_000)
    const summary = yield* Effect.fromOption(Option.fromNullishOr(run.requests.slice(from).find((request) => request.kind === "compaction")))
    expect([summary.agent, sections(summary)]).toEqual([ORCHESTRATOR, 1])
    // And so does each turn's request after the compaction.
    const after = (yield* run.turn(root)).filter((request) => request.kind === "primary")
    expect(after.length).toBeGreaterThan(0)
    for (const request of after) expect([request.agent, sections(request)]).toEqual([ORCHESTRATOR, 1])

    const child = yield* run.world.session(WORK, { parentID: root, agent: "implementor" })
    const childAsked = yield* run.turn(child)
    expect(childAsked.length).toBeGreaterThan(0)
    for (const request of childAsked) {
      expect(request.agent).toBe("implementor")
      expect(request.system).not.toContain(RULE)
    }
    // A session open on build (one made before the default changed) keeps it.
    const open = yield* run.world.session(WORK, { agent: "build" })
    const openAsked = yield* run.turn(open)
    expect(openAsked.length).toBeGreaterThan(0)
    for (const request of openAsked) {
      expect(request.agent).toBe("build")
      expect(request.system).not.toContain(RULE)
    }
  }),
)

seeded("the config's default_agent wins: a new session runs as build, without the section", ({ seed, expect }) =>
  Effect.gen(function* () {
    const run = yield* boot(seed, { defaultAgent: "build" })
    expect(String(run.world.agents(WORK)[0]?.id)).toBe("build")
    expect(run.agent(ORCHESTRATOR)?.mode).toBe("primary")
    const root = yield* run.world.session(WORK)
    const asked = yield* run.turn(root)
    expect(asked.length).toBeGreaterThan(0)
    for (const request of asked) {
      expect(request.agent).toBe("build")
      expect(request.system).not.toContain(RULE)
    }
  }),
)

/** A later definition of the orchestrator, as an agent file in the owner's config makes one. */
const override = Plugin.define({
  id: "fixture.orchestrator-file",
  effect: (ctx) =>
    ctx.agent.transform((editor) =>
      editor.update(ORCHESTRATOR, (agent) => {
        agent.description = "the owner's orchestrator"
        agent.permissions.push({ action: "webfetch", resource: "*", effect: "deny" })
      }),
    ),
})

seeded("an agent defined after the plugin overrides the orchestrator's fields, and it stays the default", ({ seed, expect }) =>
  Effect.gen(function* () {
    const run = yield* boot(seed, {}, [override])
    const first = run.world.agents(WORK)[0]
    expect(String(first?.id)).toBe(ORCHESTRATOR)
    expect(first?.description).toBe("the owner's orchestrator")
    expect(first?.permissions.at(-1)).toEqual({ action: "webfetch", resource: "*", effect: "deny" })
    const root = yield* run.world.session(WORK)
    const asked = yield* run.turn(root)
    expect(asked.some((request) => request.agent === ORCHESTRATOR && request.system.includes(RULE))).toBe(true)
  }),
)
