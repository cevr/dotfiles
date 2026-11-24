// A model of the store's waiters on the simulated world, at 20 seeds and the past failing ones: one login of a store,
// several resolves of it in this process (each a turn: resolve, send, and on a 401 tell the store), and another
// process holding the same store that trades the login, fails its write some times, lands it, and holds the lock
// again under a slow trade. The seed draws the interleaving: when a turn starts, how long each wait lasts, when a
// held write lands, when the endpoint answers, when a token falls due.
//
// The property, at the moment each resolve serves a token:
// - no token is served after the file replaced its login with a newer one (a held write landed, another writer);
// - no token is served after a provider refused it (401) in this process;
// and every turn ends, served or failed (busy, so the pool fails over), none left waiting once the faults stop.
import { Cause, Effect, Exit, Fiber, Match, Option } from "effect"
import * as MemorySlots from "@dotfiles/opencode-pool/memory/slots"
import {
  decodeStoredOAuth,
  encodeRefresh,
  type SlotFiles,
  STORE_PREFIX,
  type StoreCredentialError,
  StoreSource,
  type StoreUnreadable,
  storeProcess,
} from "@dotfiles/opencode-pool/store/store"
import * as Provider from "../../sim/provider.ts"
import { below, generator, line } from "../../sim/runtime.ts"
import { simulationRunner } from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

/** Seeds found failing, replayed on every run. */
const PAST: ReadonlyArray<number> = []

const { seeded } = simulationRunner("cmd/pool/pool-waiter.sim.test.ts", { past: PAST })

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const STORE = "/scratch/store-waiter"
const LOGIN = "beta"
const ID = `${STORE_PREFIX}${LOGIN}`
const SLOT = `${STORE}/.slots/anthropic/${LOGIN}`
const TOKEN_URL = `${Provider.ORIGIN}/v1/oauth/token`

type Command =
  /** A turn in this process: resolve, send, tell the store of a 401. */
  | { readonly type: "turn" }
  /** The other process trades the login, due its refresh but still good, its next `fails` writes failing. */
  | { readonly type: "trade"; readonly fails: number }
  /** The other process trades the login, its token past its expiry, the endpoint answering `delayMs` late: it holds the lock meanwhile. */
  | { readonly type: "slow"; readonly delayMs: number }
  /** The login's token in the file expires `inMs` from now. */
  | { readonly type: "expire"; readonly inMs: number }
  | { readonly type: "write-fails"; readonly times: number }
  | { readonly type: "advance"; readonly ms: number }

const STEPS = [1_000, 5_000, 10_000, 15_000, 20_000, 30_000, 45_000, 60_000, 2 * MINUTE] as const
/** A token past its expiry, or due its refresh but still good. */
const EXPIRIES = [-1_000, 3 * MINUTE] as const

const commandOf = (random: ReturnType<typeof generator>): Command => {
  const pick = below(random, 16)
  if (pick < 5) return { type: "turn" }
  if (pick < 7) return { type: "trade", fails: 1 + below(random, 6) }
  if (pick < 8) return { type: "slow", delayMs: (1 + below(random, 10)) * MINUTE }
  if (pick < 9) return { type: "expire", inMs: EXPIRIES[below(random, EXPIRIES.length)] }
  if (pick < 10) return { type: "write-fails", times: 1 + below(random, 5) }
  return { type: "advance", ms: STEPS[below(random, STEPS.length)] }
}

/**
 * Up to 40 commands; at a point the seed chooses, the class's run: another holder's trade whose write fails a few
 * times, turns that wait on it, then a slow trade that holds the lock past their waits.
 */
const commandsOf = (seed: number): ReadonlyArray<Command> => {
  const random = generator(`pool-waiter:${seed}`)
  const commands = Array.from({ length: 10 + below(random, 31) }, () => commandOf(random))
  const run: Array<Command> = [
    { type: "trade", fails: 2 + below(random, 5) },
    { type: "turn" },
    { type: "turn" },
    { type: "advance", ms: STEPS[below(random, STEPS.length)] },
    { type: "expire", inMs: -1_000 },
    { type: "slow", delayMs: 10 * MINUTE },
    { type: "advance", ms: STEPS[below(random, STEPS.length)] },
  ]
  commands.splice(below(random, commands.length + 1), 0, ...run)
  return commands
}

/**
 * The fault sim's lasting seed 820992407, as this model plays it: another holder's trade whose write fails twice and
 * lands at 20 s (written again every 10 s, the lock kept); two turns that started on the token it retired and wait
 * on the lock; at the instant it lands, the other holder trades again, slowly, so the lock stays held past both waits.
 */
const TRACE: ReadonlyArray<Command> = [
  { type: "trade", fails: 2 },
  { type: "advance", ms: 5 },
  { type: "turn" },
  { type: "turn" },
  { type: "advance", ms: 19_995 },
  { type: "slow", delayMs: 10 * MINUTE },
  { type: "advance", ms: 2 * MINUTE },
]

/** The kind a resolve failed with, `StoreUnreadable` for an unreadable store, `died` for a defect. */
const failedWith = (cause: Cause.Cause<StoreCredentialError | StoreUnreadable>): string =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => "died",
    onSome: (error) =>
      Match.value(error).pipe(
        Match.tag("StoreCredentialError", (failed): string => failed.kind),
        Match.orElse((failed) => failed._tag),
      ),
  })

/** The model run on `commands`: what broke the property, and how each turn ended. */
const model = (seed: number, commands: ReadonlyArray<Command>) =>
  Effect.gen(function* () {
    const answers: Array<Provider.TokenAnswer> = []
    const world = World.make({
      seed,
      script: () => World.say(""),
      anthropic: {
        accounts: Provider.accounts(seed, [LOGIN]),
        token: () => answers.shift() ?? { kind: "rotate" },
        script: () => ({ kind: "ok", text: "answered" }),
      },
    })
    const provider = world.provider()
    const slots = MemorySlots.make()
    const broken: Array<string> = []
    /** Access tokens whose login the file replaced with another (a new refresh token). */
    const superseded = new Set<string>()
    /** Access tokens a provider refused in this process. */
    const refused = new Set<string>()
    const held = () => Option.flatMap(slots.get(SLOT), (text) => Option.fromNullishOr(decodeStoredOAuth(text)))
    // Each write that lands, either holder's: the login it replaced is superseded once its refresh token changed.
    const files: SlotFiles = {
      ...slots.files,
      write: (path, content) =>
        Effect.suspend(() => {
          const before = held()
          return slots.files.write(path, content).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                const after = held()
                if (Option.isSome(before) && Option.isSome(after) && before.value.refresh !== after.value.refresh) superseded.add(before.value.access)
              }),
            ),
          )
        }),
    }
    const signed = { ...provider.tokens(LOGIN), expires: World.START + 8 * HOUR }
    slots.put(SLOT, encodeRefresh({ type: "oauth", ...signed, metadata: { owner: "store" } }, signed))
    const context = yield* world.runtime.run(Effect.context<never>())
    const sourceIn = () =>
      new StoreSource({ dir: STORE, tokenURL: TOKEN_URL, fetch: (url, init) => provider.fetch(url, init), files, process: storeProcess(), context })
    const ours = sourceIn()
    const other = sourceIn()
    const turns: Array<Fiber.Fiber<string>> = []

    const turn = (n: number) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(ours.resolveEffect(ID))
        if (Exit.isFailure(exit)) {
          if (Option.isNone(Cause.findErrorOption(exit.cause))) broken.push(`turn ${n} died: ${Cause.pretty(exit.cause)}`)
          return failedWith(exit.cause)
        }
        const { access } = exit.value
        if (superseded.has(access)) broken.push(`turn ${n} at ${world.now()}: served a token whose login the file had replaced`)
        if (refused.has(access)) broken.push(`turn ${n} at ${world.now()}: served a token a provider had refused`)
        const response = yield* Effect.promise(() =>
          provider.fetch(`${Provider.ORIGIN}/v1/messages`, {
            method: "POST",
            headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
            body: line({ model: "claude-fake", tools: [{ name: "tool" }] }),
          }),
        )
        if (response.status !== 401) return "served"
        refused.add(access)
        ours.rejected(ID, access)
        return "refused"
      })

    const expire = (inMs: number) =>
      Option.map(held(), (login) => slots.put(SLOT, encodeRefresh(login, { ...login, expires: world.now() + inMs })))

    for (const command of commands) {
      if (command.type === "turn") turns.push(world.runtime.fork(turn(turns.length)))
      if (command.type === "trade") {
        expire(3 * MINUTE)
        slots.failWrites(command.fails)
        world.runtime.fork(Effect.ignore(other.resolveEffect(ID)))
      }
      if (command.type === "slow") {
        expire(-1_000)
        answers.push({ kind: "rotate", delayMs: command.delayMs })
        world.runtime.fork(Effect.ignore(other.resolveEffect(ID)))
      }
      if (command.type === "expire") expire(command.inMs)
      if (command.type === "write-fails") slots.failWrites(command.times)
      if (command.type === "advance") yield* world.advance(command.ms)
      yield* world.runtime.settle
    }
    // The faults stop: every write works, the endpoint answers at once. Every turn ends.
    slots.failWrites(0)
    answers.splice(0)
    const ended = () => turns.every((fiber) => Option.isSome(Option.fromNullishOr(fiber.pollUnsafe())))
    yield* world.until(ended, 2 * HOUR, 10_000).pipe(Effect.catch(() => Effect.sync(() => void broken.push("a turn never ended"))))
    const outcomes = yield* Effect.forEach(
      turns.filter((fiber) => Option.isSome(Option.fromNullishOr(fiber.pollUnsafe()))),
      (fiber) => Fiber.join(fiber),
    )
    return { broken, outcomes }
  })

/** A login as a test writes it to the file. */
interface Login {
  readonly access: string
  readonly refresh: string
  readonly expires: number
}

/** What a test does while a resolve waits: write a login or any text to the file, or tell the store of a refusal. */
interface During {
  readonly put: (login: Login) => void
  readonly raw: (text: string) => void
  readonly source: StoreSource
  /** The login the file held when the resolve read it. */
  readonly first: { readonly access: string; readonly refresh: string }
}

/**
 * One resolve in this process of a login due its refresh but still good, while another process holds the store's lock
 * for the whole wait; `during` runs once the resolve has read the file and is waiting. How the resolve ended, the login
 * it read first, and how many trades went out.
 */
const waited = (seed: number, during: (now: During) => void) =>
  Effect.gen(function* () {
    const world = World.make({ seed, script: () => World.say(""), anthropic: { accounts: Provider.accounts(seed, [LOGIN]) } })
    const provider = world.provider()
    const slots = MemorySlots.make()
    const put = (login: Login) => slots.put(SLOT, encodeRefresh({ type: "oauth", ...login, metadata: { owner: "store" } }, login))
    const first = provider.tokens(LOGIN)
    put({ ...first, expires: World.START + 3 * MINUTE })
    const context = yield* world.runtime.run(Effect.context<never>())
    const source = new StoreSource({ dir: STORE, tokenURL: TOKEN_URL, fetch: (url, init) => provider.fetch(url, init), files: slots.files, process: storeProcess(), context })
    const release = slots.hold(STORE)
    const fiber = world.runtime.fork(Effect.exit(source.resolveEffect(ID)))
    yield* world.runtime.settle
    during({ put, raw: (text) => slots.put(SLOT, text), source, first })
    yield* world.until(() => Option.isSome(Option.fromNullishOr(fiber.pollUnsafe())), 2 * MINUTE, 1_000)
    release()
    const trades = provider.received().filter((request) => request.path === "/v1/oauth/token").length
    return { exit: yield* Fiber.join(fiber), first, trades }
  })

/** How a resolve ended: `served`, or the kind it failed with. */
const kindOf = (exit: Exit.Exit<{ access: string }, StoreCredentialError | StoreUnreadable>) =>
  Exit.match(exit, { onSuccess: () => "served", onFailure: failedWith })

seeded("after a whole wait, the file still holding the login read before it serves that token", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { exit, first, trades } = yield* waited(seed, () => {})
    expect(Exit.isSuccess(exit) && exit.value.access, `seed ${seed}`).toBe(first.access)
    expect(trades).toBe(0)
  }),
)

seeded("after a whole wait, another login in the file, good for hours, fails busy: the holder may be trading it", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { exit } = yield* waited(seed, ({ put }) => put({ access: "sim-access-other", refresh: "sim-refresh-other", expires: World.START + 8 * HOUR }))
    expect(kindOf(exit), `seed ${seed}`).toBe("busy")
  }),
)

seeded("after a whole wait, the same login with a new access token in the file serves the file's token", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { exit } = yield* waited(seed, ({ put, first }) => put({ access: "sim-access-renewed", refresh: first.refresh, expires: World.START + 3 * MINUTE }))
    expect(Exit.isSuccess(exit) && exit.value.access, `seed ${seed}`).toBe("sim-access-renewed")
  }),
)

seeded("after a whole wait, the same login a provider refused meanwhile fails busy", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { exit } = yield* waited(seed, ({ source, first }) => source.rejected(ID, first.access))
    expect(kindOf(exit), `seed ${seed}`).toBe("busy")
  }),
)

seeded("after a whole wait, a file that no longer decodes fails busy", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { exit } = yield* waited(seed, ({ raw }) => raw("{ not a sign-in"))
    expect(kindOf(exit), `seed ${seed}`).toBe("busy")
  }),
)

// A refusal of a token the file no longer holds is not remembered: every path that serves reads the file at its
// decision (a waiter again after its wait), and a refresh token, once traded, never comes back to the file, so the
// refused token cannot be served again; the login the file holds now is not taken for refused either.
seeded("a refusal of a token the file already replaced records nothing: the file's login serves, untraded", ({ seed, expect }) =>
  Effect.gen(function* () {
    const world = World.make({ seed, script: () => World.say(""), anthropic: { accounts: Provider.accounts(seed, [LOGIN]) } })
    const provider = world.provider()
    const slots = MemorySlots.make()
    const now = { access: "sim-access-now", refresh: "sim-refresh-now", expires: World.START + 8 * HOUR }
    slots.put(SLOT, encodeRefresh({ type: "oauth", ...now, metadata: { owner: "store" } }, now))
    const context = yield* world.runtime.run(Effect.context<never>())
    const source = new StoreSource({ dir: STORE, tokenURL: TOKEN_URL, fetch: (url, init) => provider.fetch(url, init), files: slots.files, process: storeProcess(), context })
    source.rejected(ID, provider.tokens(LOGIN).access)
    const served = yield* world.runtime.run(source.resolveEffect(ID))
    expect(served.access, `seed ${seed}`).toBe(now.access)
    expect(yield* world.runtime.run(source.peekEffect(ID)), `seed ${seed}`).toEqual({ access: now.access, expires: now.expires })
    expect(provider.received().filter((request) => request.path === "/v1/oauth/token")).toEqual([])
  }),
)

seeded("a waiter never serves a token whose login the file replaced or a provider refused, and every turn ends", ({ seed, expect }) =>
  Effect.gen(function* () {
    const commands = commandsOf(seed)
    const { broken } = yield* model(seed, commands)
    expect(broken, `seed ${seed}: ${line(commands)}`).toEqual([])
  }),
)

seeded("the fault sim's seed 820992407: two waiters on a held write that lands, then a slow trade, send no retired token", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { broken, outcomes } = yield* model(seed, TRACE)
    expect(broken, `seed ${seed}`).toEqual([])
    expect(outcomes, `seed ${seed}`).toHaveLength(2)
  }),
)
