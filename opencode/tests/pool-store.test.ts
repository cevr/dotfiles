// accept: one at a time (it bounds how far apart two refreshes begin).
// The pool's login store source over a store in its slot-file format: the
// fixtures are slot files in temporary directories, another process's
// refreshes are made under the store's real lock (tests/store/store.ts), and
// the token endpoint is the fake Anthropic API. Every token is a fake drawn
// at run time. The names that rest on the store's logic alone run on the
// simulated world (cmd/pool/pool-store.sim.test.ts); the ones here rest on the
// disk or on two real processes as well (tests/parity.json says which).
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { Clock, Effect, Option } from "effect"
import { it } from "effect-bun-test"
import { decodeStoredOAuth, STORE_PREFIX, StoreCredentialError, StoreSource, storeProcess } from "../mods/pool/store/store.ts"
import { fakeAccount, startFakeAnthropic, type FakeAccount, type FakeAnthropic, type FakeTokenAnswer } from "./fake-anthropic.ts"
import { openSlotStore, type SlotStore } from "./store/store.ts"
import { owned } from "./owned.ts"
import { scratch } from "./scratch.ts"

const HOUR = 3_600_000
const root = scratch("pool-store-").path
afterAll(() => rmSync(root, { recursive: true, force: true }))

const fingerprint = (token: string) => createHash("sha256").update(token).digest("hex").slice(0, 16)

interface Bench {
  readonly dir: string
  readonly store: SlotStore
  readonly fake: FakeAnthropic
  readonly source: StoreSource
  readonly tokenURL: string
  /** The token endpoint calls the fake answered so far. */
  readonly trades: () => number
  /** The slot file's bytes. */
  readonly file: (label: string) => string
}

let fakes: FakeAnthropic[] = []
afterEach(async () => {
  await Promise.all(fakes.map((fake) => fake.stop()))
  fakes = []
})

/**
 * A login store at a fresh temporary directory, signed in to each of
 * `accounts` (owned by the store, expiring at `expires`), and the fake API that
 * knows their tokens.
 */
const bench = async (
  accounts: Record<string, FakeAccount>,
  options: { expires?: number; token?: (account: string) => FakeTokenAnswer; signedInAt?: number } = {},
): Promise<Bench> => {
  const dir = mkdtempSync(join(root, "store-"))
  const store = openSlotStore(dir)
  for (const [label, account] of Object.entries(accounts)) {
    await store.signIn(label, { ...account, expires: options.expires ?? Date.now() + 8 * HOUR }, {
      signedInAt: options.signedInAt ?? 1_700_000_000_000,
    })
  }
  const fake = startFakeAnthropic({ accounts, token: options.token })
  fakes.push(fake)
  const tokenURL = `${fake.url}/v1/oauth/token`
  return {
    dir,
    store,
    fake,
    tokenURL,
    source: new StoreSource({ dir, tokenURL }),
    trades: () => fake.received.filter((request) => request.path === "/v1/oauth/token").length,
    file: (label) => readFileSync(join(dir, ".slots/anthropic", label), "utf8"),
  }
}

const failure = async (run: Promise<unknown>): Promise<StoreCredentialError> => {
  try {
    await run
  } catch (error) {
    if (error instanceof StoreCredentialError) return error
    throw error
  }
  throw new Error("expected the resolve to fail")
}

/** `use` while the slot directory refuses writes (mode 0500), its mode put back however `use` ends. */
const readOnly = <A, E>(slots: string, use: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.sync(() => chmodSync(slots, 0o500)),
    () => use,
    () => Effect.sync(() => chmodSync(slots, 0o700)),
  )

describe("the pool's source over a login store", () => {
  test("a stale token is refreshed once and written back in the store's exact shape, mode 0600", async () => {
    const account = fakeAccount()
    const ours = await bench({ alpha: account }, { expires: Date.now() - 1000 })
    const resolved = await ours.source.resolve(`${STORE_PREFIX}alpha`)
    const rotated = ours.fake.tokens("alpha")
    expect(ours.trades()).toBe(1)
    expect(resolved.access).toBe(rotated.access)
    expect(resolved.access).not.toBe(account.access)

    // The slot file's exact bytes: field order, a dropped account id as null, the sign-in's owner and stamp kept.
    expect(ours.file("alpha")).toBe(
      `{"_tag":"Oauth","type":"oauth","access":"${rotated.access}","refresh":"${rotated.refresh}","expires":${resolved.expires},"accountId":null,"metadata":{"owner":"store"},"signedInAt":1700000000000}`,
    )
    expect(statSync(join(ours.dir, ".slots/anthropic/alpha")).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(ours.dir, ".slots/anthropic"))).toEqual(["alpha"])

    // It decodes back, its sign-in stamp and owner kept.
    expect(await ours.store.get("alpha")).toEqual({
      _tag: "Oauth",
      type: "oauth",
      access: rotated.access,
      refresh: rotated.refresh,
      expires: resolved.expires,
      metadata: { owner: "store" },
      signedInAt: 1_700_000_000_000,
    })
    // And the next request serves it without another refresh.
    expect((await ours.source.resolve(`${STORE_PREFIX}alpha`)).access).toBe(rotated.access)
    expect(ours.trades()).toBe(1)
  })

  test("two processes refreshing the same stale slot at once make one refresh call", async () => {
    const { dir, fake, tokenURL, trades } = await bench(
      { alpha: fakeAccount() },
      { expires: Date.now() - 1000, token: () => ({ kind: "rotate", delayMs: 1500 }) },
    )
    const worker = join(import.meta.dir, "store/refresh-worker.ts")
    const spawn = () =>
      owned([process.execPath, worker, dir, tokenURL, `${STORE_PREFIX}alpha`], { stdout: "pipe", stderr: "pipe" })
    const runs = [spawn(), spawn()]
    const outputs = await Promise.all(
      runs.map(async (run) => {
        const [stdout, stderr] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()])
        expect(await run.exited, stderr).toBe(0)
        const [served, began] = stdout.trim().split(" ")
        return { served, began: Number(began) }
      }),
    )
    const served = fingerprint(fake.tokens("alpha").access)
    expect(outputs.map((output) => output.served)).toEqual([served, served])
    expect(trades()).toBe(1)
    // Both asked while the other's refresh (1.5 s at the endpoint) could be in flight: a real race.
    expect(Math.abs(outputs[0]!.began - outputs[1]!.began)).toBeLessThan(1000)
  }, 30_000)
  it.live("a refresh whose write failed is held, and written later only over the login it replaced", () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const { dir, fake, source, trades, file } = yield* Effect.promise(() => bench({ alpha: fakeAccount() }, { expires: now - 1000 }))
      const slots = join(dir, ".slots/anthropic")
      const alpha = `${STORE_PREFIX}alpha`
      const before = file("alpha")
      // The store's directory refuses the write: the new token serves all the same, and the file keeps the old login.
      const served = yield* readOnly(slots, Effect.promise(() => source.resolve(alpha)))
      expect(served.access).toBe(fake.tokens("alpha").access)
      expect(file("alpha")).toBe(before)
      expect(readdirSync(slots)).toEqual(["alpha"])

      // The held tokens land on the next request, with no second refresh.
      const resolved = yield* Effect.promise(() => source.resolve(alpha))
      expect(resolved.access).toBe(fake.tokens("alpha").access)
      expect(Option.map(Option.fromNullishOr(decodeStoredOAuth(file("alpha"))), (stored) => stored.refresh)).toEqual(
        Option.some(fake.tokens("alpha").refresh),
      )
      expect(trades()).toBe(1)
    }),
  )

  it.live("a held refresh is dropped when another process wrote another login meanwhile", () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const { dir, fake, store, source, trades } = yield* Effect.promise(() => bench({ alpha: fakeAccount() }, { expires: now - 1000 }))
      const slots = join(dir, ".slots/anthropic")
      const alpha = `${STORE_PREFIX}alpha`
      expect((yield* readOnly(slots, Effect.promise(() => source.resolve(alpha)))).access).toBe(fake.tokens("alpha").access)

      const theirs = { ...fakeAccount(), expires: now + 8 * HOUR }
      yield* Effect.promise(() => store.signIn("alpha", theirs, { signedInAt: 1_800_000_000_000 }))
      expect(yield* Effect.promise(() => source.resolve(alpha))).toEqual({ access: theirs.access, expires: theirs.expires })
      expect(Option.map(Option.fromNullishOr(yield* Effect.promise(() => store.get("alpha"))), (stored) => stored.refresh)).toEqual(
        Option.some(theirs.refresh),
      )
      expect(trades()).toBe(1)
    }),
  )

  it.live("a refresh whose write failed keeps the store's lock: no other holder trades the spent refresh token", () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const { dir, fake, source, tokenURL, trades, file } = yield* Effect.promise(() => bench({ alpha: fakeAccount() }, { expires: now - 1000 }))
      const slots = join(dir, ".slots/anthropic")
      const alpha = `${STORE_PREFIX}alpha`
      const theirs = new StoreSource({ dir, tokenURL, process: storeProcess(), lockPolls: 5 })
      const { served, busy } = yield* readOnly(
        slots,
        Effect.all({
          // The new token serves though its write failed.
          served: Effect.promise(() => source.resolve(alpha)),
          // Another holder of the store (its own state of it, its own SQLite connection) must refresh the same
          // login: it waits on the lock, and never reads the spent refresh token to trade it.
          busy: Effect.promise(() => failure(theirs.resolve(alpha))),
        }),
      )
      const rotated = fake.tokens("alpha")
      expect(served.access).toBe(rotated.access)
      expect(busy.kind).toBe("busy")
      expect(trades()).toBe(1)

      expect((yield* Effect.promise(() => source.resolve(alpha))).access).toBe(rotated.access)
      expect(Option.map(Option.fromNullishOr(decodeStoredOAuth(file("alpha"))), (stored) => stored.refresh)).toEqual(Option.some(rotated.refresh))
      expect((yield* Effect.promise(() => theirs.resolve(alpha))).access).toBe(rotated.access)
      expect(trades()).toBe(1)
    }),
  )
})
