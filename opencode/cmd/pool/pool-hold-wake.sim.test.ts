// @reads all
// @reads-reason computed read at mods/guard/filesystem/repo-roots.ts: return yield* Effect.tryPromise({ try: () => stat(join(path, ".git")), catch: (cause) => cause
// The interim on a host with no Step to hold (the installed fork): a subagent
// whose request the pool holds still ends its turn, as today, and the pool
// wakes it by itself, once, when it would admit the request again. A root is
// woken the same way only when it orchestrates (a subagent of its own runs, is
// pool-held or latched at the hold); a person's chat is never woken.
// Deleted by the pool-hold-latch unit, whose host holds the Step.
import * as HoldWake from "@dotfiles/opencode-pool/hold-wake"
import { Array as Arr, Effect, Option } from "effect"
import * as Plugins from "../../sim/plugins.ts"
import * as Provider from "../../sim/provider.ts"
import { line } from "../../sim/runtime.ts"
import { simulationRunner } from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = simulationRunner("cmd/pool/pool-hold-wake.sim.test.ts")

const MINUTE = 60_000
const WORK = "/scratch/wake"
const OTHER = "/scratch/wake-other"
const POOL = "dotfiles-opencode.pool"
const HOLD_ROW = "anthropic/hold/cred_first"
const ANSWER = "woken child answered"

const RESTARTS = ["none", "reload", "down-up"] as const

/** One held subagent (or root) on a host with no Step: the world, its session and what the provider saw of it. */
const held = (seed: number, input: { readonly root: boolean; readonly copies: number }) =>
  Effect.gen(function* () {
    const accounts = Provider.accounts(seed, ["first"])
    const sends: Array<number> = []
    const opens = World.START + 10 * MINUTE
    const world: World.World = World.make({
      seed,
      sendRefusal: false,
      script: () => World.say(""),
      anthropic: {
        accounts,
        script: ({ body }) => {
          const tools = body["tools"]
          if (!Array.isArray(tools) || tools.length === 0) return { kind: "ok", text: "Title" }
          if (!line(body).includes("the held work")) return { kind: "ok", text: "parent heard" }
          sends.push(world.now())
          return { kind: "ok", text: ANSWER }
        },
      },
      integrations: { anthropic: Arr.map(Object.values(accounts), (account) => ({ id: "cred_first", label: "Anthropic 1", ...account, expires: World.START + 24 * 60 * MINUTE })) },
    })
    yield* world.load(Plugins.anthropicAuth(world.provider()), { directory: WORK })
    yield* Effect.forEach(Arr.take([WORK, OTHER], input.copies), (directory) =>
      world.load(Plugins.pool(), { directory, options: { sweepMinutes: 0, limitsFile: "/nonexistent/sim/limits.json" } }), { discard: true })
    const hold = (until: number) =>
      Option.match(Option.fromUndefinedOr(world.storage.get(POOL)), { onNone: () => {}, onSome: (rows) => void rows.set(HOLD_ROW, { kind: "rate-limit", at: world.now(), until }) })
    hold(opens)
    const parent = yield* world.session(WORK, { title: "the parent" })
    const session = yield* Option.match(Option.liftPredicate(parent, () => input.root), {
      onSome: Effect.succeed,
      onNone: () => world.session(WORK, { parentID: parent, title: "the held unit" }),
    })
    yield* world.prompt(session, "do the held work")
    yield* world.advance(MINUTE)
    const running = () => Option.exists(Option.fromUndefinedOr(world.sessions.get(session)), (entry) => entry.running)
    const executions = () => world.trace().split("\n").filter((entry) => entry.includes("session.execution.started") && entry.includes(session)).length
    return { world, session, sends, opens, hold, running, executions }
  })

for (const restart of RESTARTS)
  seeded(`a held subagent ends its turn, is woken once when the pool admits it, and answers (server: ${restart})`, ({ seed, expect }) =>
    Effect.gen(function* () {
      const s = yield* held(seed, { root: false, copies: 2 })
      expect(s.running()).toBe(false)
      expect(s.sends).toEqual([])
      const before = s.executions()
      if (restart === "reload") yield* s.world.restart
      if (restart === "down-up") {
        yield* s.world.down
        yield* s.world.advance(30_000)
        yield* s.world.up
      }
      yield* s.world.advance(s.opens + 3 * MINUTE - s.world.now())
      yield* s.world.until(() => !s.running(), 5 * MINUTE)
      expect(s.sends).toHaveLength(1)
      expect(Option.getOrThrow(Option.fromUndefinedOr(s.sends[0]))).toBeGreaterThanOrEqual(s.opens)
      expect(s.executions() - before).toBe(1)
      expect(s.world.messages(s.session).map(line).some((text) => text.includes(ANSWER))).toBe(true)
      // Nothing wakes it again, a restart later either.
      yield* s.world.restart
      yield* s.world.advance(30 * MINUTE)
      expect(s.sends).toHaveLength(1)
      expect(s.executions() - before).toBe(1)
    }))

seeded("a hold found held again at its time wakes nobody until it opens", ({ seed, expect }) =>
  Effect.gen(function* () {
    const s = yield* held(seed, { root: false, copies: 1 })
    const before = s.executions()
    yield* s.world.advance(s.opens - 1 - s.world.now())
    const later = s.opens + 7 * MINUTE
    s.hold(later)
    yield* s.world.advance(later - 2 - s.world.now())
    expect(s.sends).toEqual([])
    expect(s.executions() - before).toBe(0)
    yield* s.world.advance(4 * MINUTE)
    yield* s.world.until(() => !s.running(), 5 * MINUTE)
    expect(s.sends).toHaveLength(1)
    expect(Option.getOrThrow(Option.fromUndefinedOr(s.sends[0]))).toBeGreaterThanOrEqual(later)
    expect(s.executions() - before).toBe(1)
  }))

seeded("a held root is never woken: its owner sends it again", ({ seed, expect }) =>
  Effect.gen(function* () {
    const s = yield* held(seed, { root: true, copies: 1 })
    const before = s.executions()
    yield* s.world.advance(s.opens + 30 * MINUTE - s.world.now())
    expect(s.sends).toEqual([])
    expect(s.executions() - before).toBe(0)
  }))

/** What a held root's own subagent is at the hold: live ones make the root an orchestrator, the others do not. */
const CHILDREN = ["pool-held", "latched", "running", "none", "finished", "cancelled-latch"] as const
type ChildKind = (typeof CHILDREN)[number]
const ORCHESTRATING: ReadonlyArray<ChildKind> = ["pool-held", "latched", "running"]

/** One held root with one subagent of `child`'s kind at the hold, on a host with no Step. */
const heldRoot = (seed: number, child: ChildKind) =>
  Effect.gen(function* () {
    const accounts = Provider.accounts(seed, ["first"])
    const opens = World.START + 10 * MINUTE
    const world: World.World = World.make({
      seed,
      sendRefusal: false,
      script: () => World.say(""),
      anthropic: {
        accounts,
        script: ({ body }) => {
          const tools = body["tools"]
          if (!Array.isArray(tools) || tools.length === 0) return { kind: "ok", text: "Title" }
          return { kind: "ok", text: ANSWER }
        },
      },
      integrations: { anthropic: Arr.map(Object.values(accounts), (account) => ({ id: "cred_first", label: "Anthropic 1", ...account, expires: World.START + 24 * 60 * MINUTE })) },
    })
    yield* world.load(Plugins.anthropicAuth(world.provider()), { directory: WORK })
    yield* world.load(Plugins.pool(), { directory: WORK, options: { sweepMinutes: 0, limitsFile: "/nonexistent/sim/limits.json" } })
    const hold = (until: number) =>
      Option.match(Option.fromUndefinedOr(world.storage.get(POOL)), { onNone: () => {}, onSome: (rows) => void rows.set(HOLD_ROW, { kind: "rate-limit", at: world.now(), until }) })
    hold(opens)
    const root = yield* world.session(WORK, { title: "the orchestrator" })
    const entry = (id: string) => Option.getOrThrow(Option.fromUndefinedOr(world.sessions.get(id)))
    if (child !== "none") {
      const sub = yield* world.session(WORK, { parentID: root, title: "a unit" })
      const mark = { hold: "pace", reason: "pace", opensAt: opens + 60 * MINUTE, recheckAt: opens + 60 * MINUTE, at: world.now() }
      // The host's own record of the child, as the wakes (its latch mark) and its executions leave it.
      if (child === "latched") entry(sub).metadata = { latch: mark }
      if (child === "cancelled-latch") entry(sub).metadata = { latch: { ...mark, cancelledAt: world.now() } }
      if (child === "running") entry(sub).busy = Option.some(world.now())
      if (child === "finished") {
        entry(sub).busy = Option.some(world.now() - MINUTE)
        entry(sub).idle = Option.some(world.now())
      }
      // Held by the pool: its turn ends held, and its report wakes the root, whose own turn ends held too.
      if (child === "pool-held") yield* world.prompt(sub, "do the unit's work")
    }
    if (child !== "pool-held") yield* world.prompt(root, "run the night's units")
    yield* world.advance(MINUTE)
    const executions = () => world.trace().split("\n").filter((line) => line.includes("session.execution.started") && line.includes(root)).length
    const wakes = () => world.messages(root).map(line).filter((text) => text.includes(HoldWake.ROOT_WAKE_TEXT)).length
    const asked = () => world.asked().filter((request) => request.sessionID === root && line(request).includes(HoldWake.ROOT_WAKE_TEXT))
    const running = () => entry(root).running
    // The pool's record of the root's hold (its `held-send/` row), which says whether the root orchestrates.
    const row = () => Option.flatMap(Option.fromUndefinedOr(world.storage.get(POOL)), (rows) => Option.fromUndefinedOr(rows.get(`held-send/${root}`)))
    return { world, root, opens, hold, executions, wakes, asked, running, row }
  })

for (const child of ORCHESTRATING)
  for (const restart of RESTARTS)
    seeded(`an orchestrator root (a root with a subagent of its own running, pool-held or latched at the hold; here ${child}) is woken once at its opening (server: ${restart})`, ({ seed, expect }) =>
      Effect.gen(function* () {
        const s = yield* heldRoot(seed, child)
        expect(s.running()).toBe(false)
        expect(s.wakes()).toBe(0)
        expect(Option.getOrThrow(s.row())).toMatchObject({ sessionID: s.root, orchestrator: true })
        // Its turn ended on the pool's word that it resumes by itself.
        expect(s.world.messages(s.root).map(line).some((text) => text.includes(HoldWake.SUBAGENT_RESUME_NOTE.trim()))).toBe(true)
        if (restart === "reload") yield* s.world.restart
        if (restart === "down-up") {
          yield* s.world.down
          yield* s.world.advance(30_000)
          yield* s.world.up
        }
        yield* s.world.advance(s.opens - 1 - s.world.now())
        expect(s.wakes()).toBe(0)
        yield* s.world.advance(3 * MINUTE)
        yield* s.world.until(() => !s.running(), 5 * MINUTE)
        expect(s.wakes()).toBe(1)
        expect(s.asked().length).toBeGreaterThanOrEqual(1)
        // `at` is virtual ms since the world's start.
        expect(Option.getOrThrow(Arr.head(s.asked())).at).toBeGreaterThanOrEqual(s.opens - World.START)
        expect(s.world.messages(s.root).map(line).some((text) => text.includes(ANSWER))).toBe(true)
        // Nothing wakes it again, a restart later either.
        yield* s.world.restart
        yield* s.world.advance(30 * MINUTE)
        expect(s.wakes()).toBe(1)
      }))

for (const child of CHILDREN.filter((kind) => !ORCHESTRATING.includes(kind)))
  seeded(`a held root with no subagent of its own running, pool-held or latched at the hold (here ${child}) is a person's chat: never woken`, ({ seed, expect }) =>
    Effect.gen(function* () {
      const s = yield* heldRoot(seed, child)
      const before = s.executions()
      // Its turn ended held, and the row does not say it orchestrates.
      expect(Option.getOrThrow(s.row())).toMatchObject({ sessionID: s.root })
      expect(Option.getOrThrow(s.row())).not.toHaveProperty("orchestrator")
      expect(s.world.messages(s.root).map(line).some((text) => text.includes(HoldWake.SUBAGENT_RESUME_NOTE.trim()))).toBe(false)
      yield* s.world.advance(s.opens + 30 * MINUTE - s.world.now())
      expect(s.wakes()).toBe(0)
      expect(s.executions() - before).toBe(0)
    }))

seeded("an orchestrator root the person types to before its opening is not woken by the pool: typing first cancels the wake", ({ seed, expect }) =>
  Effect.gen(function* () {
    const s = yield* heldRoot(seed, "latched")
    expect(Option.getOrThrow(s.row())).toMatchObject({ orchestrator: true })
    const before = s.executions()
    // The accounts open early; the person's message goes out and its turn ends.
    s.hold(s.world.now())
    yield* s.world.prompt(s.root, "the person again")
    yield* s.world.advance(MINUTE)
    yield* s.world.until(() => !s.running(), 5 * MINUTE)
    expect(s.executions() - before).toBe(1)
    expect(Option.isNone(s.row())).toBe(true)
    yield* s.world.advance(s.opens + 30 * MINUTE - s.world.now())
    expect(s.wakes()).toBe(0)
    expect(s.executions() - before).toBe(1)
  }))
