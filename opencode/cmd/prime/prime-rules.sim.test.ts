// Prime's server half on the simulated host (sim/world.ts): who is taught the
// chips, and with which bytes. The plugin runs from its composition root
// (`make(live)`, its kept sections in the host's plugin storage); a fixture
// plugin compacts a session as the owner's /compact does.
//
// - A new root gets the section once on every request that sends its
//   conversation, the same bytes each time, its compaction's request too; its
//   title request gets none.
// - A subagent gets none.
// - A session that answered before the plugin loaded gets none, for good.
// - A restart on new words leaves a live session's bytes as they were; a root
//   started after it gets the new ones.
// - `rules: false` registers no hook and sends nothing.
// - A deleted session's entry goes.
// The `generate` hook is registered beside `context` and `compaction`; the
// world models no generate request, and tests/prime-emphasis.test.ts runs the
// plugin in OpenCode.
import { Plugin } from "@opencode/plugin/effect"
import { SessionID } from "@opencode/schema/session-id"
import { guidance } from "@dotfiles/opencode-prime/emphasis"
import { Effect, Option, Schema } from "effect"
import { simulationRunner } from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"
import { live, make } from "./server.ts"

const { seeded } = simulationRunner("cmd/prime/prime-rules.sim.test.ts")

const WORK = "/scratch/project"
const ID = "dotfiles-opencode.prime"
const OPEN = "<reply_style>"
const ANSWER = "Done here."

/** The model: a title, a summary, else one answer. */
const model: World.Script = (request) => {
  if (request.kind === "title") return World.say("Rules fixture")
  if (request.kind === "compaction") return World.say("## Objective\n- sim summary")
  return World.say(ANSWER)
}

/** Compacts a session as the owner's /compact does: the fixture's one RPC method. */
const COMPACT = { id: "fixture.compact", methods: { compact: { input: { type: "object" }, output: { type: "object" } } }, events: {} } as const
const CompactInput = Schema.Struct({ sessionID: Schema.String })
const compactor = Plugin.define({
  id: "fixture.compact",
  effect: (ctx) =>
    ctx.rpc
      .register(COMPACT, {
        compact: (input) =>
          Schema.decodeUnknownEffect(CompactInput)(input).pipe(
            Effect.flatMap(({ sessionID }) => ctx.session.compact({ sessionID: SessionID.make(sessionID) })),
            Effect.as({}),
            Effect.orDie,
          ),
      })
      .pipe(Effect.orDie, Effect.asVoid),
})

/** How many times `text` holds `part`. */
const count = (text: string, part: string) => text.split(part).length - 1

const boot = (seed: number) =>
  Effect.gen(function* () {
    const world = World.make({ seed, script: model })
    yield* world.load(compactor, { directory: WORK })
    /** The owner prompts `session` and waits for its answer. */
    const ask = (session: string, text: string) =>
      Effect.gen(function* () {
        const before = world.messages(session).filter((message) => message.type === "assistant").length
        yield* world.prompt(session, text)
        yield* world.until(() => world.messages(session).filter((message) => message.type === "assistant").length > before && world.sessions.get(session)?.running === false, 60_000)
      })
    const compact = (session: string) =>
      Effect.gen(function* () {
        yield* world.rpc(COMPACT.id, "compact", { sessionID: session })
        yield* world.until(() => world.messages(session).some((message) => message.type === "compaction") && world.sessions.get(session)?.running === false, 60_000)
      })
    /** The session's requests: kind and system prompt, in order. */
    const asked = (session: string) => world.asked().filter((request) => request.sessionID === session)
    /** The plugin's storage. */
    const stored = () => [...(world.storage.get(ID) ?? new Map()).keys()]
    return { world, ask, compact, asked, stored }
  })

seeded("a new root gets the section once on every request that sends its conversation, the same bytes, its compaction too; a subagent gets none", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { world, ask, compact, asked } = yield* boot(seed)
    yield* world.load(make(live), { directory: WORK })
    const root = yield* world.session(WORK)
    yield* ask(root, "one")
    yield* ask(root, "two")
    yield* compact(root)
    yield* ask(root, "three")
    const child = yield* world.session(WORK, { parentID: root, agent: "worker" })
    yield* ask(child, "sub")

    const conversation = asked(root).filter((request) => request.kind !== "title")
    // The compaction's request, then the requests before and after it (the host may resume the turn after it).
    const kinds = conversation.map((request) => request.kind)
    expect({ compactions: kinds.filter((kind) => kind === "compaction").length, primaries: kinds.filter((kind) => kind === "primary").length >= 3 }).toEqual({
      compactions: 1,
      primaries: true,
    })
    for (const request of conversation) expect(count(request.system, guidance())).toBe(1)
    expect(new Set(conversation.map((request) => request.system)).size).toBe(1)
    for (const request of asked(root).filter((request) => request.kind === "title")) expect(request.system).not.toContain(OPEN)

    expect(asked(child).length).toBeGreaterThan(0)
    for (const request of asked(child)) expect(request.system).not.toContain(OPEN)
    expect({ context: world.hooked("context"), compaction: world.hooked("compaction"), generate: world.hooked("generate") }).toEqual({
      context: 1,
      compaction: 1,
      generate: 1,
    })
  }),
)

seeded("a session that answered before the plugin loaded gets none, for good; a root started after gets it", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { world, ask, asked } = yield* boot(seed)
    const old = yield* world.session(WORK)
    yield* ask(old, "before")
    yield* world.load(make(live), { directory: WORK })
    yield* ask(old, "after")
    yield* world.restart
    yield* ask(old, "after the restart")
    const fresh = yield* world.session(WORK)
    yield* ask(fresh, "hello")

    for (const request of asked(old)) expect(request.system).not.toContain(OPEN)
    expect(asked(fresh).filter((request) => request.kind === "primary").map((request) => count(request.system, guidance()))).toEqual([1])
  }),
)

seeded("a restart on new words leaves a live session's bytes as they were; a root started after it gets the new words", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { world, ask, asked } = yield* boot(seed)
    const words = { text: "<reply_style>\nfirst words\n</reply_style>" }
    yield* world.load(
      make(live, () => words.text),
      { directory: WORK },
    )
    const live1 = yield* world.session(WORK)
    yield* ask(live1, "one")
    words.text = "<reply_style>\nnew words\n</reply_style>"
    yield* world.restart
    yield* ask(live1, "two")
    const later = yield* world.session(WORK)
    yield* ask(later, "hello")

    const systems = (session: string) => asked(session).filter((request) => request.kind === "primary").map((request) => request.system)
    expect(systems(live1).map((system) => [count(system, "first words"), count(system, "new words")])).toEqual([
      [1, 0],
      [1, 0],
    ])
    expect(systems(later).map((system) => [count(system, "first words"), count(system, "new words")])).toEqual([[0, 1]])
  }),
)

seeded("rules: false registers no hook and teaches no session", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { world, ask, asked } = yield* boot(seed)
    yield* world.load(make(live), { directory: WORK, options: { rules: false } })
    const root = yield* world.session(WORK)
    yield* ask(root, "one")
    expect(world.hooked("context")).toBe(0)
    for (const request of asked(root)) expect(request.system).not.toContain(OPEN)
  }),
)

seeded("a deleted session's kept section goes", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { world, ask, stored } = yield* boot(seed)
    yield* world.load(make(live), { directory: WORK })
    const root = yield* world.session(WORK)
    const other = yield* world.session(WORK)
    yield* ask(root, "one")
    yield* ask(other, "one")
    expect(stored().toSorted()).toEqual([`reply-style:${other}`, `reply-style:${root}`].toSorted())
    yield* world.remove(root)
    yield* world.until(() => !stored().includes(`reply-style:${root}`), 10_000)
    expect(stored()).toEqual([`reply-style:${other}`])
    expect(Option.isSome(Option.fromNullishOr(world.sessions.get(other)))).toBe(true)
  }),
)
