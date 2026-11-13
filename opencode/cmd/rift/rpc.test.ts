// The rift RPC (`@dotfiles/opencode-rift/rpc`) against the `rift` tool, on the plugin's seam: a stand-in host
// whose registry and RPC take what the plugin registers, over Rifts, sessions and a landing in memory. A
// differential: one seeded sequence of calls goes to the tool on one world and to the RPC on a twin world, and
// each answer's text is the tool's. Then `at`, and the one model both share. Its tests register through
// sim-tui/effect-test.ts, as heavy-footer's do.
import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer, Match, Option, Predicate, Schema } from "effect"
import * as MemoryDebts from "@dotfiles/opencode-rift/memory/debts"
import * as MemoryLanding from "@dotfiles/opencode-rift/memory/landing"
import * as MemoryNotices from "@dotfiles/opencode-rift/memory/notices"
import * as MemoryRifts from "@dotfiles/opencode-rift/memory/rifts"
import * as MemorySessionDirectories from "@dotfiles/opencode-rift/memory/session-directories"
import * as MemoryWorkbox from "@dotfiles/opencode-rift/memory/workbox"
import { Created, Inspected, LandAnswered, Listed, RIFT_RPC } from "@dotfiles/opencode-rift/rpc"
import { effectTest } from "../../sim-tui/effect-test.ts"
import Rift, { make } from "./server.ts"

type Host = Parameters<(typeof Rift)["effect"]>[0]

/** A call's input, as a session would send it to the tool or a plugin to the RPC. */
type Ask = Readonly<{ [field: string]: string | ReadonlyArray<string | { readonly path: string; readonly unit: string }> }>

/** The rift tool as the registry holds it. */
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

/** A world as each test starts it: the warm source, one Rift already there, a repository that gates and checks. */
const worldOf = () => ({
  rifts: MemoryRifts.world([SOURCE], [MemoryRifts.clean("/code/.rifts/app/feat-x", "feat/x")]),
  landing: MemoryLanding.world({ [SOURCE]: MemoryLanding.config("main", "bun run gate", "bun run accept") }),
  debts: MemoryDebts.world(),
})
type World = ReturnType<typeof worldOf>

/** The plugin on a stand-in host: the rift tool as the registry holds it, and the RPC's handlers as registered. */
const start = (world: World) =>
  Effect.gen(function* () {
    const woken: Array<MemoryNotices.Woken> = []
    const tools = new Map<string, Registered>()
    const rpcs = new Map<string, Handlers>()
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
        register: (definition: { readonly id: string }, handlers: { readonly [method: string]: (input: Ask) => Effect.Effect<object> }) =>
          Effect.sync(() => {
            rpcs.set(definition.id, new Map(Object.entries(handlers)))
            return { dispose: Effect.void, events: { emit: () => Effect.void } }
          }),
      },
    }
    /** The stand-in host is the plugin context in every part the plugin reads. */
    const isHost = (value: typeof stub): value is typeof stub & Host => Predicate.hasProperty(value, "tool") && Predicate.hasProperty(value, "rpc")
    if (!isHost(stub)) return yield* Effect.die("the stand-in host lacks a part the plugin reads")
    yield* make(() =>
      Layer.mergeAll(
        MemoryRifts.layer(world.rifts),
        MemorySessionDirectories.layer({ [SESSION]: `${SOURCE}/src` }),
        MemoryLanding.layer(world.landing),
        MemoryNotices.layer(woken),
        MemoryWorkbox.layer(false),
        MemoryDebts.layer(world.debts),
      ),
    ).effect(stub)

    /** The tool's answer: its text, or `error: <message>`; its input decoded by its own schema first, as the host does. */
    const tool = Effect.fn("RpcTest.tool")(function* (input: Ask) {
      const rift = yield* Effect.fromOption(Option.fromUndefinedOr(tools.get("rift")))
      const decoded = yield* Schema.decodeUnknownEffect(rift.input)(input)
      const exit = yield* Effect.exit(rift.execute(decoded, { sessionID: SESSION }))
      return Exit.match(exit, {
        onSuccess: (answer) => answer.content.map((item) => item.text).join("\n"),
        onFailure: (cause) => `error: ${cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error.message).join("; ")}`,
      })
    })
    /** One RPC call, by method. */
    const rpc = Effect.fn("RpcTest.rpc")(function* (method: string, input: Ask) {
      const handlers = yield* Effect.fromOption(Option.fromUndefinedOr(rpcs.get(RIFT_RPC.id)))
      const handler = yield* Effect.fromOption(Option.fromUndefinedOr(handlers.get(method)))
      return yield* handler(input)
    })
    return { tool, rpc, woken }
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
const PATHS = ["/code/.rifts/app/feat-x", "/code/.rifts/app/feat-y", "/code/.rifts/app/one", "/elsewhere"]
const TARGETS = ["feat-x", "feat-y", "p5/db", "nope", "/code/.rifts/app/one"]

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
  if (random() < 0.3) return { method: "land", input: { rifts: [first, { path: "/code/.rifts/app/two", unit: "two" }] } }
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
    // An inspect of a path that is no Rift fails; the tool's list then has no line for it.
    if (inspected.outcome === "failed") return "not listed"
    return inspected.text
  })

describe("the rift RPC", () => {
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
    "a create with at leaves the Rift detached there, and the answer carries it",
    Effect.scoped(
      Effect.gen(function* () {
        const world = worldOf()
        world.rifts.commitOf = (at) => Option.liftPredicate("f00dfeed", () => at === "origin/HEAD")
        const { rpc } = yield* start(world)
        const created = yield* Schema.decodeUnknownEffect(Created)(yield* rpc("create", { sessionID: SESSION, branch: "verify-batch-1", at: "origin/HEAD" }))
        expect(created).toEqual({
          outcome: "answered",
          text: expect.stringContaining("Created the Rift /code/.rifts/app/verify-batch-1 from /code/app, on detached at f00dfeed."),
          rift: { path: "/code/.rifts/app/verify-batch-1", head: "f00dfeed", state: "clean" },
        })
        const missing = yield* Schema.decodeUnknownEffect(Created)(yield* rpc("create", { sessionID: SESSION, branch: "verify-batch-2", at: "0000000" }))
        expect(missing).toEqual({ outcome: "failed", message: expect.stringContaining("was removed") })
        expect([...world.rifts.rifts.keys()].sort()).toEqual(["/code/.rifts/app/feat-x", "/code/.rifts/app/verify-batch-1"])
        // Without `at`, the tool's create: on its branch.
        const bare = yield* Schema.decodeUnknownEffect(Created)(yield* rpc("create", { sessionID: SESSION, branch: "feat/z" }))
        expect(bare).toMatchObject({ outcome: "answered", rift: { path: "/code/.rifts/app/feat-z", branch: "feat/z", head: "abc1234", state: "clean" } })
      }),
    ),
    TIMEOUT_MS,
  )

  effectTest(
    "the RPC and the tool share one model: a land over the RPC wakes the session once with its accept check, and a malformed ask is refused in words",
    Effect.scoped(
      Effect.gen(function* () {
        const { rpc, woken } = yield* start(worldOf())
        const landed = yield* Schema.decodeUnknownEffect(LandAnswered)(yield* rpc("land", { sessionID: SESSION, rifts: [{ path: "/code/.rifts/app/feat-x", unit: "x" }] }))
        expect(textOf(landed)).toStartWith("Landed 1 Rift(s) as one push")
        yield* settle
        expect(woken.map((wake) => [wake.sessionID, wake.notice.description])).toEqual([[SESSION, "rift land · accept passed"]])
        const malformed = yield* Schema.decodeUnknownEffect(LandAnswered)(yield* rpc("land", { sessionID: SESSION }))
        expect(malformed).toEqual({ outcome: "failed", message: expect.stringContaining("not a rift land") })
      }),
    ),
    TIMEOUT_MS,
  )
})
