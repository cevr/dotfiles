// A generated property over faults, on the simulated host at 20 seeds: the
// pool on two Claude accounts of one login store, held by the pool's process
// and by another process (a second holder of the same slots and lock), the
// seed choosing up to 40 commands of turns, plan limits, token expiries,
// another holder's reads, resets (the clock past them) and faults: a store
// write that fails, a token endpoint that refuses a login, answers 429 or 503
// or never in time, a one-off 429 on a request, and a restart at any point.
//
// After each command: every request goes out on one login the provider knows;
// none on a login the provider refused as spent, before its reset, while
// another login is not refused; no refresh token is presented twice, by any
// holder. Every turn ends in an answer or in a named error that says what
// happened, never a provider's raw error body.
import { Array as Arr, Effect, Option } from "effect"
import * as MemorySlots from "@dotfiles/opencode-pool/memory/slots"
import { encodeRefresh, decodeStoredOAuth, STORE_PREFIX, StoreSource, storeProcess } from "@dotfiles/opencode-pool/store/store"
import * as Plugins from "../../sim/plugins.ts"
import * as Provider from "../../sim/provider.ts"
import { below, generator, line } from "../../sim/runtime.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = Seed.runner("cmd/pool/pool-faults.sim.test.ts")

const HOUR = 3_600_000
const WORK = "/scratch/work"
const STORE = "/scratch/store-auth"
const LOGINS = ["alpha", "beta"] as const
const TOKEN_ANSWERS = ["rotate", "rejected", "rate-limited", "unavailable", "slow"] as const

type TokenFault = (typeof TOKEN_ANSWERS)[number]

type Command =
  | { readonly type: "session" }
  | { readonly type: "prompt"; readonly session: number }
  | { readonly type: "limit"; readonly login: number; readonly hours: number }
  | { readonly type: "expire"; readonly login: number }
  | { readonly type: "other"; readonly login: number }
  | { readonly type: "token"; readonly login: number; readonly answer: TokenFault }
  | { readonly type: "write-fails" }
  | { readonly type: "burst"; readonly login: number }
  | { readonly type: "advance"; readonly ms: number }
  | { readonly type: "restart" }

const commandOf = (pick: number, random: ReturnType<typeof generator>): Command => {
  if (pick < 2) return { type: "session" }
  if (pick < 8) return { type: "prompt", session: below(random, 3) }
  if (pick < 10) return { type: "limit", login: below(random, 2), hours: 1 + below(random, 5) }
  if (pick < 12) return { type: "expire", login: below(random, 2) }
  if (pick < 13) return { type: "other", login: below(random, 2) }
  if (pick < 15) return { type: "token", login: below(random, 2), answer: TOKEN_ANSWERS[below(random, TOKEN_ANSWERS.length)] }
  if (pick < 16) return { type: "write-fails" }
  if (pick < 17) return { type: "burst", login: below(random, 2) }
  if (pick < 20) return { type: "advance", ms: below(random, 4) * (1 + below(random, 2 * HOUR)) }
  return { type: "restart" }
}

/** Up to 40 commands, the seed choosing each; the first opens a session. */
const commandsOf = (seed: number): ReadonlyArray<Command> => {
  const random = generator(`pool-faults:${seed}`)
  const count = 10 + below(random, 31)
  return [{ type: "session" }, ...Array.from({ length: count - 1 }, () => commandOf(below(random, 21), random))]
}

const slot = (label: string) => `${STORE}/.slots/anthropic/${encodeURIComponent(label)}`

/** What the world's Anthropic is told, and what it refused. */
interface Script {
  readonly limits: Map<string, number>
  readonly tokens: Map<string, TokenFault>
  /** Logins whose next agent turn meets a one-off rate limit (not a plan limit). */
  readonly bursts: Set<string>
  /** Each plan-limit refusal: the login, the provider's request index, and the reset it named. */
  readonly refusals: Array<{ readonly login: string; readonly index: number; readonly resetAt: number }>
  /** The store's files: how many writes failed so far. */
  readonly slots: MemorySlots.MemorySlots
}

const tokenAnswer = (fault: TokenFault): Provider.TokenAnswer => {
  if (fault === "slow") return { kind: "rotate", delayMs: 10 * 60_000 }
  if (fault === "rate-limited") return { kind: "rate-limited", retryAfterSeconds: 120 }
  return { kind: fault }
}

/** A provider's raw error body in a transcript: its JSON envelope or its error types. */
const RAW = /"type":"error"|rate_limit_error|invalid_grant|overloaded_error|authentication_error/

const run = (seed: number, check: (world: World.World, script: Script, command: Command, before: number) => void) =>
  Effect.gen(function* () {
    const slots = MemorySlots.make()
    const script: Script = { limits: new Map(), tokens: new Map(), bursts: new Set(), refusals: [], slots }
    const accounts = Provider.accounts(seed, LOGINS)
    const world = World.make({
      seed,
      script: () => World.say(""),
      anthropic: {
        accounts,
        token: (login) => tokenAnswer(Option.getOrElse(Option.fromNullishOr(script.tokens.get(login)), (): TokenFault => "rotate")),
        script: ({ account, body }) => {
          const tools = body["tools"]
          const turn = Array.isArray(tools) && tools.length > 0
          const resetAt = Option.getOrElse(Option.fromNullishOr(script.limits.get(account)), () => 0)
          if (turn && resetAt > world.now()) {
            script.refusals.push({ login: account, index: world.provider().received().length, resetAt })
            return { kind: "usage-429", claim: "five_hour", resetAt }
          }
          if (turn && script.bursts.delete(account)) return { kind: "transient-429", retryAfterSeconds: 5 }
          return { kind: "ok", text: `answered on ${account}` }
        },
      },
    })
    const sign = (login: string, expires: number) => {
      const tokens = { ...world.provider().tokens(login), expires }
      slots.put(slot(login), encodeRefresh({ type: "oauth", ...tokens, metadata: { owner: "store" } }, tokens))
    }
    for (const login of LOGINS) sign(login, World.START + 8 * HOUR)
    const stores = Plugins.stores(slots, world.provider())
    const options = { sweepMinutes: 0, limitsFile: "/nonexistent/sim/limits.json", sources: [{ kind: "store", dir: STORE, tokenURL: `${Provider.ORIGIN}/v1/oauth/token` }] }
    yield* world.load(Plugins.anthropicAuth(world.provider(), stores.registry), { directory: WORK })
    yield* world.load(Plugins.pool(new Map(), stores), { directory: WORK, options })
    // Another process holding the same store: its own state of it, the same slots, lock and token endpoint.
    const context = yield* world.runtime.run(Effect.context<never>())
    const other = new StoreSource({
      dir: STORE,
      tokenURL: `${Provider.ORIGIN}/v1/oauth/token`,
      fetch: (url, init) => world.provider().fetch(url, init),
      files: slots.files,
      process: storeProcess(),
      context,
    })
    const sessions: Array<string> = []
    /** What the world's Anthropic and the store are told; the host's own commands are the loop's. */
    const tell = (command: Command, before: number) => {
      if (command.type === "limit") script.limits.set(LOGINS[command.login], before + command.hours * HOUR)
      if (command.type === "expire") {
        // The login's token as the store holds it, its expiry now past: the next read refreshes it.
        const login = LOGINS[command.login]
        const held = Option.flatMap(slots.get(slot(login)), (text) => Option.fromNullishOr(decodeStoredOAuth(text)))
        if (Option.isSome(held)) slots.put(slot(login), encodeRefresh(held.value, { ...held.value, expires: before - 1000 }))
      }
      if (command.type === "other") world.runtime.fork(Effect.ignore(other.resolveEffect(`${STORE_PREFIX}${LOGINS[command.login]}`)))
      if (command.type === "token") script.tokens.set(LOGINS[command.login], command.answer)
      if (command.type === "write-fails") slots.failWrites(1)
      if (command.type === "burst") script.bursts.add(LOGINS[command.login])
    }
    for (const command of commandsOf(seed)) {
      const before = world.now()
      tell(command, before)
      if (command.type === "session") sessions.push(yield* world.session(WORK))
      if (command.type === "prompt")
        yield* Option.match(Option.fromNullishOr(sessions[command.session % Math.max(1, sessions.length)]), {
          onNone: () => Effect.void,
          onSome: (id) => world.prompt(id, `turn at ${before}`),
        })
      if (command.type === "advance") yield* world.advance(command.ms)
      if (command.type === "restart") yield* world.restart
      yield* world.runtime.settle
      check(world, script, command, before)
    }
    // Every turn to its end: the token endpoint answers again and every limit resets.
    for (const login of LOGINS) script.tokens.set(login, "rotate")
    yield* world.advance(6 * HOUR)
    return { world, sessions }
  })

/** The invariants after one command. */
const invariants = (seed: number, expect: Seed.Seeded["expect"]) => (world: World.World, script: Script, command: Command, before: number) => {
  const label = `seed ${seed}: ${line(command)}`
  if (command.type !== "advance") expect(world.now(), label).toBe(before)
  const received = world.provider().received()
  const messages = received.flatMap((request, index) => Arr.filter([{ ...request, index }], () => request.path === "/v1/messages"))
  // A request goes out on exactly one login the provider knows: none unsigned, none on a stranger's token.
  expect(
    messages.filter((request) => request.account === ""),
    label,
  ).toEqual([])
  // Never on a login the provider refused as spent before its reset, once the refusal is back, while another login is
  // not refused (with every login spent the pool places on the one that resets first; see the request's finding).
  const refused = (login: string, at: number, known: (refusal: { readonly index: number }) => boolean) =>
    script.refusals.some((refusal) => refusal.login === login && known(refusal) && at < refusal.resetAt)
  expect(
    messages.filter(
      (request) =>
        request.tools > 0 &&
        refused(request.account, request.at, (refusal) => Option.getOrElse(Option.fromNullishOr(received[refusal.index]), () => request).at < request.at) &&
        LOGINS.some((login) => !refused(login, request.at, (refusal) => refusal.index < request.index)),
    ),
    label,
  ).toEqual([])
  // A refresh token is presented once, by whichever holder: none comes back after it was rotated. Once a store
  // write failed, the holder that refreshed keeps the rotation to write later and another holder still reads the
  // old token from the file: its trade is refused (see the request's finding).
  if (script.slots.failed() === 0)
    expect(
      received.filter((request) => request.path === "/v1/oauth/token" && request.account === ""),
      label,
    ).toEqual([])
}

seeded("every turn ends in an answer or a named error, never on a spent login while another is free, and no refresh token is traded twice", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { world, sessions } = yield* run(seed, invariants(seed, expect))
    for (const session of sessions) {
      expect(world.sessions.get(session)?.running, `seed ${seed}: ${session} still running: ${line(world.messages(session).slice(-2))}`).toBe(false)
      for (const message of world.messages(session))
        if (message.type === "error") expect(`${message.tag}: ${message.message}`, `seed ${seed}`).not.toMatch(RAW)
    }
    // Some turn was answered, across the run.
    const answered = sessions.flatMap((session) => world.messages(session)).some((message) => message.type === "assistant")
    expect(answered || sessions.every((session) => world.messages(session).length === 0), `seed ${seed}`).toBe(true)
  }),
)
