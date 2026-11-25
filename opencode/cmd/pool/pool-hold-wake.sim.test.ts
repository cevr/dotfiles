// @reads all
// @reads-reason computed read at mods/guard/filesystem/repo-roots.ts: return yield* Effect.tryPromise({ try: () => stat(join(path, ".git")), catch: (cause) => cause
// The interim on a host with no Step to hold (the installed fork): a subagent
// whose request the pool holds still ends its turn, as today, and the pool
// wakes it by itself, once, when it would admit the request again. A root is
// never woken. Deleted by the pool-hold-latch unit, whose host holds the Step.
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
    const running = () => Option.exists(Option.fromUndefinedOr(world.sessions.get(session)), (it) => it.running)
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
