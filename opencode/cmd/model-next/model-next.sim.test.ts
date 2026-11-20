// Acceptance, the mod: a queued model switch applies at the next compaction, or at
// the next wake once the cache has expired, on
// the simulated host, each test at 20 seeds. Destined for
// `opencode/cmd/model-next/model-next.sim.test.ts`. Written by the planner; red
// today because `Plugins.modelNext`, the world's `session.switchModel` and its
// `experimental.compaction.ended` and `experimental.wake` hooks do not exist (spec.md, Acceptance check).
//
// The test names and what each asserts are binding. The helpers' bodies are the
// implementor's to finish against the world as it then is (how a small window
// makes a turn compact mid-turn is `sim/host.ts` `pastCeiling`).
import { Array as Arr, Effect, Option, Schema } from "effect"
import { Cancelled, KEY, MODEL_NEXT, type ModelRef, Queued, Refused } from "@dotfiles/opencode-model-next/pending"
import { envelopes } from "../../mods/subagents/envelope.ts"
import * as Plugins from "../../sim/plugins.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

/** Whether a request carries a subagent's idle report: a synthetic message that opens with its envelope (envelope.ts, either form). */
const reportsSubagent = (text: string) =>
  text
    .split("synthetic: ")
    .slice(1)
    .some((after) => Option.exists(Arr.head(envelopes(after)), (found) => found.start === 0 && found.kind === "subagent"))

const { seeded } = Seed.runner("cmd/model-next/model-next.sim.test.ts")

const WORK = "/scratch/work"
const OLD = { providerID: "sim", id: "old" } as const
const NEW = { providerID: "other", id: "new" } as const
/** A window small enough that the second step of a turn is past its ceiling, so the turn compacts mid-turn. */
const SMALL = 10_000
/** A window no turn here reaches: nothing compacts. */
const LARGE = 1_000_000
const TTL_MS = 5 * 60_000
/** How long past the lifetime the mod waits before it calls the cache expired (its `graceSeconds` default). */
const GRACE_MS = 60_000
const modelsOf = (window: number): ReadonlyArray<World.CatalogModel> => [
  { providerID: "sim", id: "old", modelID: "old", limit: { context: window }, cost: [], settings: { cache: { ttl: "5m" } } },
  { providerID: "other", id: "new", modelID: "new", limit: { context: window }, cost: [], settings: { cache: { ttl: "5m" } } },
]

/** Every model request the world's model saw, in order: its kind and the model it went to. */
const recorder = () => {
  const seen: Array<{ readonly kind: string; readonly model: string }> = []
  const script: World.Script = (request) => {
    seen.push({ kind: request.kind, model: `${request.model.providerID}/${request.model.id}` })
    if (request.kind === "title") return World.say("Run")
    if (request.kind === "compaction") return World.say("Summary.", { input: 100, read: 8_000, write: 0 })
    // A turn of three steps: two tool calls on a prompt near the ceiling, then the answer. On a small window the
    // first call's prompt is past the ceiling, so the turn compacts before its second step; a context that starts at
    // a summary answers at once, so a compacted turn ends rather than compacting again on each step.
    const calls = request.text.split("\ntool ").length - 1
    if (request.text.startsWith("compaction: ")) return World.say("Done.", { input: 100, read: 0, write: 2_000 })
    // A subagent's report is read and noted: no work of the parent's own.
    if (reportsSubagent(request.text)) return World.say("Noted.", { input: 100, read: 2_000, write: 100 })
    if (calls < 2) return World.call(`call_${calls}`, "shell", { command: "true", background: false }, { input: 100, read: 0, write: 9_500 })
    return World.say("Done.", { input: 100, read: 0, write: 2_000 })
  }
  return { seen, script }
}

const boot = (seed: number, window = SMALL) =>
  Effect.gen(function* () {
    const { seen, script } = recorder()
    const made = World.make({ seed, script, models: modelsOf(window), model: OLD })
    // The sessions as `session.get` reads them: the model a session runs on, its own selection else the default.
    const sessions = {
      get: (id: string) =>
        Option.getOrUndefined(Option.map(Option.fromNullishOr(made.sessions.get(id)), (found) => ({ ...found, model: Option.getOrElse(found.model, () => OLD) }))),
    }
    const world = { ...made, sessions }
    const session = yield* world.session(WORK)
    yield* world.load(Plugins.modelNext, { directory: WORK })
    const rpc = (method: string, input: { readonly model?: ModelRef } = {}) => world.rpc(MODEL_NEXT, method, { sessionID: session, ...input })
    const pending = () => world.sessions.get(session)?.metadata?.[KEY]
    // At rest: no execution runs, and the title (asked on a fiber of its own as the first turn starts) has its answer.
    const idle = () =>
      world.until(() => {
        const found = world.sessions.get(session)
        return found?.running !== true && Option.exists(found?.title ?? Option.none(), (title) => title !== "")
      }, 60_000)
    return { world, session, seen, rpc, pending, idle }
  })

seeded("a queued switch waits: every request before the compaction goes to the old model", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { world, session, seen, rpc, pending } = yield* boot(seed)
    expect(yield* rpc("queue", { model: NEW })).toSatisfy(Schema.is(Queued))
    expect(pending()).toMatchObject({ sessionID: session, model: NEW })
    expect(world.sessions.get(session)?.model).toMatchObject(OLD)
    expect(seen.filter((request) => request.kind === "primary")).toEqual([])
  }),
)

seeded("a compaction mid-turn: the old model writes the summary and the very next step goes to the new model", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { world, session, seen, rpc, pending, idle } = yield* boot(seed)
    yield* rpc("queue", { model: NEW })
    yield* world.prompt(session, "Do the work.")
    yield* idle()
    const kinds = seen.filter((request) => request.kind !== "title")
    const summary = kinds.findIndex((request) => request.kind === "compaction")
    expect(summary).toBeGreaterThan(0)
    // Before and at the summary: the old model. After it: only the new one, from the first step on.
    expect(kinds.slice(0, summary + 1).every((request) => request.model === "sim/old")).toBe(true)
    expect(kinds.slice(summary + 1).length).toBeGreaterThan(0)
    expect(kinds.slice(summary + 1).every((request) => request.model === "other/new")).toBe(true)
    expect(pending()).toBeUndefined()
    // The transcript: the completed compaction, then the model-switched message, then the new model's step.
    const types = world.messages(session).map((message) => message.type)
    expect(types.indexOf("model-switched")).toBeGreaterThan(types.lastIndexOf("compaction"))
  }),
)

seeded("a manual compaction of an idle session applies it too, and a prompt queued behind the compaction runs on the new model", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { world, session, seen, rpc, idle } = yield* boot(seed)
    yield* world.prompt(session, "Do the work.")
    yield* idle()
    yield* rpc("queue", { model: NEW })
    seen.length = 0
    yield* world.compact(session)
    yield* world.prompt(session, "Go on.")
    yield* idle()
    const after = seen.filter((request) => request.kind === "primary")
    expect(after.length).toBeGreaterThan(0)
    expect(after.every((request) => request.model === "other/new")).toBe(true)
  }),
)

seeded("it survives a restart: queued, the server restarts, the next compaction applies it", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { world, session, seen, rpc, pending, idle } = yield* boot(seed)
    yield* world.prompt(session, "Do the work.")
    yield* idle()
    yield* rpc("queue", { model: NEW })
    yield* world.restart
    expect(pending()).toMatchObject({ model: NEW })
    seen.length = 0
    yield* world.compact(session)
    yield* world.prompt(session, "Go on.")
    yield* idle()
    expect(seen.filter((request) => request.kind === "primary").every((request) => request.model === "other/new")).toBe(true)
  }),
)

seeded("cancel, a direct switch and a failed compaction: none of them applies the queued model", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { world, session, rpc, pending } = yield* boot(seed)
    yield* rpc("queue", { model: NEW })
    expect(yield* rpc("cancel")).toSatisfy(Schema.is(Cancelled))
    expect(pending()).toBeUndefined()
    // A direct switch by anyone drops the queued one.
    yield* rpc("queue", { model: NEW })
    yield* world.switchModel(session, { providerID: "sim", id: "third" })
    expect(pending()).toBeUndefined()
    // A compaction that fails leaves it queued and the model as it was.
    yield* rpc("queue", { model: NEW })
    yield* world.failNextCompaction(session)
    yield* world.compact(session)
    expect(pending()).toMatchObject({ model: NEW })
    expect(world.sessions.get(session)?.model).toMatchObject({ providerID: "sim", id: "third" })
  }),
)

seeded("refusals name why: the session's own model, a model the catalog lacks, a session that is gone", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { rpc, world } = yield* boot(seed)
    expect(yield* rpc("queue", { model: OLD })).toEqual(Refused.make({ reason: "same-model" }))
    expect(yield* rpc("queue", { model: { providerID: "other", id: "gone" } })).toEqual(Refused.make({ reason: "unknown-model" }))
    expect(yield* world.rpc(MODEL_NEXT, "queue", { sessionID: "ses_gone", model: NEW })).toEqual(Refused.make({ reason: "no-session" }))
  }),
)

seeded("a subagent started while a switch is queued does not inherit it", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { world, session, seen, rpc, idle } = yield* boot(seed)
    yield* rpc("queue", { model: NEW })
    const child = yield* world.session(WORK, { parentID: session })
    yield* world.prompt(child, "Do the work.")
    yield* world.until(() => world.sessions.get(child)?.running !== true, 60_000)
    yield* idle()
    // The child compacted mid-turn too, and stayed on its model.
    expect(world.sessions.get(child)?.model).toMatchObject(OLD)
    expect(seen.some((request) => request.model === "other/new")).toBe(false)
  }),
)

// The cache's expiry (owner, q2: "Also on expiry"). The session sits idle on a
// large window, so nothing compacts; only the clock moves.

seeded("once the cache has expired, the next turn starts on the new model: no request after the expiry goes to the old one", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { world, session, seen, rpc, pending, idle } = yield* boot(seed, LARGE)
    yield* world.prompt(session, "Do the work.")
    yield* idle()
    yield* rpc("queue", { model: NEW })
    seen.length = 0
    yield* world.advance(TTL_MS + GRACE_MS + 1_000)
    // Idle time alone changes nothing: the switch is made as the session wakes.
    expect(world.sessions.get(session)?.model).toMatchObject(OLD)
    yield* world.prompt(session, "Go on.")
    yield* idle()
    const after = seen.filter((request) => request.kind !== "title")
    expect(after.length).toBeGreaterThan(0)
    expect(after.every((request) => request.kind === "primary" && request.model === "other/new")).toBe(true)
    expect(pending()).toBeUndefined()
    // The model-switched message comes before the turn's first step.
    const types = world.messages(session).map((message) => message.type)
    expect(types.lastIndexOf("model-switched")).toBeLessThan(types.lastIndexOf("assistant"))
  }),
)

seeded("a wake that is no prompt applies it too: a synthetic message after the expiry", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { world, session, seen, rpc, idle } = yield* boot(seed, LARGE)
    yield* world.prompt(session, "Do the work.")
    yield* idle()
    yield* rpc("queue", { model: NEW })
    seen.length = 0
    yield* world.advance(TTL_MS + GRACE_MS + 1_000)
    yield* world.synthetic(session, "A job ended.")
    yield* idle()
    expect(seen.filter((request) => request.kind === "primary").map((request) => request.model)).toContain("other/new")
    expect(seen.some((request) => request.model === "sim/old")).toBe(false)
  }),
)

seeded("inside the lifetime, and inside the grace after it, the next turn stays on the old model and the switch stays queued", ({ seed, expect }) =>
  Effect.gen(function* () {
    for (const wait of [TTL_MS - 5_000, TTL_MS + GRACE_MS - 5_000]) {
      const { world, session, seen, rpc, pending, idle } = yield* boot(seed, LARGE)
      yield* world.prompt(session, "Do the work.")
      yield* idle()
      yield* rpc("queue", { model: NEW })
      seen.length = 0
      // Measured from the last request's start, as the provider counts the lifetime.
      const started = world.requests().findLast((request) => request.kind === "primary")?.at ?? Number.NaN
      yield* world.advance(started + wait - world.elapsed())
      yield* world.prompt(session, "Go on.")
      yield* idle()
      expect(seen.filter((request) => request.kind === "primary").every((request) => request.model === "sim/old")).toBe(true)
      expect(pending()).toMatchObject({ model: NEW })
    }
  }),
)

seeded("no request since the last compaction never counts as expired: the switch waits until a request after it has expired", ({ seed, expect }) =>
  Effect.gen(function* () {
    // The summary request refreshed the cache, and the newest request with usage is from before it: the wake cannot
    // tell when the cache was last written, so it waits, however long the session sat idle.
    const { world, session, seen, rpc, pending, idle } = yield* boot(seed, LARGE)
    yield* world.prompt(session, "Do the work.")
    yield* idle()
    yield* world.compact(session)
    yield* idle()
    yield* rpc("queue", { model: NEW })
    seen.length = 0
    yield* world.advance(24 * 60 * 60_000)
    yield* world.prompt(session, "Go on.")
    yield* idle()
    const waited = seen.filter((request) => request.kind === "primary")
    expect(waited.length).toBeGreaterThan(0)
    expect(waited.every((request) => request.model === "sim/old")).toBe(true)
    expect(pending()).toMatchObject({ model: NEW })
    // That turn's request is after the compaction: once its cache has expired, the next wake applies the switch.
    seen.length = 0
    yield* world.advance(TTL_MS + GRACE_MS + 1_000)
    yield* world.prompt(session, "Go on.")
    yield* idle()
    const applied = seen.filter((request) => request.kind === "primary")
    expect(applied.length).toBeGreaterThan(0)
    expect(applied.every((request) => request.model === "other/new")).toBe(true)
    expect(pending()).toBeUndefined()
  }),
)

seeded("a failed compaction after the last request never counts as expired: its summary request may have refreshed the cache", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { world, session, seen, rpc, pending, idle } = yield* boot(seed, LARGE)
    yield* world.prompt(session, "Do the work.")
    yield* idle()
    yield* rpc("queue", { model: NEW })
    yield* world.failNextCompaction(session)
    yield* world.compact(session)
    yield* idle()
    // The failed compaction stays after the last request, and the context is not cut: that request is still the newest.
    expect(world.messages(session).at(-1)).toMatchObject({ type: "compaction", status: "failed" })
    seen.length = 0
    yield* world.advance(24 * 60 * 60_000)
    yield* world.prompt(session, "Go on.")
    yield* idle()
    const waited = seen.filter((request) => request.kind === "primary")
    expect(waited.length).toBeGreaterThan(0)
    expect(waited.every((request) => request.model === "sim/old")).toBe(true)
    expect(pending()).toMatchObject({ model: NEW })
    // That turn's request is after the failed compaction: once its cache has expired, the next wake applies the switch.
    seen.length = 0
    yield* world.advance(TTL_MS + GRACE_MS + 1_000)
    yield* world.prompt(session, "Go on.")
    yield* idle()
    const applied = seen.filter((request) => request.kind === "primary")
    expect(applied.length).toBeGreaterThan(0)
    expect(applied.every((request) => request.model === "other/new")).toBe(true)
    expect(pending()).toBeUndefined()
  }),
)

seeded("a lifetime that cannot be read never counts as expired: the switch waits for a compaction", ({ seed, expect }) =>
  Effect.gen(function* () {
    // The model loses its configured `cache.ttl`, and its provider has no default: no lifetime is known.
    const { world, session, seen, rpc, pending, idle } = yield* boot(seed, LARGE)
    yield* world.prompt(session, "Do the work.")
    yield* idle()
    yield* rpc("queue", { model: NEW })
    yield* world.forgetLifetime(OLD)
    seen.length = 0
    yield* world.advance(24 * 60 * 60_000)
    yield* world.prompt(session, "Go on.")
    yield* idle()
    expect(seen.some((request) => request.model === "other/new")).toBe(false)
    expect(pending()).toMatchObject({ model: NEW })
  }),
)
