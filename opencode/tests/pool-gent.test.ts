// The pool's gent source against gent's own credential store: the fixtures
// are written by gent's `Auth` (loaded from gent's sources, read-only) into
// temporary directories, gent's refreshes are simulated through gent's
// `Auth.update` under gent's real lock, and the token endpoint is the fake
// Anthropic API. Every token is a fake drawn at run time.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CREDENTIAL_SOURCES,
  GENT_PREFIX,
  GENT_TOKEN_URL,
  GentCredentialError,
  GentSource,
  limitDetail,
  registerCredentialSource,
} from "../mods/pool/src/gent.ts"
import { anthropicAuthSource } from "../testbeds/anthropic-auth.ts"
import { fakeAccount, startFakeAnthropic, type FakeAccount, type FakeAnthropic, type FakeTokenAnswer } from "./fake-anthropic.ts"
import { gentAvailable, gentSource, openGentStore, type GentStore } from "./gent/store.ts"

const ready = gentAvailable()
if (!ready) {
  console.warn(`tests/pool-gent.test.ts: skipped. Clone gent to ${gentSource()} (or set GENT_SOURCE).`)
}

const HOUR = 3_600_000
const root = mkdtempSync(join(tmpdir(), "pool-gent-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const fingerprint = (token: string) => createHash("sha256").update(token).digest("hex").slice(0, 16)

interface Bench {
  readonly dir: string
  readonly gent: GentStore
  readonly fake: FakeAnthropic
  readonly source: GentSource
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
 * A gent store at a fresh temporary directory, signed in by gent to each of
 * `accounts` (owned by gent, expiring at `expires`), and the fake API that
 * knows their tokens.
 */
const bench = async (
  accounts: Record<string, FakeAccount>,
  options: { expires?: number; token?: (account: string) => FakeTokenAnswer; signedInAt?: number } = {},
): Promise<Bench> => {
  const dir = mkdtempSync(join(root, "store-"))
  const gent = await openGentStore(dir)
  for (const [label, account] of Object.entries(accounts)) {
    await gent.signIn(label, { ...account, expires: options.expires ?? Date.now() + 8 * HOUR }, {
      signedInAt: options.signedInAt ?? 1_700_000_000_000,
    })
  }
  const fake = startFakeAnthropic({ accounts, token: options.token })
  fakes.push(fake)
  const tokenURL = `${fake.url}/v1/oauth/token`
  return {
    dir,
    gent,
    fake,
    tokenURL,
    source: new GentSource({ dir, tokenURL }),
    trades: () => fake.received.filter((request) => request.path === "/v1/oauth/token").length,
    file: (label) => readFileSync(join(dir, ".slots/anthropic", label), "utf8"),
  }
}

const failure = async (run: Promise<unknown>): Promise<GentCredentialError> => {
  try {
    await run
  } catch (error) {
    if (error instanceof GentCredentialError) return error
    throw error
  }
  throw new Error("expected the resolve to fail")
}

// The endpoint Claude Code and the Anthropic auth plugin refresh at.
test("the gent source refreshes at Claude Code's token endpoint", () => {
  expect(GENT_TOKEN_URL).toBe("https://platform.claude.com/v1/oauth/token")
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

describe.skipIf(!ready)("the pool's gent source over gent's own store", () => {
  test("lists the accounts gent owns by label, and says why it leaves the rest alone", async () => {
    const { dir, gent, source } = await bench({ alpha: fakeAccount(), "beta-2": fakeAccount() })
    // gent's default entry (Claude Code's login), a linked slot, a write in
    // flight and a file that is not a sign-in.
    await gent.signIn(undefined, { ...fakeAccount(), expires: Date.now() + HOUR }, { metadata: {} })
    await gent.signIn("linked", { ...fakeAccount(), expires: Date.now() + HOUR }, { metadata: { source: "claude-code" } })
    writeFileSync(join(dir, ".slots/anthropic/.alpha.gent-write-0a1b2c3d"), "{}", { mode: 0o600 })
    writeFileSync(join(dir, ".slots/anthropic/broken"), "{}", { mode: 0o600 })

    expect(source.list()).toEqual({
      accounts: [`${GENT_PREFIX}alpha`, `${GENT_PREFIX}beta-2`],
      skipped: [
        { label: "broken", reason: "does not decode as an OAuth sign-in" },
        { label: "linked", reason: "a linked Claude Code login, which gent refreshes itself" },
      ],
    })
    // gent lists the same labels, the undecodable one and its default entry among them.
    expect([...(await gent.slots())].sort()).toEqual(["alpha", "beta-2", "broken", "default", "linked"])
    expect(source.owns(`${GENT_PREFIX}alpha`)).toBe(true)
    expect(source.owns("alpha")).toBe(false)
    expect(source.owns(`${GENT_PREFIX}default`)).toBe(false)
    expect(new GentSource({ dir: join(dir, "missing") }).list()).toEqual({ accounts: [], skipped: [] })
  })

  test("serves each slot's own token, read again for every request", async () => {
    const alpha = fakeAccount()
    const beta = fakeAccount()
    const { gent, source, trades } = await bench({ alpha, beta })
    expect((await source.resolve(`${GENT_PREFIX}alpha`)).access).toBe(alpha.access)
    expect((await source.resolve(`${GENT_PREFIX}beta`)).access).toBe(beta.access)

    // gent refreshes alpha meanwhile: the next request carries gent's new token.
    const next = { ...fakeAccount(), expires: Date.now() + 8 * HOUR }
    await gent.refresh("alpha", () => next)
    expect(await source.resolve(`${GENT_PREFIX}alpha`)).toEqual({ access: next.access, expires: next.expires })
    expect(trades()).toBe(0)

    await gent.signIn("linked", { ...fakeAccount(), expires: Date.now() + HOUR }, { metadata: {} })
    expect((await failure(source.resolve(`${GENT_PREFIX}linked`))).kind).toBe("not-owned")
    expect((await failure(source.resolve(`${GENT_PREFIX}gone`))).kind).toBe("signed-out")
  })

  test("a stale token is refreshed once and written back in gent's exact shape, mode 0600", async () => {
    const account = fakeAccount()
    const ours = await bench({ alpha: account }, { expires: Date.now() - 1000 })
    const resolved = await ours.source.resolve(`${GENT_PREFIX}alpha`)
    const rotated = ours.fake.tokens("alpha")
    expect(ours.trades()).toBe(1)
    expect(resolved.access).toBe(rotated.access)
    expect(resolved.access).not.toBe(account.access)

    // The bytes gent writes when it makes the same refresh itself.
    const theirs = await bench({ alpha: account }, { expires: Date.now() - 1000 })
    await theirs.gent.refresh("alpha", () => ({ ...rotated, expires: resolved.expires }))
    expect(ours.file("alpha")).toBe(theirs.file("alpha"))
    expect(statSync(join(ours.dir, ".slots/anthropic/alpha")).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(ours.dir, ".slots/anthropic"))).toEqual(["alpha"])

    // gent's decoder reads it back, its sign-in stamp and owner kept.
    expect(await ours.gent.get("alpha")).toEqual({
      _tag: "Oauth",
      type: "oauth",
      access: rotated.access,
      refresh: rotated.refresh,
      expires: resolved.expires,
      metadata: { owner: "gent" },
      signedInAt: 1_700_000_000_000,
    })
    // And the next request serves it without another refresh.
    expect((await ours.source.resolve(`${GENT_PREFIX}alpha`)).access).toBe(rotated.access)
    expect(ours.trades()).toBe(1)
  })

  test("two processes refreshing the same stale slot at once make one refresh call", async () => {
    const { dir, fake, tokenURL, trades } = await bench(
      { alpha: fakeAccount() },
      { expires: Date.now() - 1000, token: () => ({ kind: "rotate", delayMs: 1500 }) },
    )
    const worker = join(import.meta.dir, "gent/refresh-worker.ts")
    const spawn = () =>
      Bun.spawn([process.execPath, worker, dir, tokenURL, `${GENT_PREFIX}alpha`], { stdout: "pipe", stderr: "pipe" })
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
    const first = new GentSource({ dir, tokenURL })
    const second = new GentSource({ dir, tokenURL })
    const served = await Promise.all([
      first.resolve(`${GENT_PREFIX}alpha`),
      second.resolve(`${GENT_PREFIX}alpha`),
      first.resolve(`${GENT_PREFIX}alpha`),
    ])
    expect(new Set(served.map((credential) => credential.access)).size).toBe(1)
    expect(trades()).toBe(1)
  })

  test("a token gent refreshed while the pool waited for its lock is read again, not refreshed again", async () => {
    const { gent, source, trades } = await bench({ alpha: fakeAccount() }, { expires: Date.now() - 1000 })
    const theirs = { ...fakeAccount(), expires: Date.now() + 8 * HOUR }
    // gent takes its lock and holds it while its refresh is in flight.
    const gentRefresh = gent.refresh("alpha", () => theirs, 800)
    await Bun.sleep(300)
    const waited = Date.now()
    const resolved = await source.resolve(`${GENT_PREFIX}alpha`)
    await gentRefresh
    expect(Date.now() - waited).toBeGreaterThan(200)
    expect(resolved).toEqual({ access: theirs.access, expires: theirs.expires })
    expect(trades()).toBe(0)
  })

  test("gent, waiting for the lock while the pool refreshes, reads the pool's write and writes nothing", async () => {
    const { gent, fake, source, trades } = await bench(
      { alpha: fakeAccount() },
      { expires: Date.now() - 1000, token: () => ({ kind: "rotate", delayMs: 800 }) },
    )
    const ours = source.resolve(`${GENT_PREFIX}alpha`)
    await Bun.sleep(300)
    let seen: string | undefined
    // gent's refresh: it rereads under the lock and finds the token fresh.
    await gent.refresh("alpha", (current) => {
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
    const error = await failure(source.resolve(`${GENT_PREFIX}alpha`))
    expect(error.kind).toBe("unavailable")
    expect(error.retryAt).toBeGreaterThan(Date.now())
    expect(file("alpha")).toBe(before)

    // gent keeps the refresh token after an unclear failure: the next try spends it.
    answer = { kind: "rotate" }
    await source.resolve(`${GENT_PREFIX}alpha`)
    expect(trades()).toBe(2)
    expect(file("alpha")).not.toBe(before)
  })

  test("a rate-limited refresh pauses every account of the store until retry-after", async () => {
    let answer: FakeTokenAnswer = { kind: "rate-limited", retryAfterSeconds: 120 }
    const { source, trades } = await bench(
      { alpha: fakeAccount(), beta: fakeAccount() },
      { expires: Date.now() - 1000, token: () => answer },
    )
    const first = await failure(source.resolve(`${GENT_PREFIX}alpha`))
    expect(first.kind).toBe("unavailable")
    expect(first.message).toContain("answered 429 (server")
    expect(first.message).toContain("retry-after 120")
    expect(first.retryAt).toBeGreaterThan(Date.now() + 110_000)
    // The other account waits too, without a request of its own.
    answer = { kind: "rotate" }
    const second = await failure(source.resolve(`${GENT_PREFIX}beta`))
    expect(second.retryAt).toBe(first.retryAt)
    expect(trades()).toBe(1)
  })

  test("a refresh the endpoint refused writes nothing and asks for a new sign-in", async () => {
    const { source, file } = await bench({ alpha: fakeAccount() }, { expires: Date.now() - 1000, token: () => ({ kind: "rejected" }) })
    const before = file("alpha")
    const error = await failure(source.resolve(`${GENT_PREFIX}alpha`))
    expect(error.kind).toBe("rejected")
    expect(error.retryAt).toBeUndefined()
    expect(file("alpha")).toBe(before)
  })

  test("a refresh whose write failed is held, and written later only over the login it replaced", async () => {
    const { dir, fake, source, trades, file } = await bench({ alpha: fakeAccount() }, { expires: Date.now() - 1000 })
    const slots = join(dir, ".slots/anthropic")
    const before = file("alpha")
    chmodSync(slots, 0o500)
    const error = await failure(source.resolve(`${GENT_PREFIX}alpha`))
    chmodSync(slots, 0o700)
    expect(error.kind).toBe("persist")
    expect(file("alpha")).toBe(before)
    expect(readdirSync(slots)).toEqual(["alpha"])

    // The held tokens land on the next request, with no second refresh.
    const resolved = await source.resolve(`${GENT_PREFIX}alpha`)
    expect(resolved.access).toBe(fake.tokens("alpha").access)
    expect(JSON.parse(file("alpha")).refresh).toBe(fake.tokens("alpha").refresh)
    expect(trades()).toBe(1)
  })

  test("a held refresh is dropped when gent wrote another login meanwhile", async () => {
    const { dir, gent, source, trades } = await bench({ alpha: fakeAccount() }, { expires: Date.now() - 1000 })
    const slots = join(dir, ".slots/anthropic")
    chmodSync(slots, 0o500)
    expect((await failure(source.resolve(`${GENT_PREFIX}alpha`))).kind).toBe("persist")
    chmodSync(slots, 0o700)

    const theirs = { ...fakeAccount(), expires: Date.now() + 8 * HOUR }
    await gent.signIn("alpha", theirs, { signedInAt: 1_800_000_000_000 })
    expect(await source.resolve(`${GENT_PREFIX}alpha`)).toEqual({ access: theirs.access, expires: theirs.expires })
    expect((await gent.get("alpha"))?.refresh).toBe(theirs.refresh)
    expect(trades()).toBe(1)
  })

  test("a token the provider rejected is refreshed next time, only while the store still holds it", async () => {
    const account = fakeAccount()
    const { source, trades } = await bench({ alpha: account })
    source.rejected(`${GENT_PREFIX}alpha`, "fake-access-some-older-token")
    expect((await source.resolve(`${GENT_PREFIX}alpha`)).access).toBe(account.access)
    expect(trades()).toBe(0)

    source.rejected(`${GENT_PREFIX}alpha`, account.access)
    const next = await source.resolve(`${GENT_PREFIX}alpha`)
    expect(next.access).not.toBe(account.access)
    expect(trades()).toBe(1)
  })

  test("gives up on a lock gent holds too long, with a time to try again", async () => {
    const { dir, gent, tokenURL, trades } = await bench({ alpha: fakeAccount() }, { expires: Date.now() - 1000 })
    const held = gent.refresh("alpha", () => undefined, 1000)
    await Bun.sleep(300)
    const error = await failure(new GentSource({ dir, tokenURL, lockPolls: 5 }).resolve(`${GENT_PREFIX}alpha`))
    await held
    expect(error.kind).toBe("busy")
    expect(error.retryAt).toBeGreaterThan(Date.now())
    expect(trades()).toBe(0)
  })

  test("registers with the registry the auth plugin reads, and leaves it on dispose", async () => {
    const { credentialSource } = await import(join(anthropicAuthSource(), "src/credential-sources.ts"))
    const { source } = await bench({ alpha: fakeAccount() })
    const unregister = registerCredentialSource("anthropic-gent-test", source)
    expect((globalThis as Record<symbol, unknown>)[CREDENTIAL_SOURCES]).toBeInstanceOf(Map)
    expect(credentialSource("anthropic-gent-test", `${GENT_PREFIX}alpha`)).toBe(source)
    expect(credentialSource("anthropic-gent-test", "cred_other")).toBeUndefined()
    unregister()
    expect(credentialSource("anthropic-gent-test", `${GENT_PREFIX}alpha`)).toBeUndefined()
  })
})
