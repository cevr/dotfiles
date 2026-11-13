// The pool's login store source on the simulated world, each test at 20
// seeds: tests/pool-store.test.ts's names and claims, moved off the disk. The
// store is memory slots (mods/pool/memory/slots.ts, which keep the disk's laws
// in mods/pool/store/files-laws.ts), another process is a second process state
// over the same slots and lock, and the token endpoint is the world's
// Anthropic (sim/provider.ts, which answers as tests/fake-anthropic.ts does).
// Every token is drawn from the seed; every time is the world's.
import { Duration, Effect, Fiber, Option } from "effect"
import { credentialSource, processRegistry } from "../../mods/anthropic-auth/registry/credential-sources.ts"
import * as MemorySlots from "@dotfiles/opencode-pool/memory/slots"
import {
  CLAUDE_TOKEN_URL,
  decodeStoredOAuth,
  encodeRefresh,
  limitDetail,
  registerCredentialSource,
  STORE_PREFIX,
  type StoreCredentialError,
  type StoredOAuth,
  StoreSource,
  type StoreProcess,
  storeProcess,
} from "@dotfiles/opencode-pool/store/store"
import * as Provider from "../../sim/provider.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = Seed.runner("cmd/pool/pool-store.sim.test.ts")

const HOUR = 3_600_000
const STORE = "/scratch/store"
const SLOTS = `${STORE}/.slots/anthropic`
const TOKEN_URL = `${Provider.ORIGIN}/v1/oauth/token`
/** How long a step of a test may take on the world's clock. */
const LIMIT_MS = 120_000
const SIGNED_IN_AT = 1_700_000_000_000

interface Tokens {
  readonly access: string
  readonly refresh: string
  readonly expires: number
}

const slot = (label: string) => `${SLOTS}/${encodeURIComponent(label)}`

/** A sign-in as the store's own sign-in writes it: owned by the store unless `metadata` says otherwise. */
const signIn = (
  slots: MemorySlots.MemorySlots,
  label: string,
  tokens: Tokens,
  { metadata = OWNER, signedInAt = Option.none<number>() }: { readonly metadata?: Record<string, string>; readonly signedInAt?: Option.Option<number> } = {},
) => {
  const signedIn: StoredOAuth = { type: "oauth", ...tokens, metadata }
  const written = Option.match(signedInAt, { onNone: () => signedIn, onSome: (at): StoredOAuth => ({ ...signedIn, signedInAt: at }) })
  slots.put(slot(label), encodeRefresh(written, tokens))
}

/** The owner mark a sign-in to the store carries. */
const OWNER = { owner: "store" }

/** A rotation at once: the provider's default answer to a refresh. */
const rotate = (): Provider.TokenAnswer => ({ kind: "rotate" })

/** A header the response lacked, as the store reads it from the response. */
const absent = new Response("").headers.get("server")

/** `ms` on the world's clock, as another process's work in flight takes it. */
const busyFor = (bench: Bench, ms: number) => bench.world.runtime.clock.sleep(Duration.millis(ms))

/** The label's sign-in as the store decodes it, without its account id. */
const stored = (slots: MemorySlots.MemorySlots, label: string) =>
  Option.map(
    Option.flatMap(slots.get(slot(label)), (text) => Option.fromNullishOr(decodeStoredOAuth(text))),
    ({ accountId: _accountId, ...rest }) => rest,
  )

/**
 * A login store on a fresh world, signed in to each of `names` (owned by the
 * store, expiring at `expires`), and the world's Anthropic that knows their
 * tokens; `extra` names accounts drawn but not signed in.
 */
const bench = (
  seed: number,
  names: ReadonlyArray<string>,
  {
    expires = World.START + 8 * HOUR,
    token = rotate,
    extra = [],
  }: { readonly expires?: number; readonly token?: (account: string) => Provider.TokenAnswer; readonly extra?: ReadonlyArray<string> } = {},
) =>
  Effect.gen(function* () {
    const drawn = Provider.accounts(seed, [...names, ...extra])
    const known = Object.fromEntries(names.map((name) => [name, drawn[name]] as const))
    const world = World.make({ seed, script: () => World.say(""), anthropic: { accounts: known, token } })
    const slots = MemorySlots.make()
    for (const name of names) signIn(slots, name, { ...drawn[name], expires }, { signedInAt: Option.some(SIGNED_IN_AT) })
    const provider = world.provider()
    // The world's clock and logger, as the plugin's context carries the host's.
    const context = yield* world.runtime.run(Effect.context<never>())
    /** A source over the store at `dir`, in `process` (this test's, or another process's). */
    const sourceIn = (process: StoreProcess, dir = STORE) =>
      new StoreSource({ dir, tokenURL: TOKEN_URL, fetch: (url, init) => provider.fetch(url, init), files: slots.files, process, context })
    /** The same, polling the store's lock `lockPolls` times only. */
    const pollingIn = (process: StoreProcess, lockPolls: number) =>
      new StoreSource({ dir: STORE, tokenURL: TOKEN_URL, fetch: (url, init) => provider.fetch(url, init), files: slots.files, process, context, lockPolls })
    const ours = storeProcess()
    return {
      world,
      slots,
      provider,
      drawn,
      ours,
      sourceIn,
      pollingIn,
      source: sourceIn(ours),
      trades: () => provider.received().filter((request) => request.path === "/v1/oauth/token").length,
      file: (label: string) => Option.getOrElse(slots.get(slot(label)), () => ""),
      /** Starts `effect` in the world; `settle` runs the world until every started fiber ends. */
      start: <A, E>(effect: Effect.Effect<A, E>) => world.runtime.fork(effect),
    }
  })

type Bench = Effect.Success<ReturnType<typeof bench>>

/** Runs the world, a step of its clock at a time, until each fiber ended; their results, in order. */
const ended = <A, E>(bench: Bench, fibers: ReadonlyArray<Fiber.Fiber<A, E>>) =>
  Effect.gen(function* () {
    yield* bench.world.runtime.settle
    yield* bench.world.until(() => fibers.every((fiber) => Option.isSome(Option.fromNullishOr(fiber.pollUnsafe()))), LIMIT_MS, 10)
    return yield* Effect.forEach(fibers, (fiber) => Fiber.join(fiber))
  })

/** `effect` run in the world to its end. */
const done = <A, E>(bench: Bench, effect: Effect.Effect<A, E>) =>
  ended(bench, [bench.start(effect)]).pipe(Effect.map(([value]) => value))

/** The store credential error `effect` fails with; any other end is a defect. */
const flipped = <A>(effect: Effect.Effect<A, StoreCredentialError | { readonly _tag: "StoreUnreadable" }>) =>
  Effect.flip(effect).pipe(
    Effect.flatMap((error) => {
      if (error._tag === "StoreCredentialError") return Effect.succeed(error)
      return Effect.die(error)
    }),
  )

/** The store credential error `effect` fails with, run in the world. */
const failure = <A>(bench: Bench, effect: Effect.Effect<A, StoreCredentialError | { readonly _tag: "StoreUnreadable" }>) => done(bench, flipped(effect))

/**
 * Another process's refresh of `label`, under the store's lock as the slot
 * files define it (polled while held): `hold` runs first with the lock held,
 * as a refresh in flight does; then `next` is written as a refresh writes it.
 * `next` answering none writes nothing, as a refresh that finds the token fresh.
 */
const otherRefresh = (
  bench: Bench,
  label: string,
  next: (current: Option.Option<Omit<StoredOAuth, "accountId">>) => Option.Option<Tokens>,
  hold: Effect.Effect<void> = Effect.void,
) => {
  const take: Effect.Effect<Effect.Effect<void>> = bench.slots.files.tryLock(STORE).pipe(
    Effect.flatMap(
      Option.match({
        onSome: (release) => Effect.succeed(release),
        onNone: () => busyFor(bench, 25).pipe(Effect.andThen(Effect.suspend(() => take))),
      }),
    ),
  )
  return Effect.acquireUseRelease(
    take,
    () =>
      Effect.gen(function* () {
        yield* hold
        const held = stored(bench.slots, label)
        const tokens = next(held)
        if (Option.isNone(held) || Option.isNone(tokens)) return
        yield* bench.slots.files.write(slot(label), encodeRefresh(held.value, tokens.value))
      }).pipe(Effect.orDie),
    (release) => release,
  )
}

// The endpoint Claude Code and the Anthropic auth plugin refresh at.
seeded("the store source refreshes at Claude Code's token endpoint", ({ expect }) =>
  Effect.sync(() => {
    expect(CLAUDE_TOKEN_URL).toBe("https://platform.claude.com/v1/oauth/token")
  }),
)

seeded("a 429's log line names who limited the request, and never more than the error's words", ({ expect }) =>
  Effect.sync(() => {
    expect(limitDetail("cloudflare", "60", "<html><body><h1>Error 1015</h1> You are being rate limited</body></html>")).toBe(
      'server cloudflare; retry-after 60; "Error 1015 You are being rate limited"',
    )
    expect(limitDetail(absent, absent, '{"error":{"type":"rate_limit_error","message":"Too many refreshes"}}')).toBe(
      'server unnamed; retry-after none; "rate_limit_error: Too many refreshes"',
    )
    expect(limitDetail("envoy", absent, "")).toBe("server envoy; retry-after none; empty body")
  }),
)

seeded("lists the accounts the store owns by label, and says why it leaves the rest alone", ({ seed, expect }) =>
  Effect.gen(function* () {
    const bench_ = yield* bench(seed, ["alpha", "beta-2"], { extra: ["default", "linked"] })
    const { slots, source, drawn, sourceIn, ours } = bench_
    // The default entry (Claude Code's login), a linked slot, a write in
    // flight and a file that is not a sign-in.
    signIn(slots, "default", { ...drawn["default"], expires: World.START + HOUR }, { metadata: {} })
    signIn(slots, "linked", { ...drawn["linked"], expires: World.START + HOUR }, { metadata: { source: "claude-code" } })
    slots.put(`${SLOTS}/.alpha.store-write-0a1b2c3d`, "{}")
    slots.put(`${SLOTS}/broken`, "{}")

    expect(source.list()).toEqual({
      accounts: [`${STORE_PREFIX}alpha`, `${STORE_PREFIX}beta-2`],
      skipped: [
        { label: "broken", reason: "does not decode as an OAuth sign-in" },
        { label: "linked", reason: "a linked Claude Code login, which Claude Code refreshes itself" },
      ],
    })
    expect(source.owns(`${STORE_PREFIX}alpha`)).toBe(true)
    expect(source.owns("alpha")).toBe(false)
    expect(source.owns(`${STORE_PREFIX}default`)).toBe(false)
    expect(sourceIn(ours, `${STORE}/missing`).list()).toEqual({ accounts: [], skipped: [] })
  }),
)

seeded("serves each slot's own token, read again for every request", ({ seed, expect }) =>
  Effect.gen(function* () {
    const bench_ = yield* bench(seed, ["alpha", "beta"], { extra: ["next", "linked"] })
    const { source, drawn, trades, slots } = bench_
    expect((yield* done(bench_, source.resolveEffect(`${STORE_PREFIX}alpha`))).access).toBe(drawn["alpha"].access)
    expect((yield* done(bench_, source.resolveEffect(`${STORE_PREFIX}beta`))).access).toBe(drawn["beta"].access)

    // Another process refreshes alpha meanwhile: the next request carries its new token.
    const next = { ...drawn["next"], expires: World.START + 8 * HOUR }
    yield* done(bench_, otherRefresh(bench_, "alpha", () => Option.some(next)))
    expect(yield* done(bench_, source.resolveEffect(`${STORE_PREFIX}alpha`))).toEqual({ access: next.access, expires: next.expires })
    expect(trades()).toBe(0)

    signIn(slots, "linked", { ...drawn["linked"], expires: World.START + HOUR }, { metadata: {} })
    expect((yield* failure(bench_, source.resolveEffect(`${STORE_PREFIX}linked`))).kind).toBe("not-owned")
    expect((yield* failure(bench_, source.resolveEffect(`${STORE_PREFIX}gone`))).kind).toBe("signed-out")
  }),
)

seeded("a stale token is refreshed once and written back in the store's exact shape, mode 0600", ({ seed, expect }) =>
  Effect.gen(function* () {
    const ours = yield* bench(seed, ["alpha"], { expires: World.START - 1000 })
    const account = ours.drawn["alpha"]
    const resolved = yield* done(ours, ours.source.resolveEffect(`${STORE_PREFIX}alpha`))
    const rotated = ours.provider.tokens("alpha")
    expect(ours.trades()).toBe(1)
    expect(resolved.access).toBe(rotated.access)
    expect(resolved.access).not.toBe(account.access)

    // The slot file's exact bytes: field order, a dropped account id as null, the sign-in's owner and stamp kept.
    expect(ours.file("alpha")).toBe(
      `{"_tag":"Oauth","type":"oauth","access":"${rotated.access}","refresh":"${rotated.refresh}","expires":${resolved.expires},"accountId":null,"metadata":{"owner":"store"},"signedInAt":1700000000000}`,
    )
    // The write went whole through the store's files, which write mode 0600 (files-laws.ts); nothing staged is left.
    expect([...(yield* ours.slots.files.names(SLOTS))]).toEqual(["alpha"])

    // It decodes back, its sign-in stamp and owner kept.
    expect(Option.map(stored(ours.slots, "alpha"), (login) => login._tag)).toEqual(Option.some("Oauth"))
    expect(Option.map(stored(ours.slots, "alpha"), ({ _tag: _decoded, ...login }) => login)).toEqual(
      Option.some({
        type: "oauth",
        access: rotated.access,
        refresh: rotated.refresh,
        expires: resolved.expires,
        metadata: { owner: "store" },
        signedInAt: SIGNED_IN_AT,
      }),
    )
    // And the next request serves it without another refresh.
    expect((yield* done(ours, ours.source.resolveEffect(`${STORE_PREFIX}alpha`))).access).toBe(rotated.access)
    expect(ours.trades()).toBe(1)
  }),
)

seeded("two processes refreshing the same stale slot at once make one refresh call", ({ seed, expect }) =>
  Effect.gen(function* () {
    const bench_ = yield* bench(seed, ["alpha"], { expires: World.START - 1000, token: () => ({ kind: "rotate", delayMs: 1500 }) })
    const { sourceIn, provider, trades, world } = bench_
    // Each process its own source and its own state of the store; the files and the lock are the host's.
    const ask = (process: StoreProcess) =>
      Effect.sync(() => world.runtime.now()).pipe(
        Effect.flatMap((began) => sourceIn(process).resolveEffect(`${STORE_PREFIX}alpha`).pipe(Effect.map((served) => ({ served: served.access, began })))),
      )
    const outputs = yield* ended(bench_, [bench_.start(ask(storeProcess())), bench_.start(ask(storeProcess()))])
    const served = provider.tokens("alpha").access
    expect(outputs.map((output) => output.served)).toEqual([served, served])
    expect(trades()).toBe(1)
    // Both asked while the other's refresh (1.5 s at the endpoint) could be in flight: a real race.
    expect(Math.abs(outputs[0].began - outputs[1].began)).toBeLessThan(1000)
  }),
)

seeded("in one process too, concurrent requests for a stale slot share one refresh", ({ seed, expect }) =>
  Effect.gen(function* () {
    const bench_ = yield* bench(seed, ["alpha"], { expires: World.START - 1000, token: () => ({ kind: "rotate", delayMs: 200 }) })
    const { sourceIn, ours, trades } = bench_
    const first = sourceIn(ours)
    const second = sourceIn(ours)
    const served = yield* ended(bench_, [
      bench_.start(first.resolveEffect(`${STORE_PREFIX}alpha`)),
      bench_.start(second.resolveEffect(`${STORE_PREFIX}alpha`)),
      bench_.start(first.resolveEffect(`${STORE_PREFIX}alpha`)),
    ])
    expect(new Set(served.map((credential) => credential.access)).size).toBe(1)
    expect(trades()).toBe(1)
  }),
)

seeded("a token another process refreshed while the pool waited for its lock is read again, not refreshed again", ({ seed, expect }) =>
  Effect.gen(function* () {
    const bench_ = yield* bench(seed, ["alpha"], { expires: World.START - 1000, extra: ["theirs"] })
    const { source, trades, world, drawn } = bench_
    const theirs = { ...drawn["theirs"], expires: World.START + 8 * HOUR }
    // The other process takes the lock; the pool asks while its refresh is in flight.
    const asked: Array<{ readonly at: number; readonly resolving: Fiber.Fiber<{ access: string; expires: number }, unknown> }> = []
    const ask = Effect.sync(() => asked.push({ at: world.runtime.now(), resolving: bench_.start(source.resolveEffect(`${STORE_PREFIX}alpha`)) }))
    yield* done(bench_, otherRefresh(bench_, "alpha", () => Option.some(theirs), ask.pipe(Effect.andThen(busyFor(bench_, 500)))))
    const answers: Array<{ readonly resolved: { access: string; expires: number }; readonly waited: boolean }> = []
    for (const { at, resolving } of asked) {
      const [resolved] = yield* ended(bench_, [resolving])
      answers.push({ resolved, waited: world.runtime.now() - at > 400 })
    }
    expect(answers).toEqual([{ resolved: { access: theirs.access, expires: theirs.expires }, waited: true }])
    expect(trades()).toBe(0)
  }),
)

seeded("another process, waiting for the lock while the pool refreshes, reads the pool's write and writes nothing", ({ seed, expect }) =>
  Effect.gen(function* () {
    const bench_ = yield* bench(seed, ["alpha"], { expires: World.START - 1000, token: () => ({ kind: "rotate", delayMs: 800 }), extra: ["theirs"] })
    const { source, provider, trades, world, drawn } = bench_
    const ours = bench_.start(source.resolveEffect(`${STORE_PREFIX}alpha`))
    yield* world.runtime.settle
    yield* world.runtime.advance(300)
    let seen = Option.none<string>()
    // The other process's refresh: it rereads under the lock and finds the token fresh.
    yield* done(
      bench_,
      otherRefresh(bench_, "alpha", (current) => {
        seen = Option.map(current, (login) => login.access)
        if (Option.isSome(current) && current.value.expires > world.runtime.now() + 60_000) return Option.none()
        return Option.some({ ...drawn["theirs"], expires: 0 })
      }),
    )
    const [resolved] = yield* ended(bench_, [ours])
    expect(seen).toEqual(Option.some(resolved.access))
    expect(resolved.access).toBe(provider.tokens("alpha").access)
    expect(trades()).toBe(1)
  }),
)

seeded("a refresh the endpoint could not answer writes nothing and may be tried again", ({ seed, expect }) =>
  Effect.gen(function* () {
    let answer: Provider.TokenAnswer = { kind: "unavailable" }
    const bench_ = yield* bench(seed, ["alpha"], { expires: World.START - 1000, token: () => answer })
    const { source, trades, file, world } = bench_
    const before = file("alpha")
    const error = yield* failure(bench_, source.resolveEffect(`${STORE_PREFIX}alpha`))
    expect(error.kind).toBe("unavailable")
    expect(error.retryAt).toBeGreaterThan(world.runtime.now())
    expect(file("alpha")).toBe(before)

    // The refresh token stays after an unclear failure: the next try spends it.
    answer = { kind: "rotate" }
    yield* done(bench_, source.resolveEffect(`${STORE_PREFIX}alpha`))
    expect(trades()).toBe(2)
    expect(file("alpha")).not.toBe(before)
  }),
)

seeded("a rate-limited refresh pauses every account of the store until retry-after", ({ seed, expect }) =>
  Effect.gen(function* () {
    let answer: Provider.TokenAnswer = { kind: "rate-limited", retryAfterSeconds: 120 }
    const bench_ = yield* bench(seed, ["alpha", "beta"], { expires: World.START - 1000, token: () => answer })
    const { source, trades, world } = bench_
    const first = yield* failure(bench_, source.resolveEffect(`${STORE_PREFIX}alpha`))
    expect(first.kind).toBe("unavailable")
    expect(first.message).toContain("answered 429 (server")
    expect(first.message).toContain("retry-after 120")
    expect(first.retryAt).toBeGreaterThan(world.runtime.now() + 110_000)
    // The other account waits too, without a request of its own.
    answer = { kind: "rotate" }
    const second = yield* failure(bench_, source.resolveEffect(`${STORE_PREFIX}beta`))
    expect(second.retryAt).toBe(first.retryAt)
    expect(trades()).toBe(1)
  }),
)

seeded("a refresh the endpoint refused writes nothing and asks for a new sign-in", ({ seed, expect }) =>
  Effect.gen(function* () {
    const bench_ = yield* bench(seed, ["alpha"], { expires: World.START - 1000, token: () => ({ kind: "rejected" }) })
    const { source, file } = bench_
    const before = file("alpha")
    const error = yield* failure(bench_, source.resolveEffect(`${STORE_PREFIX}alpha`))
    expect(error.kind).toBe("rejected")
    expect(error.retryAt).toBeUndefined()
    expect(file("alpha")).toBe(before)
  }),
)

seeded("a refresh whose write failed is held, and written later only over the login it replaced", ({ seed, expect }) =>
  Effect.gen(function* () {
    const bench_ = yield* bench(seed, ["alpha"], { expires: World.START - 1000 })
    const { slots, provider, source, trades, file } = bench_
    const before = file("alpha")
    // The store's directory refuses the write, as a read-only directory does.
    slots.failWrites(1)
    const error = yield* failure(bench_, source.resolveEffect(`${STORE_PREFIX}alpha`))
    expect(error.kind).toBe("persist")
    expect(file("alpha")).toBe(before)
    expect([...(yield* slots.files.names(SLOTS))]).toEqual(["alpha"])

    // The held tokens land on the next request, with no second refresh.
    const resolved = yield* done(bench_, source.resolveEffect(`${STORE_PREFIX}alpha`))
    expect(resolved.access).toBe(provider.tokens("alpha").access)
    expect(Option.map(stored(slots, "alpha"), (login) => login.refresh)).toEqual(Option.some(provider.tokens("alpha").refresh))
    expect(trades()).toBe(1)
  }),
)

seeded("a held refresh is dropped when another process wrote another login meanwhile", ({ seed, expect }) =>
  Effect.gen(function* () {
    const bench_ = yield* bench(seed, ["alpha"], { expires: World.START - 1000, extra: ["theirs"] })
    const { slots, source, trades, drawn } = bench_
    slots.failWrites(1)
    expect((yield* failure(bench_, source.resolveEffect(`${STORE_PREFIX}alpha`))).kind).toBe("persist")

    const theirs = { ...drawn["theirs"], expires: World.START + 8 * HOUR }
    signIn(slots, "alpha", theirs, { signedInAt: Option.some(1_800_000_000_000) })
    expect(yield* done(bench_, source.resolveEffect(`${STORE_PREFIX}alpha`))).toEqual({ access: theirs.access, expires: theirs.expires })
    expect(Option.map(stored(slots, "alpha"), (login) => login.refresh)).toEqual(Option.some(theirs.refresh))
    expect(trades()).toBe(1)
  }),
)

seeded("a token the provider rejected is refreshed next time, only while the store still holds it", ({ seed, expect }) =>
  Effect.gen(function* () {
    const bench_ = yield* bench(seed, ["alpha"])
    const { source, trades, drawn } = bench_
    const account = drawn["alpha"]
    source.rejected(`${STORE_PREFIX}alpha`, "sim-access-some-older-token")
    expect((yield* done(bench_, source.resolveEffect(`${STORE_PREFIX}alpha`))).access).toBe(account.access)
    expect(trades()).toBe(0)

    source.rejected(`${STORE_PREFIX}alpha`, account.access)
    const next = yield* done(bench_, source.resolveEffect(`${STORE_PREFIX}alpha`))
    expect(next.access).not.toBe(account.access)
    expect(trades()).toBe(1)
  }),
)

seeded("gives up on a lock another process holds too long, with a time to try again", ({ seed, expect }) =>
  Effect.gen(function* () {
    const bench_ = yield* bench(seed, ["alpha"], { expires: World.START - 1000 })
    const { pollingIn, trades, world } = bench_
    // The pool asks while the other process holds the lock, and polls it 5 times only.
    const asked: Array<Fiber.Fiber<StoreCredentialError, { access: string; expires: number }>> = []
    const ask = Effect.sync(() =>
      asked.push(bench_.start(flipped(pollingIn(storeProcess(), 5).resolveEffect(`${STORE_PREFIX}alpha`)))),
    )
    yield* done(bench_, otherRefresh(bench_, "alpha", () => Option.none(), ask.pipe(Effect.andThen(busyFor(bench_, 1000)))))
    const errors = yield* ended(bench_, asked)
    expect(errors.map((error) => ({ kind: error.kind, later: (error.retryAt ?? 0) > world.runtime.now() }))).toEqual([{ kind: "busy", later: true }])
    expect(trades()).toBe(0)
  }),
)

seeded("registers with the registry the auth plugin reads, and leaves it on dispose", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { source } = yield* bench(seed, ["alpha"])
    const unregister = registerCredentialSource("anthropic-store-test", source)
    expect(processRegistry().get("anthropic-store-test")).toBeInstanceOf(Set)
    expect(credentialSource("anthropic-store-test", `${STORE_PREFIX}alpha`)).toBe(source)
    expect(credentialSource("anthropic-store-test", "cred_other")).toBeUndefined()
    unregister()
    expect(credentialSource("anthropic-store-test", `${STORE_PREFIX}alpha`)).toBeUndefined()
  }),
)
