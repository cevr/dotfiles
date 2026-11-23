// @reads all
// @reads-reason computed read at mods/guard/filesystem/repo-roots.ts: return yield* Effect.tryPromise({ try: () => stat(join(path, ".git")), catch: (cause) => cause
// The orchestrate plugin's question tools on the simulated host, at the
// file's seeds: by default it adds `ask_orchestrator` and `answer_subagent`,
// and its agents' swap leaves a root (a primary agent) `ask_user_async` and a
// subagent (the `worker` role) `ask_orchestrator`, as the tools each request
// offers; `subagents: "owner"` adds neither tool and swaps nothing; an option
// that does not decode fails the plugin's start, naming it. Below the plugin,
// the nudge's words over a memory `Look`, and which ask tool a session has.
import { Cause, Effect, Exit, Option } from "effect"
import { ASK_ORCHESTRATOR, ASK_OWNER, HAS_ORCHESTRATOR, letterNudge, NO_ORCHESTRATOR, PRINCIPLES_NAMED, receipt, toolFor, wrongTool } from "@dotfiles/opencode-orchestrate/asking"
import { documents, type Look } from "@dotfiles/opencode-orchestrate/documents"
import * as Plugins from "../../sim/plugins.ts"
import type { JsonObject } from "../../sim/runtime.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = Seed.runner("cmd/orchestrate/asking.sim.test.ts")

const DIRECTORY = "/scratch/asking"
const PIN = "2026-11-18T15:00:00Z"
const QUESTION_TOOLS = ["ask_user_async", "ask_orchestrator", "answer_subagent"]

/** The question tools a root's request and its worker's request offer, with the orchestrate plugin's `options`. */
const offered = (seed: number, options: JsonObject) =>
  Effect.gen(function* () {
    const tools = new Map<string, ReadonlyArray<string>>()
    const world = World.make({
      seed,
      start: Date.parse(PIN),
      script: (request) => {
        tools.set(request.sessionID, request.tools.filter((name) => QUESTION_TOOLS.includes(name)).toSorted())
        return World.say("ok")
      },
    })
    yield* world.load(Plugins.questions, { directory: DIRECTORY })
    yield* world.load(Plugins.orchestrate(), { directory: DIRECTORY, options: { now: PIN, ...options } })
    const root = yield* world.session(DIRECTORY)
    const worker = yield* world.session(DIRECTORY, { parentID: root, title: "worker probe", agent: "worker" })
    yield* world.prompt(root, "go")
    yield* world.prompt(worker, "go")
    yield* world.advance(5_000)
    return { root: tools.get(root) ?? [], worker: tools.get(worker) ?? [] }
  })

seeded("by default a root asks the owner and a worker its orchestrator; both may answer a subagent", ({ seed, expect }) =>
  Effect.gen(function* () {
    expect(yield* offered(seed, {})).toEqual({ root: ["answer_subagent", "ask_user_async"], worker: ["answer_subagent", "ask_orchestrator"] })
  }),
)

seeded('with subagents: "owner" neither tool is added and both ask the owner', ({ seed, expect }) =>
  Effect.gen(function* () {
    expect(yield* offered(seed, { subagents: "owner" })).toEqual({ root: ["ask_user_async"], worker: ["ask_user_async"] })
  }),
)

seeded("an option that does not decode fails the plugin's start, naming it", ({ seed, expect }) =>
  Effect.gen(function* () {
    const world = World.make({ seed, start: Date.parse(PIN), script: () => World.say("ok") })
    const exit = yield* Effect.exit(world.load(Plugins.orchestrate(), { directory: DIRECTORY, options: { now: PIN, subagents: "nobody" } }))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(Exit.match(exit, { onFailure: Cause.pretty, onSuccess: () => "" })).toContain("subagents")
  }),
)

// The nudge a question carries, both ways (the subagent's receipt and the letter its orchestrator reads), over a
// memory `Look`: it names the documents that exist and only those, and its words about the ledger stand either way.
const REPO = "/work/app"
const PACKAGE = `${REPO}/packages/api`
const LEDGER = "the run's ledger (plan.md"
const PUT = { ok: true, opened: [{ id: "q1", question: "Which port?", assume: "8080" }] }

/** A file system holding exactly `paths`. */
const memory = (paths: ReadonlyArray<string>): Look => ({ exists: (path) => Effect.succeed(paths.includes(path)) })

seeded("the nudge names NORTH_STAR.md and AGENTS.md when they exist, and the principles by their tool, in the receipt and the letter", ({ expect }) =>
  Effect.gen(function* () {
    const look = memory([`${REPO}/.git`, `${REPO}/NORTH_STAR.md`, `${PACKAGE}/AGENTS.md`])
    const paths = yield* documents(look, PACKAGE)
    expect(paths).toEqual([`${PACKAGE}/AGENTS.md`, `${REPO}/NORTH_STAR.md`])
    for (const words of [receipt(PUT, paths), letterNudge(paths, Option.none()), letterNudge(paths, Option.some("ses_root"))]) {
      for (const path of paths) expect(words).toContain(path)
      expect(words).toContain(LEDGER)
      expect(words).toContain(PRINCIPLES_NAMED)
    }
  }),
)

seeded("with none of them the nudge names no path, and its words about the principles and the ledger still stand", ({ expect }) =>
  Effect.gen(function* () {
    const paths = yield* documents(memory([]), PACKAGE)
    expect(paths).toEqual([])
    for (const words of [receipt(PUT, paths), letterNudge(paths, Option.none())]) {
      expect(words).not.toContain("/")
      expect(words).toContain(LEDGER)
      expect(words).toContain(PRINCIPLES_NAMED)
    }
  }),
)

seeded("the letter says whom to ask upward, and the wrong ask tool is refused with why", ({ expect }) =>
  Effect.sync(() => {
    expect(letterNudge([], Option.none())).toContain(ASK_OWNER)
    expect(letterNudge([], Option.some("ses_root"))).toContain(ASK_ORCHESTRATOR)
    expect([toolFor(Option.none()), toolFor(Option.some("ses_root"))]).toEqual([ASK_OWNER, ASK_ORCHESTRATOR])
    expect(wrongTool(ASK_ORCHESTRATOR, Option.none())).toEqual(Option.some(NO_ORCHESTRATOR))
    expect(wrongTool(ASK_OWNER, Option.some("ses_root"))).toEqual(Option.some(HAS_ORCHESTRATOR))
    expect([wrongTool(ASK_OWNER, Option.none()), wrongTool(ASK_ORCHESTRATOR, Option.some("ses_root")), wrongTool("shell", Option.none())]).toEqual([
      Option.none(),
      Option.none(),
      Option.none(),
    ])
  }),
)
