// The world on generated runs, with our real plugins (wakes, idle compaction)
// and a probe plugin whose tool steers a session:
// - determinism: one seed's command sequence, run twice, gives byte-equal
//   traces with no wall-clock value in them, and 50 seeds give at least 10
//   different traces;
// - against a reference model of sessions, their inbox and their idle or busy
//   state, after every command: each steer is delivered exactly once and in
//   the order sent; an idle session never leaves resumable work waiting, and
//   no session runs two executions at once; a restart loses no session,
//   message or stored value, and no timer of the old copies fires; virtual
//   time moves only when a command advances it.
// It also measures what one simulated hour costs in wall time.
import { describe, expect } from "bun:test"
import * as Seed from "./seed.ts"
import { Plugin } from "@opencode/plugin/effect"
import { SessionID } from "@opencode/schema/session-id"
import { Array as Arr, Clock, Effect, Option, Schema } from "effect"
import * as Plugins from "./plugins.ts"
import type { InboxItem, Message } from "./host.ts"
import { below, generator, line } from "./runtime.ts"
import * as Provider from "./provider.ts"
import { make, say, START, type World } from "./world.ts"

const SteerInput = Schema.Struct({ sessionID: Schema.String, text: Schema.String, resume: Schema.Boolean })

/** A plugin whose `steer` tool puts a synthetic message into a session, as our plugins' couriers do. */
const probe = Plugin.define({
  id: "sim-probe",
  effect: (ctx) =>
    ctx.tool
      .transform((editor) => {
        editor.add({
          name: "steer",
          description: "steer a session",
          input: SteerInput,
          execute: (input) =>
            ctx.session
              .synthetic({
                sessionID: SessionID.make(input.sessionID),
                text: input.text,
                description: "probe",
                metadata: { source: "probe" },
                resume: input.resume,
              })
              .pipe(
                Effect.as({ content: "sent" }),
                Effect.orElseSucceed(() => ({ content: "refused" })),
              ),
        })
      })
      .pipe(Effect.asVoid),
})

type Command =
  | { readonly type: "session" }
  | { readonly type: "prompt"; readonly session: number }
  | { readonly type: "steer"; readonly session: number; readonly resume: boolean }
  | { readonly type: "alarm"; readonly session: number; readonly seconds: number }
  | { readonly type: "advance"; readonly ms: number }
  | { readonly type: "restart" }
  | { readonly type: "close"; readonly session: number }

/** The command the seed picks from `pick` (0 to 19), for session index `session`. */
const commandOf = (pick: number, session: number, random: ReturnType<typeof generator>): Command => {
  if (pick < 2) return { type: "session" }
  if (pick < 6) return { type: "prompt", session }
  if (pick < 10) return { type: "steer", session, resume: below(random, 3) > 0 }
  if (pick < 12) return { type: "alarm", session, seconds: 1 + below(random, 90) }
  if (pick < 17) return { type: "advance", ms: Math.max(0, below(random, 4) - 1) * (1 + below(random, 120_000)) }
  if (pick < 19) return { type: "restart" }
  return { type: "close", session }
}

/** Up to 40 commands, the seed choosing each. */
const commandsOf = (seed: number): ReadonlyArray<Command> => {
  const random = generator(`commands:${seed}`)
  const count = 10 + below(random, 31)
  return [{ type: "session" }, ...Array.from({ length: count - 1 }, () => commandOf(below(random, 20), below(random, 3), random))]
}

/** The reference model: the sessions made, those alive, and each one's steers in the order sent. */
interface Model {
  readonly sessions: Array<string>
  readonly alive: Set<string>
  readonly sent: Map<string, Array<string>>
  steers: number
}

/** What a check sees after a command. */
interface Step {
  readonly world: World
  readonly model: Model
  readonly command: Command
  readonly before: number
}

/** The world with the wakes and idle compaction plugins and the probe loaded for one directory. */
const worldOf = (seed: number) =>
  Effect.gen(function* () {
    const world = make({ seed, script: (request) => say(`${request.kind} ${request.text.length}`) })
    yield* world.load(Plugins.wake(world), { directory: "/work", options: { backstop: "off" } })
    yield* world.load(Plugins.idleCompact, { directory: "/work", options: { ttlSeconds: 20, shortMarginSeconds: 5, thresholdTokens: 50 } })
    yield* world.load(probe, { directory: "/work" })
    return world
  })

/** The live session a command names, if any: its index among those made. */
const targetOf = (model: Model, index: number) =>
  Option.filter(Option.fromNullishOr(model.sessions[index % Math.max(1, model.sessions.length)]), (id) => model.alive.has(id))

/** One command on the world, and on the model. */
const apply = (world: World, model: Model, command: Command) =>
  Effect.gen(function* () {
    if (command.type === "session") {
      const id = yield* world.session("/work")
      model.sessions.push(id)
      model.alive.add(id)
      model.sent.set(id, [])
    }
    if (command.type === "advance") yield* world.advance(command.ms)
    if (command.type === "restart") yield* world.restart
    if (command.type === "session" || command.type === "advance" || command.type === "restart") return
    const target = targetOf(model, command.session)
    if (Option.isNone(target)) return
    const id = target.value
    if (command.type === "prompt") yield* world.prompt(id, `prompt ${model.steers}`)
    if (command.type === "steer") {
      model.steers += 1
      const text = `steer ${model.steers}`
      yield* world.tool(id, "steer", { sessionID: id, text, resume: command.resume })
      model.sent.get(id)?.push(text)
    }
    if (command.type === "alarm") yield* world.tool(id, "wake", { afterSeconds: command.seconds, note: `alarm ${command.seconds}` })
    if (command.type === "close") {
      yield* world.remove(id)
      model.alive.delete(id)
    }
  })

/** One generated run on a fresh world; after each command, `check` sees the world and the model. */
const runOf = (seed: number, check: (step: Step) => void = () => void 0) =>
  Effect.gen(function* () {
    const world = yield* worldOf(seed)
    const model: Model = { sessions: [], alive: new Set(), sent: new Map(), steers: 0 }
    for (const command of commandsOf(seed)) {
      const before = world.now()
      yield* apply(world, model, command)
      check({ world, model, command, before })
    }
    return world
  })

/** A probe's steer's text, in the conversation or the inbox; nothing else's. */
const probeText = (entry: Message | InboxItem): ReadonlyArray<string> => {
  if (entry.type === "synthetic" && entry.metadata["source"] === "probe") return [entry.text]
  return []
}

/** The steers the session holds: delivered into its conversation, then still waiting in its inbox. */
const steersOf = (world: World, id: string) => {
  const session = world.sessions.get(id)
  return [...(session?.messages ?? []), ...(session?.inbox ?? [])].flatMap(probeText)
}

/** The invariants after one command. */
const invariants = (memory: { stored: Map<string, Map<string, Schema.Json>>; messages: Map<string, number>; lines: number }) => (step: Step) => {
  const { world, model, command, before } = step
  const label = line(command)
  // Time moves only by an advance.
  if (command.type !== "advance") expect(world.now(), label).toBe(before)
  expect([...world.sessions.keys()].filter((id) => model.sessions.includes(id)).toSorted(), label).toEqual([...model.alive].toSorted())
  for (const id of model.alive) {
    // Each steer once, in the order sent: those delivered, then those still waiting.
    expect(steersOf(world, id), label).toEqual(model.sent.get(id) ?? [])
    // An idle session leaves no work that wakes it waiting.
    const session = world.sessions.get(id)
    if (session?.running === false)
      expect(
        session.inbox.filter((item) => item.resume),
        label,
      ).toEqual([])
  }
  // No timer of a closed copy fired.
  expect(world.stale(), label).toEqual([])
  if (command.type === "restart") {
    // What was stored before is there after, unless a copy wrote the key since; no message is lost; only live copies' timers are set.
    const since = world.trace().split("\n").slice(memory.lines).join("\n")
    for (const [plugin, values] of memory.stored)
      for (const [key, value] of values)
        if (!since.includes(`"key":${line(key)}`)) expect(world.storage.get(plugin)?.get(key), `${label}: ${plugin} ${key}`).toEqual(value)
    for (const [id, count] of memory.messages) expect(world.messages(id).length, label).toBeGreaterThanOrEqual(count)
    expect(
      world.timers().filter((owner) => owner !== 0 && !world.live().includes(owner)),
      label,
    ).toEqual([])
  }
  memory.stored = new Map([...world.storage].map(([plugin, values]) => [plugin, new Map(values)]))
  memory.messages = new Map([...world.sessions].map(([id, session]) => [id, session.messages.length]))
  memory.lines = world.trace().split("\n").length
}

const TraceLine = Schema.Struct({
  kind: Schema.String,
  type: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Struct({ sessionID: Schema.optional(Schema.String) })),
})
const traceLine = Schema.decodeUnknownSync(Schema.fromJsonString(TraceLine))

/** No session ran two executions at once: each start ends before the next. */
const oneAtATime = (world: World) => {
  const running = new Set<string>()
  for (const entry of world
    .trace()
    .split("\n")
    .map((text) => traceLine(text))) {
    const id = entry.data?.sessionID ?? ""
    if (entry.type === "session.execution.started") {
      expect(running.has(id), `a second execution of ${id}`).toBe(false)
      running.add(id)
    }
    if (entry.type === "session.execution.succeeded" || entry.type === "session.execution.failed") running.delete(id)
    if (entry.kind === "down") running.clear()
  }
}

const SEEDS = Array.from({ length: 50 }, (_, index) => index + 1)

// The pooled world: two Anthropic logins OpenCode holds, the auth plugin and
// the pool from their roots, against the world's Anthropic. The commands add
// pooled turns, a plan limit on a login until a reset, a token endpoint that
// fails, a reset grant about to expire on a spent week (the pool claims it on
// its own) and a claim endpoint that fails, the pool sweeping every 30 minutes, and
// the clock passing a reset, a grant's end or a token's expiry.

const LOGINS = ["first", "second"] as const
const HOUR = 3_600_000

type Pooled =
  | { readonly type: "session" }
  | { readonly type: "prompt"; readonly session: number }
  | { readonly type: "limit"; readonly login: number; readonly hours: number }
  | { readonly type: "token"; readonly login: number; readonly answer: "rotate" | "rate-limited" | "unavailable" }
  | { readonly type: "grant"; readonly login: number; readonly hours: number }
  | { readonly type: "claim"; readonly answer: Provider.ClaimResult }
  | { readonly type: "advance"; readonly ms: number }
  | { readonly type: "restart" }

const pooledOf = (pick: number, random: ReturnType<typeof generator>): Pooled => {
  if (pick < 2) return { type: "session" }
  if (pick < 9) return { type: "prompt", session: below(random, 3) }
  if (pick < 12) return { type: "limit", login: below(random, 2), hours: 1 + below(random, 5) }
  if (pick < 14) return { type: "token", login: below(random, 2), answer: (["rotate", "rate-limited", "unavailable"] as const)[below(random, 3)] ?? "rotate" }
  if (pick < 16) return { type: "grant", login: below(random, 2), hours: 1 + below(random, 30) }
  if (pick < 17) return { type: "claim", answer: (["reset", "unavailable", "rate-limited", "cooldown"] as const)[below(random, 4)] ?? "reset" }
  if (pick < 21) return { type: "advance", ms: below(random, 4) * (1 + below(random, 2 * HOUR)) }
  return { type: "restart" }
}

/** Up to 40 pooled commands, the seed choosing each. */
const pooledCommandsOf = (seed: number): ReadonlyArray<Pooled> => {
  const random = generator(`pooled:${seed}`)
  const count = 10 + below(random, 31)
  return [{ type: "session" }, ...Array.from({ length: count - 1 }, () => pooledOf(below(random, 22), random))]
}

/** What the world's Anthropic is told: each login's plan limit until its reset, and each one's token endpoint answer. */
interface Anthropic {
  readonly limits: Map<string, number>
  readonly tokens: Map<string, "rotate" | "rate-limited" | "unavailable">
  /** Each plan-limit refusal: the login, the provider's request index, and the reset it named. */
  readonly refusals: Array<{ readonly login: string; readonly index: number; readonly resetAt: number }>
  /** Each login's reset grants: listed until claimed or ended. */
  readonly grants: Map<string, Array<Provider.Grant>>
  /** What the claim endpoint answers next. */
  claim: Provider.ClaimResult
  /** Each login's week, 90% used once a grant is listed on it (worth claiming, not spent), until a claim gives it back. */
  readonly weeks: Map<string, number>
}

/** What the world's Anthropic is told by a command: a plan limit, a token or claim endpoint's answer, a grant listed. */
const tell = (anthropic: Anthropic, command: Pooled, before: number) => {
  if (command.type === "limit") anthropic.limits.set(LOGINS[command.login] ?? "first", before + command.hours * HOUR)
  if (command.type === "token") anthropic.tokens.set(LOGINS[command.login] ?? "first", command.answer)
  if (command.type === "grant") {
    const login = LOGINS[command.login] ?? "first"
    const grant: Provider.Grant = { id: `grant-${before}-${login}`, resetsLeft: 1, endsAt: before + command.hours * HOUR, clears: ["seven_day"], type: "weekly" }
    anthropic.grants.set(login, [...(anthropic.grants.get(login) ?? []), grant])
    anthropic.weeks.set(login, 0.9)
  }
  if (command.type === "claim") anthropic.claim = command.answer
}

/** A claimed grant: listed still, with no resets left, as Anthropic lists it. */
const spend = (listed: ReadonlyArray<Provider.Grant>, grant: string) =>
  listed.map((item) => Option.match(Option.liftPredicate(item, (each) => each.id === grant), { onNone: () => item, onSome: (each) => ({ ...each, resetsLeft: 0 }) }))

/** One pooled run: its world and what the provider saw. */
const pooledRun = (seed: number, check: (world: World, anthropic: Anthropic, command: Pooled, before: number) => void = () => void 0) =>
  Effect.gen(function* () {
    const anthropic: Anthropic = { limits: new Map(), tokens: new Map(), refusals: [], grants: new Map(), claim: "reset", weeks: new Map() }
    const accounts = Provider.accounts(seed, LOGINS)
    const world = make({
      seed,
      script: () => say(""),
      anthropic: {
        accounts,
        token: (login) => ({ kind: anthropic.tokens.get(login) ?? "rotate" }),
        quota: (login) => ({
          // The five-hour window as the plan limit says: spent until its reset, as the 429 named it.
          fiveHour: Option.match(Option.filter(Option.fromNullishOr(anthropic.limits.get(login)), (resetAt) => resetAt > world.now()), {
            onNone: () => ({ utilization: 0.1, resetAt: world.now() + 2 * HOUR }),
            onSome: (resetAt) => ({ utilization: 1, resetAt }),
          }),
          sevenDay: { utilization: anthropic.weeks.get(login) ?? 0.2, resetAt: START + 5 * 24 * HOUR },
        }),
        grants: (login) => anthropic.grants.get(login) ?? [],
        claim: (login, grant) => {
          const listed = anthropic.grants.get(login) ?? []
          if (listed.some((item) => item.id === grant && item.resetsLeft === 0)) return "already_used"
          const answer = anthropic.claim
          if (answer !== "reset") return answer
          anthropic.grants.set(login, spend(listed, grant))
          anthropic.weeks.set(login, 0)
          return answer
        },
        script: ({ account, body }) => {
          const tools = body["tools"]
          const turn = Array.isArray(tools) && tools.length > 0
          const resetAt = anthropic.limits.get(account) ?? 0
          if (turn && resetAt > world.now()) {
            anthropic.refusals.push({ login: account, index: world.provider().received().length, resetAt })
            return { kind: "usage-429", claim: "five_hour", resetAt }
          }
          return { kind: "ok", text: `answered on ${account}` }
        },
      },
      integrations: {
        anthropic: LOGINS.map((name, index) => ({ id: `cred_${name}`, label: `Anthropic ${index + 1}`, ...accounts[name], expires: START + HOUR })),
      },
    })
    yield* world.load(Plugins.anthropicAuth(world.provider()), { directory: "/work" })
    yield* world.load(Plugins.pool(), { directory: "/work", options: { sweepMinutes: 30, limitsFile: "/nonexistent/sim/limits.json" } })
    const sessions: Array<string> = []
    for (const command of pooledCommandsOf(seed)) {
      const before = world.now()
      if (command.type === "session") sessions.push(yield* world.session("/work"))
      if (command.type === "prompt")
        yield* Option.match(Option.fromNullishOr(sessions[command.session % Math.max(1, sessions.length)]), {
          onNone: () => Effect.void,
          onSome: (id) => world.prompt(id, `pooled ${before}`),
        })
      tell(anthropic, command, before)
      if (command.type === "advance") yield* world.advance(command.ms)
      if (command.type === "restart") yield* world.restart
      check(world, anthropic, command, before)
    }
    return { world, anthropic }
  })

/** The invariants of a pooled run after one command. */
const pooledInvariants = (seed: number) => (world: World, anthropic: Anthropic, command: Pooled, before: number) => {
  const label = `seed ${seed}: ${line(command)}`
  if (command.type !== "advance") expect(world.now(), label).toBe(before)
  const received = world.provider().received()
  const messages = received.flatMap((request, index) => Arr.filter([{ ...request, index }], () => request.path === "/v1/messages"))
  // A request goes out on exactly one login the provider knows: none unsigned.
  expect(
    messages.filter((request) => request.account === ""),
    label,
  ).toEqual([])
  // Never on a login the provider refused as spent, once the refusal is back (a request already sent at that instant
  // aside), before the reset it named: with every login spent the pool refuses the turn itself.
  const refused = (login: string, at: number, known: (refusal: { readonly index: number }) => boolean) =>
    anthropic.refusals.some((refusal) => refusal.login === login && known(refusal) && at < refusal.resetAt)
  expect(
    messages.filter(
      (request) =>
        request.tools > 0 &&
        refused(request.account, request.at, (refusal) => (received[refusal.index]?.at ?? request.at) < request.at),
    ),
    label,
  ).toEqual([])
  // A refresh token is traded once: none is presented again after it was rotated.
  expect(
    received.filter((request) => request.path === "/v1/oauth/token" && request.status === 400),
    label,
  ).toEqual([])
  // A grant is claimed at most once, across restarts: none is sent again after the provider took it.
  const claims = world.provider().claims()
  expect(
    claims.filter((claim, index) => claims.slice(0, index).some((before) => before.grant === claim.grant && before.result === "reset")),
    label,
  ).toEqual([])
  // Nor is a grant claimed the provider never listed for that login.
  expect(
    world
      .provider()
      .claims()
      .filter((claim) => !claim.grant.startsWith("grant-") || !claim.grant.endsWith(`-${claim.account}`)),
    label,
  ).toEqual([])
}

describe("the world", () => {
  Seed.effect(
    "one seed replays byte for byte, holds no wall-clock value, and 50 seeds give at least 10 different runs",
    Effect.gen(function* () {
      const wall = String(yield* Clock.currentTimeMillis).slice(0, 7)
      const traces = yield* Effect.forEach(SEEDS, (seed) =>
        Effect.gen(function* () {
          const first = (yield* runOf(seed)).trace()
          const second = (yield* runOf(seed)).trace()
          expect(second, `seed ${seed}`).toBe(first)
          // No wall-clock reading: the clock starts at the world's fixed epoch (2001), years off today's.
          expect(first.includes(wall), `seed ${seed}`).toBe(false)
          return first
        }),
      )
      expect(new Set(traces).size).toBeGreaterThanOrEqual(10)
    }),
  )

  Seed.effect(
    "against the reference model: steers once and in order, idle sessions take their work, restarts lose nothing, time moves only when advanced",
    Effect.forEach(SEEDS, (seed) => runOf(seed, invariants({ stored: new Map(), messages: new Map(), lines: 0 })).pipe(Effect.map(oneAtATime)), {
      discard: true,
    }),
  )

  Seed.effect(
    "a pooled run replays byte for byte: pooled turns, plan limits, refresh faults, resets and restarts; 50 seeds give at least 10 different runs",
    Effect.gen(function* () {
      const traces = yield* Effect.forEach(SEEDS, (seed) =>
        Effect.gen(function* () {
          const replay = (run: { readonly world: World }) => `${run.world.trace()}\n${line(run.world.provider().received())}`
          const first = replay(yield* pooledRun(seed))
          expect(replay(yield* pooledRun(seed)), `seed ${seed}`).toBe(first)
          return first
        }),
      )
      expect(new Set(traces).size).toBeGreaterThanOrEqual(10)
    }),
  )

  Seed.effect(
    "against the pooled model: every request on one known login, none on a login before the reset it was refused to, no refresh token traded twice, no grant claimed twice or unlisted",
    Effect.gen(function* () {
      const claims = yield* Effect.forEach(SEEDS, (seed) =>
        pooledRun(seed, pooledInvariants(seed)).pipe(
          Effect.map(({ world }) => {
            oneAtATime(world)
            return world.provider().claims()
          }),
        ),
      )
      // The runs reach the claims the invariants are about: taken, and refused by a failing claim endpoint.
      const results = new Set(claims.flat().map((claim) => claim.result))
      expect([...results].toSorted()).toEqual(["cooldown", "rate-limited", "reset", "unavailable"])
    }),
  )

  Seed.effect(
    "a simulated hour costs milliseconds",
    Effect.gen(function* () {
      const world = yield* worldOf(7)
      const sessions = yield* Effect.forEach([0, 1, 2], () => world.session("/work"))
      yield* Effect.forEach(sessions, (session, index) =>
        world.prompt(session, "start").pipe(Effect.andThen(world.tool(session, "wake", { afterSeconds: 60 * (index + 1), everySeconds: 300, note: "tick" }))),
      )
      const started = yield* Clock.currentTimeMillis
      yield* world.advance(3_600_000)
      const cost = (yield* Clock.currentTimeMillis) - started
      yield* Effect.logInfo(`sim: one simulated hour (3 sessions, repeating alarms, idle compaction) took ${cost} ms of wall time`)
      expect(world.elapsed()).toBeGreaterThanOrEqual(3_600_000)
      expect(cost).toBeLessThan(2_000)
    }),
  )
})

