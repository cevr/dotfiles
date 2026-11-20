// The work plugin's seam: the composition root on a stand-in host whose tool registry holds OpenCode's
// worktree tools and applies the transform the plugin registers, over workspaces and sessions in memory.
// It runs the tool's create, list, remove and land on the `work` tool, checks the alias `rift` is the
// same tool over generated inputs, that a name a removed workspace still holds is made under a suffix, and
// the options. tests/work.test.ts runs it in OpenCode on the scripted model and the real `work` binary.
// Its tests register through sim-tui/effect-test.ts, as cmd/work/rpc.test.ts's do.
import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer, Option, Predicate, Schema, Scope } from "effect"
import { TestClock } from "effect/testing"
import * as MemoryDebts from "@dotfiles/opencode-work/memory/debts"
import * as MemoryLanding from "@dotfiles/opencode-work/memory/landing"
import * as MemoryNotices from "@dotfiles/opencode-work/memory/notices"
import * as MemoryRifts from "@dotfiles/opencode-work/memory/rifts"
import * as MemorySessionDirectories from "@dotfiles/opencode-work/memory/session-directories"
import * as MemoryWorkbox from "@dotfiles/opencode-work/memory/workbox"
import { baseName } from "@dotfiles/opencode-work/rift"
import { RiftFailed, Rifts } from "@dotfiles/opencode-work/service"
import { RIFT_ALIAS_DESCRIPTION, RIFT_ALIAS_REMOVAL, WORK_DESCRIPTION } from "@dotfiles/opencode-work/tool"
import { effectTest } from "../../sim-tui/effect-test.ts"
import Work, { live, make, WORKTREE_TOOLS } from "./server.ts"

type Host = Parameters<(typeof Work)["effect"]>[0]

/** A value of a call's input as a model sends it: JSON, which the tool's schema decodes first. */
type Value = string | number | boolean | ReadonlyArray<Value> | { readonly [field: string]: Value }

/** A call's input. */
type Ask = { readonly [field: string]: Value }

/** A tool as the registry holds it. */
interface Registered {
  readonly name: string
  readonly description: string
  readonly options?: { readonly codemode?: boolean }
  readonly input: Schema.Decoder<Ask>
  readonly execute: (
    input: Ask,
    context: { readonly sessionID: string },
  ) => Effect.Effect<{ readonly content: ReadonlyArray<{ readonly text: string }>; readonly metadata: object }, { readonly message: string }>
}

const SOURCE = "/code/app"
const SESSION = "ses_1"
const TIMEOUT_MS = 30_000

/** A world: the warm source and the given workspaces, a landing on `configs`, debts. */
const worldOf = (rifts: ReadonlyArray<ReturnType<typeof MemoryRifts.clean>> = [], configs: Parameters<typeof MemoryLanding.world>[0] = {}) => ({
  rifts: MemoryRifts.world([SOURCE], rifts),
  landing: MemoryLanding.world(configs),
  debts: MemoryDebts.world(),
  /** The names a removed workspace still holds: work answers NameTaken for them until a gc. */
  held: new Set<string>(),
})
type World = ReturnType<typeof worldOf>

/** A repository that gates and checks. */
const GATED = { [SOURCE]: MemoryLanding.config("main", "bun run gate", "bun run accept") }

/** The memory Rifts with work's rule on names: a removed workspace's name is taken until a gc. */
const holding = (world: World) =>
  Layer.effect(
    Rifts,
    Effect.gen(function* () {
      const inner = yield* Rifts
      return Rifts.of({
        ...inner,
        create: (request) =>
          Effect.andThen(
            Effect.when(
              Effect.fail(new RiftFailed({ operation: "work new", message: `NameTaken: {"_tag":"NameTaken","name":"${request.name}"}` })),
              Effect.sync(() => world.held.has(request.name)),
            ),
            inner.create(request),
          ),
        remove: (path, options) => Effect.tap(inner.remove(path, options), () => Effect.sync(() => world.held.add(baseName(path)))),
      })
    }),
  ).pipe(Layer.provide(MemoryRifts.layer(world.rifts)))

/** The stand-in host's parts, before it is checked to be the plugin context in every part the plugin reads. */
const stubOf = (options: Ask, tools: Map<string, Registered | "builtin">) => ({
  options,
  tool: {
    transform: (callback: (editor: { readonly add: (tool: Registered) => void; readonly remove: (id: string) => void }) => void) =>
      Effect.sync(() => {
        callback({ add: (tool) => void tools.set(tool.name, tool), remove: (id) => void tools.delete(id) })
        return { dispose: Effect.void }
      }),
  },
  rpc: { register: () => Effect.succeed({ dispose: Effect.void, events: { emit: () => Effect.void } }) },
  session: {},
})

/** The stand-in host is the plugin context in every part the plugin reads. */
const hostOf = (options: Ask, tools: Map<string, Registered | "builtin">) =>
  Effect.gen(function* () {
    const stub = stubOf(options, tools)
    const isHost = (value: typeof stub): value is typeof stub & Host => Predicate.hasProperty(value, "tool") && Predicate.hasProperty(value, "rpc")
    if (!isHost(stub)) return yield* Effect.die("the stand-in host lacks a part the plugin reads")
    return stub
  })

/** The plugin started on a stand-in host whose registry already holds the built-in tools. */
const start = (world: World, options: Ask = { workrift: false }) =>
  Effect.gen(function* () {
    const woken: Array<MemoryNotices.Woken> = []
    const tools = new Map<string, Registered | "builtin">([["shell", "builtin"], ["opencode_session_move", "builtin"], ...WORKTREE_TOOLS.map((id) => [id, "builtin"] as const)])
    const host = yield* hostOf(options, tools)
    yield* make(() =>
      Layer.mergeAll(
        holding(world),
        MemorySessionDirectories.layer({ [SESSION]: `${SOURCE}/src` }),
        MemoryLanding.layer(world.landing),
        MemoryNotices.layer(woken),
        MemoryWorkbox.layer(false),
        MemoryDebts.layer(world.debts),
      ),
    ).effect(host)

    /** A tool by name, as registered. */
    const registered = (name: string) =>
      Effect.fromOption(Option.filter(Option.fromUndefinedOr(tools.get(name)), (tool): tool is Registered => tool !== "builtin"))

    /** One call of the tool `name`: its text and metadata, or `error: <message>`; its input decoded by its own schema first, as the host does. */
    const answer = Effect.fn("WorkServerTest.answer")(function* (name: string, input: Ask) {
      const tool = yield* registered(name)
      const decoded = yield* Effect.exit(Schema.decodeUnknownEffect(tool.input)(input))
      if (Exit.isFailure(decoded)) return { text: `refused input: ${Cause.pretty(decoded.cause).split("\n")[0]}`, metadata: {} }
      const exit = yield* Effect.exit(tool.execute(decoded.value, { sessionID: SESSION }))
      return Exit.match(exit, {
        onSuccess: (done) => ({ text: done.content.map((item) => item.text).join("\n"), metadata: done.metadata }),
        onFailure: (cause) => ({ text: `error: ${cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error.message).join("; ")}`, metadata: {} }),
      })
    })
    /** One call of the work tool: its text, or `error: <message>`. */
    const call = (input: Ask) => Effect.map(answer("work", input), (done) => done.text)
    return { answer, call, registered, tools, woken }
  })

/** Lets the plugin's background fibers (a land's accept check, the post-land step, the minute check) run as far as they can without the clock. */
const settle = Effect.forEach(Array.from({ length: 30 }), () => Effect.yieldNow, { discard: true })

/** A seeded generator in [0, 1): the same seed, the same inputs. */
const rng = (seed: number) => {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ACTIONS = ["create", "list", "remove", "land", "refresh", "check", "deps", "sources", "prune", "storage", "init", "explode", 7]
const BRANCHES = ["feat/x", "feat/y", "p5/db", "fix one", ""]
const NAMES = ["feat-x", "feat-y", "one", "integrate"]
const PATHS = ["/code/.work/app/feat-x", "/code/.work/app/one", SOURCE, "/elsewhere", "./feat-y"]
const TARGETS: ReadonlyArray<Value> = ["feat-x", "feat-y", "p5/db", "nope", "/code/.work/app/one", { path: "/code/.work/app/feat-x", unit: "x" }, { path: "/code/.work/app/feat-y" }, 3]

/** Targets as the JSON string a model sends in place of the list. */
const JSON_TARGETS = ['["feat-x"]', '[{"path": "/code/.work/app/feat-x", "unit": "x"}]', '["nope", "feat-y"]', '[{"path": "/code/.work/app/one"}]']

/** One generated input of any action, valid or not: fields picked at random, some of the wrong type, some as the JSON string a model sends. */
const inputOf = (random: () => number) => {
  const pick = <A>(list: ReadonlyArray<A>) => list[Math.floor(random() * list.length) % list.length]
  const maybe = (field: string, value: () => Value): Ask => Object.fromEntries([[field, value()]].filter(() => random() < 0.4))
  const targets = () => Array.from({ length: Math.floor(random() * 3) }, () => pick(TARGETS))
  return {
    action: pick(ACTIONS),
    ...maybe("branch", () => pick(BRANCHES)),
    ...maybe("name", () => pick(NAMES)),
    ...maybe("path", () => pick(PATHS)),
    ...maybe("force", () => pick([true, false, "true", "yes"])),
    ...maybe("withChildren", () => pick([true, false, 1])),
    ...maybe("repository", () => pick(["git@github.com:o/r.git", 4])),
    ...maybe("rifts", () => pick<Value>([targets(), ...JSON_TARGETS, "feat-x"])),
  }
}

/** The input with its `rifts` given as `workspaces`, the land's own name for them. */
const asWorkspaces = (input: Ask): Ask => Object.fromEntries(Object.entries(input).map(([field, value]) => [field.replace(/^rifts$/, "workspaces"), value]))

/** The kinds of answer generated inputs reach, by how each starts (the workbox commands refuse here, as errors). */
const KINDS = ["refused input:", "error:", "Created the workspace", "Workspaces of", "Moved the workspace", "Landed 1 workspace(s)"]

/** Options that do not decode. */
const MALFORMED: ReadonlyArray<Ask> = [{ workrift: "yes" }, { work: 5 }]

/** Workspaces generated inputs act on, and a repository that lands them. */
const busyWorld = () =>
  worldOf([MemoryRifts.clean("/code/.work/app/feat-x", "feat/x"), MemoryRifts.clean("/code/.work/app/feat-y", "feat/y"), MemoryRifts.clean("/code/.work/app/one", "one")], GATED)

describe("the work plugin", () => {
  effectTest(
    "offers work and its alias rift as direct tools in place of OpenCode's worktree tools, each with its own description",
    Effect.scoped(
      Effect.gen(function* () {
        const { registered, tools } = yield* start(worldOf())
        expect([...tools.keys()].sort()).toEqual(["opencode_session_move", "rift", "shell", "work"])
        const work = yield* registered("work")
        const rift = yield* registered("rift")
        expect([work.options?.codemode, rift.options?.codemode]).toEqual([false, false])
        expect(work.description).toBe(WORK_DESCRIPTION)
        expect(rift.description).toBe(RIFT_ALIAS_DESCRIPTION)
        expect(rift.description).toStartWith(`Alias of the \`work\` tool; removed ${RIFT_ALIAS_REMOVAL}.`)
        expect(rift.description).toContain("2026-12-06")
        expect(rift.description).toEndWith(WORK_DESCRIPTION)
      }),
    ),
    TIMEOUT_MS,
  )

  effectTest(
    "for generated inputs of every action, valid and malformed, rift answers what work answers on a twin world, and rifts what workspaces does",
    Effect.scoped(
      Effect.gen(function* () {
        const kinds = new Set<string>()
        for (const seed of Array.from({ length: 40 }, (_, n) => n + 1)) {
          const random = rng(seed)
          const byWork = yield* start(busyWorld())
          const byRift = yield* start(busyWorld())
          const byWorkspaces = yield* start(busyWorld())
          for (const _ of Array.from({ length: 10 })) {
            const input = inputOf(random)
            const expected = yield* byWork.answer("work", input)
            const got = yield* byRift.answer("rift", input)
            const renamed = yield* byWorkspaces.answer("work", asWorkspaces(input))
            expect({ seed, input, got, renamed }).toEqual({ seed, input, got: expected, renamed: expected })
            kinds.add(KINDS.find((kind) => expected.text.startsWith(kind)) ?? "other")
            yield* settle
          }
        }
        // The inputs reach every kind of answer: a decode refusal, a refusal, a create, a list, a remove and a land.
        expect([...kinds].sort()).toEqual([...KINDS].sort())
      }),
    ),
    TIMEOUT_MS,
  )

  effectTest(
    "a land that names its workspaces both as workspaces and as rifts is refused, naming both, before it touches any",
    Effect.scoped(
      Effect.gen(function* () {
        const world = busyWorld()
        const { call } = yield* start(world)
        expect(yield* call({ action: "land", workspaces: ["feat-x"], rifts: ["feat-y"] })).toBe(
          `error: land takes its targets once: as workspaces, or as rifts (the old name, accepted until ${RIFT_ALIAS_REMOVAL}); this call gave both.`,
        )
        expect([world.landing.pushes, world.landing.steps]).toEqual([0, []])
        expect(yield* call({ action: "land", workspaces: ["feat-x"] })).toStartWith("Landed 1 workspace(s) as one push")
      }),
    ),
    TIMEOUT_MS,
  )

  effectTest(
    "creates, lists and removes a workspace, and refuses to remove one holding unsaved work, in the model's words",
    Effect.scoped(
      Effect.gen(function* () {
        const world = worldOf()
        const { call } = yield* start(world)
        expect(yield* call({ action: "create", branch: "feat/x" })).toStartWith("Created the workspace /code/.work/app/feat-x from /code/app, on branch feat/x.")
        expect(yield* call({ action: "list" })).toBe("Workspaces of /code/app:\n- /code/.work/app/feat-x · branch feat/x · clean")
        MemoryRifts.change(world.rifts, "/code/.work/app/feat-x", (workspace) => ({ ...workspace, unpushed: ["d85f04d only here"] }))
        expect(yield* call({ action: "remove", name: "feat-x" })).toStartWith(
          "error: /code/.work/app/feat-x holds work found nowhere else:\n1 commit(s) on no remote and in no branch of its source:\n  d85f04d only here",
        )
        expect(yield* call({ action: "remove", name: "feat-x", force: true })).toBe("Moved the workspace /code/.work/app/feat-x (branch feat/x) to the trash; it held 1 unpushed.")
        expect(yield* call({ action: "create" })).toStartWith("error: create needs a branch")
      }),
    ),
    TIMEOUT_MS,
  )

  effectTest(
    "a workspace removed and made again under its name goes under a suffix and says so; a live name is still refused",
    Effect.scoped(
      Effect.gen(function* () {
        const world = worldOf()
        const { answer, call } = yield* start(world)
        expect(yield* call({ action: "create", branch: "feat/x" })).toStartWith("Created the workspace /code/.work/app/feat-x from")
        expect(yield* call({ action: "remove", name: "feat-x" })).toStartWith("Moved the workspace /code/.work/app/feat-x")
        const again = yield* answer("work", { action: "create", branch: "feat/x" })
        expect(again.text).toStartWith("Created the workspace /code/.work/app/feat-x-2 from /code/app, on branch feat/x.")
        expect(again.text).toEndWith("The name feat-x is still held by a removed workspace (in the trash until a gc), so this one is feat-x-2.")
        expect(again.metadata).toMatchObject({ action: "create", path: "/code/.work/app/feat-x-2", branch: "feat/x" })
        // A name a live workspace holds is no trash's: refused as before.
        world.held.add("feat-y")
        world.rifts.rifts.set("/code/.work/app/feat-y", MemoryRifts.clean("/code/.work/app/feat-y", "feat/y"))
        expect(yield* call({ action: "create", branch: "feat/y" })).toStartWith("error: work new failed: NameTaken")
      }),
    ),
    TIMEOUT_MS,
  )

  effectTest(
    "a land after its integration workspace was removed merges in a fresh one under a suffix, which is no workspace to land",
    Effect.scoped(
      Effect.gen(function* () {
        const world = worldOf([MemoryRifts.clean("/code/.work/app/feat-x", "feat/x"), MemoryRifts.clean("/code/.work/app/feat-y", "feat/y")], GATED)
        const { call } = yield* start(world)
        expect(yield* call({ action: "land", workspaces: ["feat-x"] })).toStartWith("Landed 1 workspace(s) as one push")
        yield* settle
        expect(yield* call({ action: "remove", name: "integrate" })).toStartWith("Moved the workspace /code/.work/app/integrate")
        expect(yield* call({ action: "land", workspaces: ["feat-y"] })).toStartWith("Landed 1 workspace(s) as one push")
        yield* settle
        expect([...world.rifts.rifts.keys()].filter((path) => path.includes("integrate"))).toEqual(["/code/.work/app/integrate-2"])
        expect(yield* call({ action: "land", workspaces: ["integrate-2"] })).toStartWith(
          "error: Did not land anything: /code/.work/app/integrate-2 is the integration workspace land merges in",
        )
      }),
    ),
    TIMEOUT_MS,
  )

  effectTest(
    "lands workspaces as one batch, runs its accept check, which wakes no one when it passes, and says the workbox's commands need the workbox",
    Effect.scoped(
      Effect.gen(function* () {
        const world = worldOf([MemoryRifts.clean("/code/.work/app/feat-x", "feat/x")], GATED)
        const { call, woken } = yield* start(world)
        expect(yield* call({ action: "land", workspaces: ["feat-x"] })).toStartWith(
          "Landed 1 workspace(s) as one push: abc1234 Merge into main to main (merged feat/x; the gate passed in 3s).",
        )
        yield* settle
        expect([world.landing.steps.some((step) => step.startsWith("accept ")), woken]).toEqual([true, []])
        expect(yield* call({ action: "land", workspaces: ["nope"] })).toStartWith("error: The base /code/app has no workspace named nope.")
        // An orchestrate run names each workspace with its unit, `{ path, unit }`, as an object or as the JSON a model may send.
        const named = MemoryRifts.clean("/code/.work/app/db-2", "p5/db-2")
        world.rifts.rifts.set(named.path, named)
        expect(yield* call({ action: "land", rifts: [{ path: "/code/.work/app/db-2", unit: "db" }] })).toStartWith(
          "Landed 1 workspace(s) as one push: abc1234 Merge into main to main (merged p5/db-2;",
        )
        yield* settle
        world.rifts.rifts.set(named.path, named)
        expect(yield* call({ action: "land", workspaces: '[{"path": "/code/.work/app/db-2", "unit": "db"}]' })).toStartWith("Landed 1 workspace(s) as one push")
        expect(yield* call({ action: "land", workspaces: [{ path: "/code/.work/app/db-2" }] })).toStartWith("refused input:")
        expect(yield* call({ action: "prune" })).toBe("error: prune runs the workbox's workrift, which this machine does not have. Here this tool offers create, list, remove and land.")
      }),
    ),
    TIMEOUT_MS,
  )

  effectTest(
    "a land on a loaded host runs the post-land step loaded and leaves it owed; it survives a restart, and the minute check runs it settled once the load settles, which pays it",
    Effect.scoped(
      Effect.gen(function* () {
        const world = worldOf([MemoryRifts.clean("/code/.work/app/feat-x", "feat/x")], {
          [SOURCE]: MemoryLanding.config("main", "bun run gate", "bun run accept", { postLand: "bun scripts/post-land.ts" }),
        })
        world.landing.load = { load: 20, cores: 8 }
        const first = yield* Scope.make()
        const { call, woken } = yield* Scope.provide(start(world), first)
        expect(yield* call({ action: "land", workspaces: ["feat-x"] })).toStartWith("Landed 1 workspace(s) as one push")
        yield* settle
        const loads = () => world.landing.postLandEnvs.map((env) => env["RIFT_POST_LAND_LOAD"])
        const postLandWakes = () => woken.map((wake) => wake.notice.description).filter((description) => description.includes("post-land"))
        expect({ loads: loads(), wakes: postLandWakes(), owed: world.debts.debts.owed.length }).toEqual({ loads: ["loaded"], wakes: ["lane land · post-land needs action (loaded)"], owed: 1 })
        // A server restart: the step is still owed, and the new server's minute check runs it settled once the
        // load has stayed under the cores for the settle window.
        yield* Scope.close(first, Exit.void)
        const second = yield* Scope.make()
        const again = yield* Scope.provide(start(world), second)
        world.landing.load = { load: 0.5, cores: 8 }
        for (const _ of Array.from({ length: 8 })) {
          yield* TestClock.adjust("1 minute")
          yield* settle
        }
        expect({ loads: loads(), wakes: [...postLandWakes(), ...again.woken.map((wake) => wake.notice.description)], owed: world.debts.debts.owed.length }).toEqual({
          loads: ["loaded", "settled"],
          wakes: ["lane land · post-land needs action (loaded)", "lane land · post-land needs action"],
          owed: 0,
        })
        yield* Scope.close(second, Exit.void)
      }).pipe(Effect.provide(TestClock.layer())),
    ),
    TIMEOUT_MS,
  )

  effectTest(
    "a loaded run that ran nothing (exit 0, an empty report) wakes no one, and the step stays owed",
    Effect.scoped(
      Effect.gen(function* () {
        const world = worldOf([MemoryRifts.clean("/code/.work/app/feat-x", "feat/x")], {
          [SOURCE]: MemoryLanding.config("main", "bun run gate", "bun run accept", { postLand: "bun scripts/post-land.ts" }),
        })
        world.landing.load = { load: 20, cores: 8 }
        world.landing.postLandRun = { code: 0, output: "", report: "" }
        const { call, woken } = yield* start(world)
        expect(yield* call({ action: "land", workspaces: ["feat-x"] })).toStartWith("Landed 1 workspace(s) as one push")
        yield* settle
        expect({
          loads: world.landing.postLandEnvs.map((env) => env["RIFT_POST_LAND_LOAD"]),
          wakes: woken.filter((wake) => wake.notice.description.includes("post-land")).length,
          owed: world.debts.debts.owed.length,
        }).toEqual({ loads: ["loaded"], wakes: 0, owed: 1 })
      }).pipe(Effect.provide(TestClock.layer())),
    ),
    TIMEOUT_MS,
  )

  effectTest(
    "takes workrift from PATH and work as `work` when absent, stops on a malformed option, and stops naming a work binary that is not there",
    Effect.scoped(
      Effect.gen(function* () {
        const { tools } = yield* start(worldOf(), {})
        expect([tools.has("work"), tools.has("rift")]).toEqual([true, true])
        for (const options of MALFORMED) {
          const exit = yield* Effect.exit(start(worldOf(), options))
          expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain("dotfiles-opencode.work: invalid options")
        }
        const host = yield* hostOf({}, new Map())
        const missing = "/nonexistent/loop-probe-x/work"
        const exit = yield* Effect.exit(Layer.build(live(host, { workrift: false, work: missing })))
        expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain(`dotfiles-opencode.work: the work binary ${missing} does not start`)
      }),
    ),
    TIMEOUT_MS,
  )
})
