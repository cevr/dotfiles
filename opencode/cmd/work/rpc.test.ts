// The rift RPC (`@dotfiles/opencode-work/rpc`) as cmd/work serves it, against its `work` tool, on the
// plugin's seam, over `make` and memory layers. A differential: one seeded
// sequence of calls goes to the tool on one world and to the RPC on a twin world, and each answer's text is
// the tool's. Then `at`, the one model both share, the four methods under RIFT_RPC's id, and an
// orchestrate lane removed and made again under its unit's name. Its tests register through
// sim-tui/effect-test.ts, as heavy-footer's do.
import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer, Match, Option, Predicate, Schema } from "effect"
import * as MemoryDebts from "@dotfiles/opencode-work/memory/debts"
import * as MemoryLanding from "@dotfiles/opencode-work/memory/landing"
import * as MemoryNotices from "@dotfiles/opencode-work/memory/notices"
import * as MemoryRifts from "@dotfiles/opencode-work/memory/rifts"
import * as MemorySessionDirectories from "@dotfiles/opencode-work/memory/session-directories"
import * as MemoryWorkbox from "@dotfiles/opencode-work/memory/workbox"
import { baseName } from "@dotfiles/opencode-work/rift"
import { Created, Inspected, LandAnswered, Listed, RIFT_RPC } from "@dotfiles/opencode-work/rpc"
import { RiftFailed, Rifts } from "@dotfiles/opencode-work/service"
import { effectTest } from "../../sim-tui/effect-test.ts"
import Work, { make } from "./server.ts"

type Host = Parameters<(typeof Work)["effect"]>[0]

/** A call's input, as a session would send it to the tool or a plugin to the RPC. */
type Ask = Readonly<{ [field: string]: string | ReadonlyArray<string | { readonly path: string; readonly unit: string }> }>

/** The work tool as the registry holds it. */
interface Registered {
  readonly name: string
  readonly input: Schema.Decoder<Ask>
  readonly execute: (input: Ask, context: { readonly sessionID: string }) => Effect.Effect<{ readonly content: ReadonlyArray<{ readonly text: string }> }, { readonly message: string }>
}

/** The RPC's handlers as the host holds them. */
type Handlers = ReadonlyMap<string, (input: Ask) => Effect.Effect<object>>

const SOURCE = "/code/app"
const SESSION = "ses_1"
const TIMEOUT_MS = 30_000

/** A world as each test starts it: the warm source, one workspace already there, a repository that gates and checks. */
const worldOf = () => ({
  rifts: MemoryRifts.world([SOURCE], [MemoryRifts.clean("/code/.work/app/feat-x", "feat/x")]),
  landing: MemoryLanding.world({ [SOURCE]: MemoryLanding.config("main", "bun run gate", "bun run accept") }),
  debts: MemoryDebts.world(),
  /** The names a removed workspace still holds: work answers NameTaken for them until a gc. */
  held: new Set<string>(),
})
type World = ReturnType<typeof worldOf>

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

/** The plugin on a stand-in host: the work tool as the registry holds it, and the RPC's handlers as registered. */
const start = (world: World) =>
  Effect.gen(function* () {
    const woken: Array<MemoryNotices.Woken> = []
    const tools = new Map<string, Registered>()
    const rpcs = new Map<string, Handlers>()
    const methods = new Map<string, ReadonlyArray<string>>()
    const stub = {
      options: { workrift: false },
      tool: {
        transform: (callback: (editor: { readonly add: (tool: Registered) => void; readonly remove: (id: string) => void }) => void) =>
          Effect.sync(() => {
            callback({ add: (tool) => void tools.set(tool.name, tool), remove: () => void 0 })
            return { dispose: Effect.void }
          }),
      },
      rpc: {
        register: (definition: { readonly id: string; readonly methods: object }, handlers: { readonly [method: string]: (input: Ask) => Effect.Effect<object> }) =>
          Effect.sync(() => {
            rpcs.set(definition.id, new Map(Object.entries(handlers)))
            methods.set(definition.id, Object.keys(definition.methods))
            return { dispose: Effect.void, events: { emit: () => Effect.void } }
          }),
      },
    }
    /** The stand-in host is the plugin context in every part the plugin reads. */
    const isHost = (value: typeof stub): value is typeof stub & Host => Predicate.hasProperty(value, "tool") && Predicate.hasProperty(value, "rpc")
    if (!isHost(stub)) return yield* Effect.die("the stand-in host lacks a part the plugin reads")
    yield* make(() =>
      Layer.mergeAll(
        holding(world),
        MemorySessionDirectories.layer({ [SESSION]: `${SOURCE}/src` }),
        MemoryLanding.layer(world.landing),
        MemoryNotices.layer(woken),
        MemoryWorkbox.layer(false),
        MemoryDebts.layer(world.debts),
      ),
    ).effect(stub)

    /** The tool's answer: its text, or `error: <message>`; its input decoded by its own schema first, as the host does. */
    const tool = Effect.fn("WorkRpcTest.tool")(function* (input: Ask) {
      const work = yield* Effect.fromOption(Option.fromUndefinedOr(tools.get("work")))
      const decoded = yield* Schema.decodeUnknownEffect(work.input)(input)
      const exit = yield* Effect.exit(work.execute(decoded, { sessionID: SESSION }))
      return Exit.match(exit, {
        onSuccess: (answer) => answer.content.map((item) => item.text).join("\n"),
        onFailure: (cause) => `error: ${cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error.message).join("; ")}`,
      })
    })
    /** One RPC call, by method. */
    const rpc = Effect.fn("WorkRpcTest.rpc")(function* (method: string, input: Ask) {
      const handlers = yield* Effect.fromOption(Option.fromUndefinedOr(rpcs.get(RIFT_RPC.id)))
      const handler = yield* Effect.fromOption(Option.fromUndefinedOr(handlers.get(method)))
      return yield* handler(input)
    })
    return { tool, rpc, woken, rpcs, methods }
  })

/** An RPC answer's text as the tool would show it: its text, or `error: <message>`. */
const textOf = (answer: { readonly outcome: "answered"; readonly text: string } | { readonly outcome: "failed"; readonly message: string }) =>
  Match.value(answer).pipe(
    Match.when({ outcome: "answered" }, (answered) => answered.text),
    Match.orElse((failed) => `error: ${failed.message}`),
  )

/** Lets the plugin's background fibers (a land's accept check) run as far as they can. */
const settle = Effect.forEach(Array.from({ length: 30 }), () => Effect.yieldNow, { discard: true })

/** A seeded generator in [0, 1): the same seed, the same calls. */
const rng = (seed: number) => {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Method = "create" | "list" | "inspect" | "land"
interface Call {
  readonly method: Method
  readonly input: Ask
}

const BRANCHES = ["feat/x", "feat/y", "p5/db", "fix/one-2", "feat/y"]
const NAMES = ["one", "two", "feat-x"]
const PATHS = ["/code/.work/app/feat-x", "/code/.work/app/feat-y", "/code/.work/app/one", "/elsewhere"]
const TARGETS = ["feat-x", "feat-y", "p5/db", "nope", "/code/.work/app/one"]

/** One generated call: a create (some named), a list, an inspect, or a land (some with a `{ path, unit }` entry). */
const callOf = (random: () => number): Call => {
  const pick = (list: ReadonlyArray<string>) => list[Math.floor(random() * list.length)] || "none"
  const roll = random()
  if (roll < 0.35) {
    const branch = pick(BRANCHES)
    if (random() < 0.3) return { method: "create", input: { branch, name: pick(NAMES) } }
    return { method: "create", input: { branch } }
  }
  if (roll < 0.55) return { method: "list", input: {} }
  if (roll < 0.75) return { method: "inspect", input: { path: pick(PATHS) } }
  const first = pick(TARGETS)
  if (random() < 0.3) return { method: "land", input: { rifts: [first, { path: "/code/.work/app/two", unit: "two" }] } }
  return { method: "land", input: { rifts: [first] } }
}

/** The tool's answer for an RPC call: the same input, by the tool's action; an inspect is its line of the tool's list. */
const toolAnswer = (tool: (input: Ask) => Effect.Effect<string, unknown>, call: Call) =>
  Effect.gen(function* () {
    if (call.method !== "inspect") return yield* tool({ action: call.method, ...call.input })
    const listed = yield* tool({ action: "list" })
    const line = listed.split("\n").find((entry) => entry.startsWith(`- ${String(call.input["path"])} ·`))
    return Option.getOrElse(Option.fromUndefinedOr(line), () => "not listed")
  })

/** The RPC's answer to a call, decoded by the method's answer schema, as text. */
const rpcAnswer = (rpc: (method: string, input: Ask) => Effect.Effect<object, unknown>, call: Call) =>
  Effect.gen(function* () {
    const answer = yield* rpc(call.method, { sessionID: SESSION, ...call.input })
    if (call.method === "create") return textOf(yield* Schema.decodeUnknownEffect(Created)(answer))
    if (call.method === "list") return textOf(yield* Schema.decodeUnknownEffect(Listed)(answer))
    if (call.method === "land") return textOf(yield* Schema.decodeUnknownEffect(LandAnswered)(answer))
    const inspected = yield* Schema.decodeUnknownEffect(Inspected)(answer)
    // An inspect of a path that is no workspace fails; the tool's list then has no line for it.
    if (inspected.outcome === "failed") return "not listed"
    return inspected.text
  })

describe("the rift RPC of the work plugin", () => {
  effectTest(
    "registers under RIFT_RPC's id with its five methods, and no other RPC",
    Effect.scoped(
      Effect.gen(function* () {
        const { rpcs, methods } = yield* start(worldOf())
        expect([...rpcs.keys()]).toEqual([RIFT_RPC.id])
        expect([...(rpcs.get(RIFT_RPC.id)?.keys() ?? [])].sort()).toEqual(["create", "describe", "inspect", "land", "list"])
        expect([...(methods.get(RIFT_RPC.id) ?? [])].sort()).toEqual(["create", "describe", "inspect", "land", "list"])
      }),
    ),
    TIMEOUT_MS,
  )

  effectTest(
    "a purpose given to create, or set by describe, is the workspace's branch description: list and inspect carry it",
    Effect.scoped(
      Effect.gen(function* () {
        const { rpc } = yield* start(worldOf())
        const created = yield* Schema.decodeUnknownEffect(Created)(yield* rpc("create", { sessionID: SESSION, branch: "feat/billing", purpose: "Bill each seat once" }))
        expect(created).toMatchObject({ outcome: "answered", rift: { path: "/code/.work/app/feat-billing", branch: "feat/billing", purpose: "Bill each seat once" } })
        const described = yield* Schema.decodeUnknownEffect(Inspected)(yield* rpc("describe", { sessionID: SESSION, path: "/code/.work/app/feat-x", purpose: "Show x" }))
        expect(described).toMatchObject({ outcome: "answered", rift: { path: "/code/.work/app/feat-x", purpose: "Show x" } })
        const listed = yield* Schema.decodeUnknownEffect(Listed)(yield* rpc("list", { sessionID: SESSION }))
        expect(listed.outcome === "answered" && listed.rifts.map((lane) => [lane.path, lane.purpose])).toEqual([
          ["/code/.work/app/feat-billing", "Bill each seat once"],
          ["/code/.work/app/feat-x", "Show x"],
        ])
        const nowhere = yield* Schema.decodeUnknownEffect(Inspected)(yield* rpc("describe", { sessionID: SESSION, path: "/elsewhere", purpose: "x" }))
        expect(nowhere).toMatchObject({ outcome: "failed" })
      }),
    ),
    TIMEOUT_MS,
  )

  effectTest(
    "over generated calls, create, list, inspect and land answer what the tool answers for the same input on a twin world",
    Effect.scoped(
      Effect.gen(function* () {
        for (const seed of Array.from({ length: 40 }, (_, n) => n + 1)) {
          const random = rng(seed)
          const byTool = yield* start(worldOf())
          const byRpc = yield* start(worldOf())
          for (const _ of Array.from({ length: 12 })) {
            const call = callOf(random)
            const expected = yield* toolAnswer(byTool.tool, call)
            const got = yield* rpcAnswer(byRpc.rpc, call)
            expect({ seed, call, got }).toEqual({ seed, call, got: expected })
            yield* settle
          }
        }
      }),
    ),
    TIMEOUT_MS,
  )

  effectTest(
    "a create with at leaves the workspace detached there, and the answer carries it",
    Effect.scoped(
      Effect.gen(function* () {
        const world = worldOf()
        world.rifts.commitOf = (at) => Option.liftPredicate("f00dfeed", () => at === "origin/HEAD")
        const { rpc } = yield* start(world)
        const created = yield* Schema.decodeUnknownEffect(Created)(yield* rpc("create", { sessionID: SESSION, branch: "verify-batch-1", at: "origin/HEAD" }))
        expect(created).toEqual({
          outcome: "answered",
          text: expect.stringContaining("Created the workspace /code/.work/app/verify-batch-1 from /code/app, on detached at f00dfeed."),
          rift: { path: "/code/.work/app/verify-batch-1", head: "f00dfeed", state: "clean" },
        })
        const missing = yield* Schema.decodeUnknownEffect(Created)(yield* rpc("create", { sessionID: SESSION, branch: "verify-batch-2", at: "0000000" }))
        expect(missing).toEqual({ outcome: "failed", message: expect.stringContaining("was removed") })
        expect([...world.rifts.rifts.keys()].sort()).toEqual(["/code/.work/app/feat-x", "/code/.work/app/verify-batch-1"])
        // Without `at`, the tool's create: on its branch.
        const bare = yield* Schema.decodeUnknownEffect(Created)(yield* rpc("create", { sessionID: SESSION, branch: "feat/z" }))
        expect(bare).toMatchObject({ outcome: "answered", rift: { path: "/code/.work/app/feat-z", branch: "feat/z", head: "abc1234", state: "clean" } })
      }),
    ),
    TIMEOUT_MS,
  )

  effectTest(
    "an orchestrate lane removed and made again under its unit's name is made under a suffix, and the answer carries the new path",
    Effect.scoped(
      Effect.gen(function* () {
        const world = worldOf()
        const { rpc, tool } = yield* start(world)
        const first = yield* Schema.decodeUnknownEffect(Created)(yield* rpc("create", { sessionID: SESSION, branch: "db" }))
        expect(first).toMatchObject({ outcome: "answered", rift: { path: "/code/.work/app/db", branch: "db" } })
        expect(yield* tool({ action: "remove", name: "db" })).toStartWith("Moved the workspace /code/.work/app/db")
        const again = yield* Schema.decodeUnknownEffect(Created)(yield* rpc("create", { sessionID: SESSION, branch: "db" }))
        expect(again).toEqual({
          outcome: "answered",
          text: expect.stringContaining("so this one is db-2."),
          rift: { path: "/code/.work/app/db-2", branch: "db", head: "abc1234", state: "clean" },
        })
        // A verify checkout detached at a commit, made again under its name, likewise.
        world.rifts.commitOf = (at) => Option.liftPredicate("f00dfeed", () => at === "origin/HEAD")
        yield* rpc("create", { sessionID: SESSION, branch: "verify-batch-1", at: "origin/HEAD" })
        expect(yield* tool({ action: "remove", name: "verify-batch-1" })).toStartWith("Moved the workspace /code/.work/app/verify-batch-1")
        const verify = yield* Schema.decodeUnknownEffect(Created)(yield* rpc("create", { sessionID: SESSION, branch: "verify-batch-1", at: "origin/HEAD" }))
        expect(verify).toMatchObject({ outcome: "answered", rift: { path: "/code/.work/app/verify-batch-1-2", head: "f00dfeed" } })
      }),
    ),
    TIMEOUT_MS,
  )

  effectTest(
    "the RPC and the tool share one model: a land over the RPC runs its accept check, which wakes no one when it passes, and a malformed ask is refused in words",
    Effect.scoped(
      Effect.gen(function* () {
        const world = worldOf()
        const { rpc, woken } = yield* start(world)
        const landed = yield* Schema.decodeUnknownEffect(LandAnswered)(yield* rpc("land", { sessionID: SESSION, rifts: [{ path: "/code/.work/app/feat-x", unit: "x" }] }))
        expect(textOf(landed)).toStartWith("Landed 1 workspace(s) as one push")
        yield* settle
        expect([world.landing.steps.some((step) => step.startsWith("accept ")), woken]).toEqual([true, []])
        const malformed = yield* Schema.decodeUnknownEffect(LandAnswered)(yield* rpc("land", { sessionID: SESSION }))
        expect(malformed).toEqual({ outcome: "failed", message: expect.stringContaining("not a work land") })
      }),
    ),
    TIMEOUT_MS,
  )
})
