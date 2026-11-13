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
import { STORE_PREFIX, StoreCredentialError, StoreSource } from "../mods/pool/store/store.ts"
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
  test("a refresh whose write failed is held, and written later only over the login it replaced", async () => {
    const { dir, fake, source, trades, file } = await bench({ alpha: fakeAccount() }, { expires: Date.now() - 1000 })
    const slots = join(dir, ".slots/anthropic")
    const before = file("alpha")
    chmodSync(slots, 0o500)
    const error = await failure(source.resolve(`${STORE_PREFIX}alpha`))
    chmodSync(slots, 0o700)
    expect(error.kind).toBe("persist")
    expect(file("alpha")).toBe(before)
    expect(readdirSync(slots)).toEqual(["alpha"])

    // The held tokens land on the next request, with no second refresh.
    const resolved = await source.resolve(`${STORE_PREFIX}alpha`)
    expect(resolved.access).toBe(fake.tokens("alpha").access)
    expect(JSON.parse(file("alpha")).refresh).toBe(fake.tokens("alpha").refresh)
    expect(trades()).toBe(1)
  })

  test("a held refresh is dropped when another process wrote another login meanwhile", async () => {
    const { dir, store, source, trades } = await bench({ alpha: fakeAccount() }, { expires: Date.now() - 1000 })
    const slots = join(dir, ".slots/anthropic")
    chmodSync(slots, 0o500)
    expect((await failure(source.resolve(`${STORE_PREFIX}alpha`))).kind).toBe("persist")
    chmodSync(slots, 0o700)

    const theirs = { ...fakeAccount(), expires: Date.now() + 8 * HOUR }
    await store.signIn("alpha", theirs, { signedInAt: 1_800_000_000_000 })
    expect(await source.resolve(`${STORE_PREFIX}alpha`)).toEqual({ access: theirs.access, expires: theirs.expires })
    expect((await store.get("alpha"))?.refresh).toBe(theirs.refresh)
    expect(trades()).toBe(1)
  })
})
