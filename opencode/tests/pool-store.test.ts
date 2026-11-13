// accept: one at a time (it bounds how far apart two refreshes begin).
// The pool's login store source over a store in its slot-file format: the
// fixtures are slot files in temporary directories, another process's
// refreshes are made under the store's real lock (tests/store/store.ts), and
// the token endpoint is the fake Anthropic API. Every token is a fake drawn
// at run time.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import {
  CREDENTIAL_SOURCES,
  STORE_PREFIX,
  CLAUDE_TOKEN_URL,
  StoreCredentialError,
  StoreSource,
  limitDetail,
  registerCredentialSource,
} from "../mods/pool/store/store.ts"
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

// The endpoint Claude Code and the Anthropic auth plugin refresh at.
test("the store source refreshes at Claude Code's token endpoint", () => {
  expect(CLAUDE_TOKEN_URL).toBe("https://platform.claude.com/v1/oauth/token")
})

test("a 429's log line names who limited the request, and never more than the error's words", () => {
  expect(limitDetail("cloudflare", "60", "<html><body><h1>Error 1015</h1> You are being rate limited</body></html>")).toBe(
    'server cloudflare; retry-after 60; "Error 1015 You are being rate limited"',
  )
  expect(limitDetail(null, null, JSON.stringify({ error: { type: "rate_limit_error", message: "Too many refreshes" } }))).toBe(
    'server unnamed; retry-after none; "rate_limit_error: Too many refreshes"',
  )
  expect(limitDetail("envoy", null, "")).toBe("server envoy; retry-after none; empty body")
})

describe("the pool's source over a login store", () => {
  test("lists the accounts the store owns by label, and says why it leaves the rest alone", async () => {
    const { dir, store, source } = await bench({ alpha: fakeAccount(), "beta-2": fakeAccount() })
    // The default entry (Claude Code's login), a linked slot, a write in
    // flight and a file that is not a sign-in.
    await store.signIn(undefined, { ...fakeAccount(), expires: Date.now() + HOUR }, { metadata: {} })
    await store.signIn("linked", { ...fakeAccount(), expires: Date.now() + HOUR }, { metadata: { source: "claude-code" } })
    writeFileSync(join(dir, ".slots/anthropic/.alpha.store-write-0a1b2c3d"), "{}", { mode: 0o600 })
    writeFileSync(join(dir, ".slots/anthropic/broken"), "{}", { mode: 0o600 })

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
    expect(new StoreSource({ dir: join(dir, "missing") }).list()).toEqual({ accounts: [], skipped: [] })
  })

  test("serves each slot's own token, read again for every request", async () => {
    const alpha = fakeAccount()
    const beta = fakeAccount()
    const { store, source, trades } = await bench({ alpha, beta })
    expect((await source.resolve(`${STORE_PREFIX}alpha`)).access).toBe(alpha.access)
    expect((await source.resolve(`${STORE_PREFIX}beta`)).access).toBe(beta.access)

    // Another process refreshes alpha meanwhile: the next request carries its new token.
    const next = { ...fakeAccount(), expires: Date.now() + 8 * HOUR }
    await store.refresh("alpha", () => next)
    expect(await source.resolve(`${STORE_PREFIX}alpha`)).toEqual({ access: next.access, expires: next.expires })
    expect(trades()).toBe(0)

    await store.signIn("linked", { ...fakeAccount(), expires: Date.now() + HOUR }, { metadata: {} })
    expect((await failure(source.resolve(`${STORE_PREFIX}linked`))).kind).toBe("not-owned")
    expect((await failure(source.resolve(`${STORE_PREFIX}gone`))).kind).toBe("signed-out")
  })

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

  test("in one process too, concurrent requests for a stale slot share one refresh", async () => {
    const { dir, tokenURL, trades } = await bench(
      { alpha: fakeAccount() },
      { expires: Date.now() - 1000, token: () => ({ kind: "rotate", delayMs: 200 }) },
    )
    const first = new StoreSource({ dir, tokenURL })
    const second = new StoreSource({ dir, tokenURL })
    const served = await Promise.all([
      first.resolve(`${STORE_PREFIX}alpha`),
      second.resolve(`${STORE_PREFIX}alpha`),
      first.resolve(`${STORE_PREFIX}alpha`),
    ])
    expect(new Set(served.map((credential) => credential.access)).size).toBe(1)
    expect(trades()).toBe(1)
  })

  test("a token another process refreshed while the pool waited for its lock is read again, not refreshed again", async () => {
    const { store, source, trades } = await bench({ alpha: fakeAccount() }, { expires: Date.now() - 1000 })
    const theirs = { ...fakeAccount(), expires: Date.now() + 8 * HOUR }
    // The other process takes the lock; the pool asks while its refresh is in flight.
    const asked: Array<{ readonly at: number; readonly resolving: Promise<{ access: string; expires: number }> }> = []
    const ask = Effect.sync(() => asked.push({ at: Date.now(), resolving: source.resolve(`${STORE_PREFIX}alpha`) }))
    await store.refresh("alpha", () => theirs, ask.pipe(Effect.andThen(Effect.sleep("500 millis"))))
    const answers: Array<{ readonly resolved: { access: string; expires: number }; readonly waited: boolean }> = []
    for (const { at, resolving } of asked) answers.push({ resolved: await resolving, waited: Date.now() - at > 400 })
    expect(answers).toEqual([{ resolved: { access: theirs.access, expires: theirs.expires }, waited: true }])
    expect(trades()).toBe(0)
  })

  test("another process, waiting for the lock while the pool refreshes, reads the pool's write and writes nothing", async () => {
    const { store, fake, source, trades } = await bench(
      { alpha: fakeAccount() },
      { expires: Date.now() - 1000, token: () => ({ kind: "rotate", delayMs: 800 }) },
    )
    const ours = source.resolve(`${STORE_PREFIX}alpha`)
    await Bun.sleep(300)
    let seen: string | undefined
    // The other process's refresh: it rereads under the lock and finds the token fresh.
    await store.refresh("alpha", (current) => {
      seen = current?.access
      return current !== undefined && current.expires > Date.now() + 60_000 ? undefined : { ...fakeAccount(), expires: 0 }
    })
    const resolved = await ours
    expect(seen).toBe(resolved.access)
    expect(resolved.access).toBe(fake.tokens("alpha").access)
    expect(trades()).toBe(1)
  })

  test("a refresh the endpoint could not answer writes nothing and may be tried again", async () => {
    let answer: FakeTokenAnswer = { kind: "unavailable" }
    const { source, trades, file } = await bench({ alpha: fakeAccount() }, { expires: Date.now() - 1000, token: () => answer })
    const before = file("alpha")
    const error = await failure(source.resolve(`${STORE_PREFIX}alpha`))
    expect(error.kind).toBe("unavailable")
    expect(error.retryAt).toBeGreaterThan(Date.now())
    expect(file("alpha")).toBe(before)

    // The refresh token stays after an unclear failure: the next try spends it.
    answer = { kind: "rotate" }
    await source.resolve(`${STORE_PREFIX}alpha`)
    expect(trades()).toBe(2)
    expect(file("alpha")).not.toBe(before)
  })

  test("a rate-limited refresh pauses every account of the store until retry-after", async () => {
    let answer: FakeTokenAnswer = { kind: "rate-limited", retryAfterSeconds: 120 }
    const { source, trades } = await bench(
      { alpha: fakeAccount(), beta: fakeAccount() },
      { expires: Date.now() - 1000, token: () => answer },
    )
    const first = await failure(source.resolve(`${STORE_PREFIX}alpha`))
    expect(first.kind).toBe("unavailable")
    expect(first.message).toContain("answered 429 (server")
    expect(first.message).toContain("retry-after 120")
    expect(first.retryAt).toBeGreaterThan(Date.now() + 110_000)
    // The other account waits too, without a request of its own.
    answer = { kind: "rotate" }
    const second = await failure(source.resolve(`${STORE_PREFIX}beta`))
    expect(second.retryAt).toBe(first.retryAt)
    expect(trades()).toBe(1)
  })

  test("a refresh the endpoint refused writes nothing and asks for a new sign-in", async () => {
    const { source, file } = await bench({ alpha: fakeAccount() }, { expires: Date.now() - 1000, token: () => ({ kind: "rejected" }) })
    const before = file("alpha")
    const error = await failure(source.resolve(`${STORE_PREFIX}alpha`))
    expect(error.kind).toBe("rejected")
    expect(error.retryAt).toBeUndefined()
    expect(file("alpha")).toBe(before)
  })

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

  test("a token the provider rejected is refreshed next time, only while the store still holds it", async () => {
    const account = fakeAccount()
    const { source, trades } = await bench({ alpha: account })
    source.rejected(`${STORE_PREFIX}alpha`, "fake-access-some-older-token")
    expect((await source.resolve(`${STORE_PREFIX}alpha`)).access).toBe(account.access)
    expect(trades()).toBe(0)

    source.rejected(`${STORE_PREFIX}alpha`, account.access)
    const next = await source.resolve(`${STORE_PREFIX}alpha`)
    expect(next.access).not.toBe(account.access)
    expect(trades()).toBe(1)
  })

  test("gives up on a lock another process holds too long, with a time to try again", async () => {
    const { dir, store, tokenURL, trades } = await bench({ alpha: fakeAccount() }, { expires: Date.now() - 1000 })
    // The pool asks while the other process holds the lock, and polls it 5 times only.
    const asked: Array<Promise<StoreCredentialError>> = []
    const ask = Effect.sync(() => asked.push(failure(new StoreSource({ dir, tokenURL, lockPolls: 5 }).resolve(`${STORE_PREFIX}alpha`))))
    await store.refresh("alpha", () => undefined, ask.pipe(Effect.andThen(Effect.sleep("1 second"))))
    const errors: Array<StoreCredentialError> = []
    for (const error of asked) errors.push(await error)
    expect(errors.map((error) => ({ kind: error.kind, later: (error.retryAt ?? 0) > Date.now() }))).toEqual([{ kind: "busy", later: true }])
    expect(trades()).toBe(0)
  })

  test("registers with the registry the auth plugin reads, and leaves it on dispose", async () => {
    const { credentialSource } = await import("../mods/anthropic-auth/registry/credential-sources.ts")
    const { source } = await bench({ alpha: fakeAccount() })
    const unregister = registerCredentialSource("anthropic-store-test", source)
    expect((globalThis as Record<symbol, unknown>)[CREDENTIAL_SOURCES]).toBeInstanceOf(Map)
    expect(credentialSource("anthropic-store-test", `${STORE_PREFIX}alpha`)).toBe(source)
    expect(credentialSource("anthropic-store-test", "cred_other")).toBeUndefined()
    unregister()
    expect(credentialSource("anthropic-store-test", `${STORE_PREFIX}alpha`)).toBeUndefined()
  })
})
