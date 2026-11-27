// @reads all
// @reads-reason computed read at mods/guard/filesystem/repo-roots.ts: return yield* Effect.tryPromise({ try: () => stat(join(path, ".git")), catch: (cause) => cause
// A generated property over faults, on the simulated host at 20 seeds and the
// past failing ones: the
// pool on two Claude accounts of one login store, held by the pool's process
// and by another process (a second holder of the same slots and lock), the
// seed choosing up to 40 commands of turns, plan limits, token expiries,
// another holder's reads, resets (the clock past them) and faults: a store
// write that fails, a token endpoint that refuses a login, answers 429 or 503
// or never in time, a one-off 429 on a request, and a restart at any point.
//
// After each command: every request goes out on one login the provider knows;
// none on a login the provider refused as spent, before its reset; no refresh
// token is presented twice, by any holder. Every turn ends in an answer or in
// the pool's own refusal and when its first account opens (or a sign-in the
// store asks for), never the provider's refusal or its raw error body. Then,
// every limit past and no fault left, one more turn in each session is
// answered, or names the sign-in when every login's refresh token was refused.
import { Array as Arr, Effect, Option } from "effect"
import * as MemorySlots from "@dotfiles/opencode-pool/memory/slots"
import { encodeRefresh, decodeStoredOAuth, STORE_PREFIX, StoreSource, storeProcess } from "@dotfiles/opencode-pool/store/store"
import * as Plugins from "../../sim/plugins.ts"
import * as Provider from "../../sim/provider.ts"
import { below, generator, line } from "../../sim/runtime.ts"
import { simulationRunner, type Seeded as SeedSeeded } from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

/**
 * Seeds a wider sweep found failing (pool-seeds), replayed on every run: 1 to 500 in round 1; 1 to 1000 in round 2,
 * every login refused (522 and on); a refused login whose last trade, another holder's, met a 429 (39066929); another
 * holder's trade whose write failed, held past this process's whole lock wait, so it sent the token the trade retired
 * (744883142, the post-land run of dca79ac5).
 */
const PAST = [
  27, 50, 126, 130, 137, 141, 150, 160, 174, 216, 220, 223, 225, 241, 245, 251, 296, 300, 318, 327, 332, 346, 353, 388, 393, 437, 452, 483, 492,
  522, 582, 677, 956, 981, 994, 39066929, 744883142,
]

const { seeded } = simulationRunner("cmd/pool/pool-faults.sim.test.ts", { past: PAST })

/**
 * The revoked mode's seeds a sweep of 1 to 1000 found failing (pool-faults-bias), replayed on every run: a 401 held a
 * revoked store login for the host's refresh (181 and on), then a restart between a 401 and its retry (60 and on);
 * a plan limit whose reset fell between two seconds, announced up to a second early (452011062); a turn placed before
 * a restart whose mark was pruned, refused (401) after it: the pool could not name its login and left the provider's
 * words (1864123045); a due token served without the lock inside this process's trade gap, while another holder's
 * trade (its write held) had retired it (950002555).
 */
const REVOKED_PAST: ReadonlyArray<number> = [
  60, 163, 181, 210, 335, 392, 400, 426, 433, 454, 456, 506, 524, 536, 623, 686, 688, 731, 763, 765, 821, 922, 928, 935, 949, 994, 452011062, 1864123045, 950002555,
]

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
  /** The login's token expires `inMs` from now (past by a second when unnamed). */
  | { readonly type: "expire"; readonly login: number; readonly inMs?: number }
  | { readonly type: "other"; readonly login: number }
  | { readonly type: "token"; readonly login: number; readonly answer: TokenFault }
  /** The next `times` writes of the store fail (one when unnamed). */
  | { readonly type: "write-fails"; readonly times?: number }
  | { readonly type: "burst"; readonly login: number }
  | { readonly type: "advance"; readonly ms: number }
  | { readonly type: "restart" }
  /**
   * The revoked mode's: the login's grant is revoked; from now on the provider refuses its access token (401) and
   * every trade of its refresh token (400).
   */
  | { readonly type: "revoke"; readonly login: number }

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

/** Up to 40 commands, `random` choosing each; the first opens a session. */
const drawn = (random: ReturnType<typeof generator>): Array<Command> => {
  const count = 10 + below(random, 31)
  return [{ type: "session" }, ...Array.from({ length: count - 1 }, () => commandOf(below(random, 21), random))]
}

/** The default mode's commands of a seed. */
const commandsOf = (seed: number): ReadonlyArray<Command> => drawn(generator(`pool-faults:${seed}`))

/**
 * The revoked mode's commands of a seed, from a generator of its own (the default mode's seeds keep their runs): the
 * same draw, with each login revoked at a point the seed chooses, then each login's token past its expiry and a turn,
 * so the pool trades every revoked token at least once.
 */
const revokedCommandsOf = (seed: number): ReadonlyArray<Command> => {
  const random = generator(`pool-faults:revoked:${seed}`)
  const commands = drawn(random)
  for (const login of LOGINS.keys()) commands.splice(1 + below(random, commands.length), 0, { type: "revoke", login })
  return [...commands, { type: "expire", login: 0 }, { type: "expire", login: 1 }, { type: "prompt", session: 0 }]
}

/**
 * The lasting mode's commands of a seed, from a generator of its own: the same draw, each store write fault lasting
 * 2 to 6 writes, and at a point the seed chooses one more such fault, then another holder's trade of a login due its
 * refresh but still good (three minutes left) and a turn, so a held rotation outlasts this process's lock wait at least once.
 */
const lastingCommandsOf = (seed: number): ReadonlyArray<Command> => {
  const random = generator(`pool-faults:lasting:${seed}`)
  const commands = drawn(random).map((command): Command => {
    if (command.type !== "write-fails") return command
    return { type: "write-fails", times: 2 + below(random, 5) }
  })
  const login = below(random, 2)
  commands.splice(1 + below(random, commands.length), 0, { type: "write-fails", times: 2 + below(random, 5) }, { type: "expire", login, inMs: 3 * 60_000 }, { type: "other", login }, {
    type: "prompt",
    session: 0,
  })
  return commands
}

const slot = (label: string) => `${STORE}/.slots/anthropic/${encodeURIComponent(label)}`

/** What the world's Anthropic is told, and what it refused. */
interface Script {
  readonly limits: Map<string, number>
  readonly tokens: Map<string, TokenFault>
  /** Logins whose next agent turn meets a one-off rate limit (not a plan limit). */
  readonly bursts: Set<string>
  /** Logins whose refresh token is revoked: the endpoint refuses each trade of them, whatever `tokens` says. */
  readonly revoked: Set<string>
  /** Each plan-limit refusal: the login, the provider's request index, and the reset it named. */
  readonly refusals: Array<{ readonly login: string; readonly index: number; readonly resetAt: number }>
  /** The store's files: how many writes failed so far. */
  readonly slots: MemorySlots.MemorySlots
  /** How many requests the provider had received at each restart: a process's requests lie between two. */
  readonly restarts: Array<number>
}

const tokenAnswer = (fault: TokenFault): Provider.TokenAnswer => {
  if (fault === "slow") return { kind: "rotate", delayMs: 10 * 60_000 }
  if (fault === "rate-limited") return { kind: "rate-limited", retryAfterSeconds: 120 }
  return { kind: fault }
}

/** A provider's raw error body in a transcript: its JSON envelope or its error types. */
const RAW = /"type":"error"|rate_limit_error|invalid_grant|overloaded_error|authentication_error/

const run = (
  seed: number,
  commands: ReadonlyArray<Command>,
  check: (world: World.World, script: Script, command: Command, before: number) => void,
) =>
  Effect.gen(function* () {
    const slots = MemorySlots.make()
    const script: Script = { limits: new Map(), tokens: new Map(), bursts: new Set(), revoked: new Set(), refusals: [], slots, restarts: [] }
    const accounts = Provider.accounts(seed, LOGINS)
    const world = World.make({
      seed,
      script: () => World.say(""),
      anthropic: {
        accounts,
        token: (login) => {
          if (script.revoked.has(login)) return tokenAnswer("rejected")
          return tokenAnswer(Option.getOrElse(Option.fromNullishOr(script.tokens.get(login)), (): TokenFault => "rotate"))
        },
        script: ({ account, body }) => {
          const tools = body["tools"]
          const turn = Array.isArray(tools) && tools.length > 0
          // A revoked login's grant is gone: its access token is refused too, the rotations it had before included.
          if (script.revoked.has(account)) return { kind: "unauthorized" }
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
      // The reset on a whole second: the provider names it in whole seconds (the unified reset headers), so a reset
      // between two seconds would be announced up to a second before the script stops refusing.
      if (command.type === "limit") script.limits.set(LOGINS[command.login], Math.ceil((before + command.hours * HOUR) / 1000) * 1000)
      if (command.type === "expire") {
        // The login's token as the store holds it, its expiry now past: the next read refreshes it.
        const login = LOGINS[command.login]
        const held = Option.flatMap(slots.get(slot(login)), (text) => Option.fromNullishOr(decodeStoredOAuth(text)))
        if (Option.isSome(held)) slots.put(slot(login), encodeRefresh(held.value, { ...held.value, expires: before + (command.inMs ?? -1000) }))
      }
      if (command.type === "other") world.runtime.fork(Effect.ignore(other.resolveEffect(`${STORE_PREFIX}${LOGINS[command.login]}`)))
      if (command.type === "token") script.tokens.set(LOGINS[command.login], command.answer)
      if (command.type === "write-fails") slots.failWrites(command.times ?? 1)
      if (command.type === "burst") script.bursts.add(LOGINS[command.login])
      if (command.type === "revoke") script.revoked.add(LOGINS[command.login])
    }
    for (const command of commands) {
      const before = world.now()
      tell(command, before)
      if (command.type === "session") sessions.push(yield* world.session(WORK))
      if (command.type === "prompt")
        yield* Option.match(Option.fromNullishOr(sessions[command.session % Math.max(1, sessions.length)]), {
          onNone: () => Effect.void,
          onSome: (id) => world.prompt(id, `turn at ${before}`),
        })
      if (command.type === "advance") yield* world.advance(command.ms)
      if (command.type === "restart") {
        script.restarts.push(world.provider().received().length)
        yield* world.restart
      }
      yield* world.runtime.settle
      check(world, script, command, before)
    }
    // Every turn to its end: the token endpoint answers again (a revoked token stays refused) and every limit resets.
    for (const login of LOGINS) script.tokens.set(login, "rotate")
    yield* world.advance(6 * HOUR)
    // Then one more turn in each session, with no fault left (every limit past, no one-off rate limit waiting): each
    // must be answered (see the test).
    script.bursts.clear()
    for (const session of sessions) yield* world.prompt(session, "final turn")
    yield* world.runtime.settle
    yield* world.advance(HOUR)
    return { world, sessions }
  })

/** The invariants after one command. */
const invariants = (seed: number, expect: SeedSeeded["expect"], lasting: boolean) => (world: World.World, script: Script, command: Command, before: number) => {
  const label = `seed ${seed}: ${line(command)}`
  if (command.type !== "advance") expect(world.now(), label).toBe(before)
  const received = world.provider().received()
  const messages = received.flatMap((request, index) => Arr.filter([{ ...request, index }], () => request.path === "/v1/messages"))
  // A request goes out on exactly one login the provider knows: none unsigned, none on a stranger's token. Only while
  // writes keep failing (the lasting mode) may one go out on the token another holder's trade retired: that holder
  // keeps the rotation and the lock past this process's wait, which then serves the token the file holds. The provider
  // refuses it (401), and the pool fails over (store.ts, the held write).
  expect(
    messages.filter((request) => request.account === "" && !(lasting && request.status === 401 && Option.isSome(Option.fromNullishOr(request.retired)))),
    label,
  ).toEqual([])
  // The bound: one process sends a retired token once. A held rotation lasts up to (times - 1) × LAND_MS = 50 s past
  // its trade, and a waiter serves the stored token after the 30 s lock wait, so ⌈50 / 30⌉ = 2 waiters in a row could
  // each send it. The first one's 401 marks the login rejected in the store, and a waiter serves the token it read
  // only while no refusal names it: the second fails over without sending it.
  const epoch = (index: number) => script.restarts.filter((at) => at <= index).length
  const sent = messages.flatMap((request) => Arr.filter([`${epoch(request.index)} ${request.retired}`], () => Option.isSome(Option.fromNullishOr(request.retired))))
  expect(
    sent.filter((key, at) => sent.indexOf(key) !== at),
    `${label}: a retired token sent twice by one process`,
  ).toEqual([])
  // Never on a login the provider refused as spent before its reset, once the refusal is back: with every login spent
  // the pool refuses the turn itself.
  const refused = (login: string, at: number, known: (refusal: { readonly index: number }) => boolean) =>
    script.refusals.some((refusal) => refusal.login === login && known(refusal) && at < refusal.resetAt)
  expect(
    messages.filter(
      (request) =>
        request.tools > 0 &&
        refused(request.account, request.at, (refusal) => Option.getOrElse(Option.fromNullishOr(received[refusal.index]), () => request).at < request.at),
    ),
    label,
  ).toEqual([])
  // A refresh token is presented once, by whichever holder: none comes back after it was rotated, a store write
  // that failed included.
  expect(
    received.filter((request) => request.path === "/v1/oauth/token" && request.account === ""),
    label,
  ).toEqual([])
}

/** The pool's own refusal: every account held or an admission hold with its reason, and when to recheck. */
const POOL_REFUSAL = /^dotfiles-opencode\.pool: (?:all pool accounts are held|the request is held: [^\r\n]+); it may go again at ([A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}:\d{2} [AP]M (?:EST|EDT))$/
/**
 * A login whose refresh the token endpoint refused: the store's words, from the auth plugin's request hook; or the
 * pool's own refusal once every account is held for a new sign-in, naming them.
 */
const SIGN_IN =
  /^(?:The store account "(?:alpha|beta)" could not refresh \(400\)\. Sign in to it again\.|dotfiles-opencode\.pool: every pool account needs a new sign-in \(store:alpha, store:beta\)\. Sign in to them again; it may go again at [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}:\d{2} [AP]M (?:EST|EDT) if a login is signed in\.)$/

/** When the pool says to recheck, in epoch milliseconds. */
const opensAt = (message: string) => Option.fromUndefinedOr(POOL_REFUSAL.exec(message)?.[1]).pipe(Option.map((text) => Date.parse(text)), Option.filter(Number.isFinite))

/** The property on `commands`; whether its run ended with every login's refresh token refused. */
const property = (seed: number, expect: SeedSeeded["expect"], commands: ReadonlyArray<Command>, lasting = false) =>
  Effect.gen(function* () {
    const { world, sessions } = yield* run(seed, commands, invariants(seed, expect, lasting))
    for (const session of sessions) {
      expect(world.sessions.get(session)?.running, `seed ${seed}: ${session} still running: ${line(world.messages(session).slice(-2))}`).toBe(false)
      for (const message of world.messages(session)) {
        if (message.type !== "error") continue
        const said = `${message.tag}: ${message.message}`
        expect(said, `seed ${seed}`).not.toMatch(RAW)
        // Never the provider's refusal: the pool's, with a time to try again after the turn ended, or a sign-in.
        if (SIGN_IN.test(message.message)) continue
        expect(Option.getOrElse(opensAt(message.message), () => 0), `seed ${seed}: ${said}`).toBeGreaterThan(message.created)
      }
    }
    // The final turn, every limit past and the token endpoint answering, is answered in every session. Only when the
    // endpoint refused the refresh token of every login (a 400, and no rotation since) may it end in the store's
    // sign-in instead. A trade after the 400 that rotated nothing (a 429 or 503 another holder met) leaves it refused.
    const tokenTrades = world.provider().received().filter((request) => request.path === "/v1/oauth/token")
    const lost = LOGINS.every((login) => {
      const own = tokenTrades.filter((request) => request.account === login)
      const refused = own.findLastIndex((request) => request.status === 400)
      return refused >= 0 && !own.slice(refused + 1).some((request) => request.status === 200)
    })
    for (const session of sessions) {
      const messages = world.messages(session)
      const final = messages.slice(messages.findLastIndex((message) => message.type === "user") + 1)
      const answered = final.some((message) => message.type === "assistant")
      const signIn = lost && final.some((message) => message.type === "error" && SIGN_IN.test(message.message))
      expect(answered || signIn, `seed ${seed}: ${session}'s final turn: ${line(final)}`).toBe(true)
    }
    return lost
  })

seeded("every turn ends in an answer or the pool's own refusal with when it opens, never on a spent login, and no refresh token is traded twice", ({ seed, expect }) =>
  Effect.asVoid(property(seed, expect, commandsOf(seed))),
)

// The revoked mode: the default mode reaches a pool whose every login is refused only by chance (522 of 1 to 1000
// was its first); here each seed revokes both logins, and the property holds there too: every final turn names
// the sign-in.
const revoked = simulationRunner("cmd/pool/pool-faults.sim.test.ts", { past: REVOKED_PAST })

revoked.seeded("with every login's refresh token revoked, every turn still ends as the property says, and the final turn asks for a sign-in", ({ seed, expect }) =>
  Effect.gen(function* () {
    const lost = yield* property(seed, expect, revokedCommandsOf(seed))
    expect(lost, `seed ${seed}: the revoked mode ended with a login whose last trade was not refused`).toBe(true)
  }),
)

// The lasting mode: a store write that keeps failing (a full disk, a read-only mount). The holder that traded keeps the
// new tokens and the lock, writing again every 10 s, past another holder's 30 s wait. Expected: a waiter may send
// the token the trade retired (401), once per process, and fail over, but no refresh token is traded twice, every turn ends as the
// property says, and once writes work again every final turn is answered.
/**
 * The lasting mode's seeds found failing: two waiters in a row sent the same retired token (106497663); a held write
 * that landed during two waits, the lock then kept by a slow trade, so each waiter served the token it read before
 * its wait, which the file no longer held, and its 401 recorded nothing (820992407; cmd/pool/pool-waiter.sim.test.ts
 * models the class); a turn that failed over more often than the host retries (both logins' tokens unrefreshable for
 * minutes, then both at their plan limit), whose last refusal came back with no retry left, so it ended on Anthropic's
 * words and no time to try again (676134939, the deep run after c706a65c).
 */
const lasting = simulationRunner("cmd/pool/pool-faults.sim.test.ts", { past: [106497663, 820992407, 10285280, 10286953, 676134939] })

lasting.seeded("with store writes failing for a while, every turn still ends as the property says, and no refresh token is traded twice", ({ seed, expect }) =>
  Effect.asVoid(property(seed, expect, lastingCommandsOf(seed), true)),
)
