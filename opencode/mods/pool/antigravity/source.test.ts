// @reads all
// @reads-reason computed read at mods/pool/antigravity/live.ts: fs.exists and fs.readFileString of a path in the test's own makeTempDirectoryScoped root (`confined` dies on any other)
// The Antigravity source against a fake Google on loopback: Google's own URLs,
// carried by the test's transport to a local server that answers as each host
// would. Success, an expired or refused token, a 429, a hang past the
// deadline, a host that is not Google's, the spacing of reads, the keychain
// tried once and only when asked, and no token in any error, line or file.
// Fixtures live in a scratch directory; the profile's files are read through
// a guard that fails the test on any path outside it, so no test can read the
// real ~/.gemini, and the keychain is a stand-in that counts its reads.
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import * as BunServices from "@effect/platform-bun/BunServices"
import { describe } from "bun:test"
import { Clock, DateTime, Effect, FileSystem, Layer, Match, Option, type Path, Redacted, Ref, Schema, type Scope } from "effect"
import { Base64 } from "effect/encoding"
import { expect, it } from "effect-bun-test"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { fileStore, places as livePlaces } from "./live.ts"
import { GOOGLE, userAgent, type Endpoints } from "./reader.ts"
import { KeychainRead, type Places } from "./signin.ts"
import { make, type Options } from "./source.ts"
import { EMPTY, READ_EVERY_MS, type State, Why } from "./state.ts"

const TOKEN = "fake-access-token-7f3c9e"
const REFRESH = "fake-refresh-token-1a2b"
const SECRET = "fake-client-secret-9z8y"

interface Seen {
  readonly host: string
  readonly path: string
  readonly authorization: string
  readonly agent: string
  readonly body: string
  /** What Google would see of it: method, host, path and the header names, sorted. */
  readonly wire: string
}

const Reply = Schema.TaggedUnion({ Answer: { status: Schema.Finite, body: Schema.Unknown }, Hang: {} })
type Reply = typeof Reply.Type
const answer = (status: number, body: Schema.Json) => Reply.cases.Answer.make({ status, body })

const header = (request: HttpServerRequest.HttpServerRequest, name: string) => Option.getOrElse(Option.fromUndefinedOr(request.headers[name]), () => "")

/** A fake of Google's hosts on loopback: each request recorded, each answered by `reply`; its base URL. */
const fakeGoogle = Effect.fn("fakeGoogle")(function* (reply: (host: string, path: string) => Reply) {
  const seen = yield* Ref.make<ReadonlyArray<Seen>>([])
  const server = yield* BunHttpServer.make({ hostname: "127.0.0.1", port: 0 })
  yield* server.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const [, host = "", ...rest] = request.url.split("?")[0]?.split("/") ?? []
      const path = `/${rest.join("/")}`
      const body = yield* Effect.orElseSucceed(request.text, () => "")
      const wire = `${request.method} ${host}${path} [${Object.keys(request.headers).toSorted().join(",")}]`
      yield* Ref.update(seen, (all) => [...all, { host, path, authorization: header(request, "authorization"), agent: header(request, "user-agent"), body, wire }])
      return yield* Reply.match(reply(host, path), {
        Answer: ({ status, body: json }) => Effect.succeed(HttpServerResponse.jsonUnsafe(json, { status })),
        // Past every deadline, yet short enough that the server's shutdown, which waits for it, ends.
        Hang: () => Effect.as(Effect.sleep(4_000), HttpServerResponse.text("late")),
      })
    }),
  )
  return { seen: Ref.get(seen), base: HttpServer.formatAddress(server.address) }
})

/** The transport: a request to `https://<host>/<path>` goes to the fake at `<base>/<host>/<path>`. */
const toFake = (base: string) =>
  Effect.map(HttpClient.HttpClient, (client) =>
    HttpClient.mapRequest(client, (request) => {
      const url = new URL(request.url)
      return HttpClientRequest.setUrl(request, `${base}/${url.hostname}${url.pathname}`)
    }),
  )

const SUMMARY = {
  groups: [
    {
      buckets: [
        { bucketId: "3p-5h", window: "5h", remainingFraction: 0.25, resetTime: "2030-01-01T05:00:00Z", description: "used" },
        { bucketId: "3p-weekly", window: "weekly", remainingFraction: 0.6, resetTime: "2030-01-05T00:00:00Z", description: "used" },
      ],
    },
  ],
}

const CliToken = Schema.fromJsonString(Schema.Struct({ token: Schema.Struct({ access_token: Schema.String, refresh_token: Schema.String, expiry: Schema.String }) }))
const AcpToken = Schema.fromJsonString(Schema.Struct({ client_id: Schema.String, client_secret: Schema.String, refresh_token: Schema.String, project_id: Schema.String }))
const Body = Schema.fromJsonString(Schema.Unknown)

/** The CLI's token file, expiring `minutes` from now. */
const cliToken = Effect.fn("cliToken")(function* (minutes: number) {
  const expiry = DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes }))
  return yield* Schema.encodeEffect(CliToken)({ token: { access_token: TOKEN, refresh_token: REFRESH, expiry } })
})

/** A scratch profile, the state file beside it, places confined to it, and a keychain stand-in. */
const scratch = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "agy-usage-" })
  yield* fs.makeDirectory(`${root}/profile/antigravity-acp`, { recursive: true })
  const reads = yield* Ref.make(0)
  const keychainAnswer = yield* Ref.make<KeychainRead>(KeychainRead.cases.Absent.make({}))
  const keychain = Ref.update(reads, (count) => count + 1).pipe(Effect.andThen(Ref.get(keychainAnswer)))
  const live = yield* livePlaces(keychain)
  const confined: Places = {
    read: (path) =>
      Match.value(path.startsWith(`${root}/`)).pipe(
        Match.when(true, () => live.read(path)),
        Match.orElse(() => Effect.die(`a test read ${path}, outside its scratch directory`)),
      ),
    keychain: live.keychain,
  }
  const write = (name: string, text: string) => fs.writeFileString(`${root}/profile/antigravity-acp/${name}`, text)
  return { fs, profile: `${root}/profile`, stateFile: `${root}/state/antigravity.json`, places: confined, keychainReads: Ref.get(reads), keychainAnswer, write }
})
type Setup = Effect.Success<typeof scratch>

const sourceOf = Effect.fn("sourceOf")(function* (setup: Setup, base: string, overrides: Partial<Pick<Options, "keychain" | "endpoints" | "auth">>, seed: State) {
  const store = yield* fileStore(setup.stateFile)
  yield* store.save(seed)
  return yield* make({
    profile: setup.profile,
    places: setup.places,
    store,
    auth: Option.getOrElse(Option.fromUndefinedOr(overrides.auth), () => "personal"),
    keychain: Option.getOrElse(Option.fromUndefinedOr(overrides.keychain), () => "ask"),
    endpoints: Option.getOrElse(Option.fromUndefinedOr(overrides.endpoints), () => GOOGLE),
    agent: userAgent("darwin", "arm64"),
  }).pipe(Effect.provideService(HttpClient.HttpClient, yield* toFake(base)))
})

const expectNoSecret = (...texts: ReadonlyArray<string>) => {
  for (const text of texts) for (const secret of [TOKEN, REFRESH, SECRET]) expect(text).not.toContain(secret)
}

/** A test on the real clock with the platform's file system, its scope closed at its end. */
const live = <E,>(name: string, body: Effect.Effect<void, E, FileSystem.FileSystem | Scope.Scope | Path.Path | HttpClient.HttpClient>) =>
  it.scopedLive(name, () => body.pipe(Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer))), 30_000)

const ok = () => answer(200, SUMMARY)

describe("Antigravity source on a fake Google", () => {
  live(
    "a CLI token reads the summary from the daily host first, with the bearer and Antigravity's user agent",
    Effect.gen(function* () {
      const setup = yield* scratch
      const google = yield* fakeGoogle(ok)
      yield* setup.write("antigravity-oauth-token", yield* cliToken(60))
      const source = yield* sourceOf(setup, google.base, {}, EMPTY)
      yield* source.refresh
      const state = yield* source.state
      expect(Option.fromUndefinedOr(state.reading).pipe(Option.map((reading) => reading.windows.map((window) => [window.group, window.span, window.used])))).toEqual(
        Option.some([
          ["claude-gpt", "5h", 0.75],
          ["claude-gpt", "7d", 0.4],
        ]),
      )
      const seen = yield* google.seen
      expect(seen.map((entry) => [entry.host, entry.path])).toContainEqual(["daily-cloudcode-pa.googleapis.com", "/v1internal:retrieveUserQuotaSummary"])
      expect(seen.map((entry) => entry.host).slice(0, 1)).toEqual(["daily-cloudcode-pa.googleapis.com"])
      expect(seen.every((entry) => entry.authorization === `Bearer ${TOKEN}` && entry.agent.startsWith("antigravity/hub/2.24.0 "))).toBe(true)
      expect(yield* setup.keychainReads).toBe(0)
      const open = yield* source.open(Option.some("claude-gpt"))
      expect(open.map((entry) => entry.answer._tag)).toEqual(["Open"])
      expectNoSecret(yield* setup.fs.readFileString(setup.stateFile), (yield* source.lines).join("\n"))
    }),
  )

  live(
    "a business sign-in asks production first; a refreshable sign-in trades its refresh token at Google's token host",
    Effect.gen(function* () {
      const setup = yield* scratch
      const google = yield* fakeGoogle((host) =>
        Match.value(host).pipe(
          Match.when("oauth2.googleapis.com", () => answer(200, { access_token: "fake-refreshed-access", expires_in: 3600 })),
          Match.orElse(ok),
        ),
      )
      yield* setup.write("acp_token.json", yield* Schema.encodeEffect(AcpToken)({ client_id: "client", client_secret: SECRET, refresh_token: REFRESH, project_id: "proj" }))
      const source = yield* sourceOf(setup, google.base, { auth: "business" }, EMPTY)
      yield* source.refresh
      const seen = yield* google.seen
      expect(seen.map((entry) => entry.host).slice(0, 2)).toEqual(["oauth2.googleapis.com", "cloudcode-pa.googleapis.com"])
      expect(seen[0]?.body).toContain("grant_type=refresh_token")
      expect(seen.slice(1).every((entry) => entry.authorization === "Bearer fake-refreshed-access")).toBe(true)
      expect(Option.flatMap(Option.fromUndefinedOr(seen[1]), (entry) => Schema.decodeUnknownOption(Body)(entry.body))).toEqual(Option.some({ project: "proj" }))
      expectNoSecret(yield* setup.fs.readFileString(setup.stateFile))
    }),
  )

  // Every request a read can make, as Google sees it, is one T3 Code makes
  // (apps/server/src/provider/antigravityUsageLimits.ts at 55085df2) and no other:
  // - POST oauth2.googleapis.com/token, form body (client_id, client_secret,
  //   refresh_token, grant_type): T3's refresh of acp_token.json (its lines 402-411);
  // - POST {daily,prod}/v1internal:retrieveUserQuotaSummary, then, when no summary
  //   reads, v1internal:fetchAvailableModels, to both hosts, each with only
  //   Authorization and User-Agent set and a JSON body `{ project }` or `{}`
  //   (its lines 24-31 and 436-476); the user agent is T3's `antigravityUserAgent`
  //   (its line 21).
  // T3's GET www.googleapis.com/oauth2/v2/userinfo (an account fingerprint) is not
  // made here: this reads one sign-in per host. The other header names are the
  // runtime's fetch transport's (Bun's here, Node's in T3), set by neither. T3's Effect
  // client also sends the b3 and traceparent trace headers; this sends neither.
  live(
    "every request a read can make is one T3 Code makes: hosts, paths, methods and header names pinned",
    Effect.gen(function* () {
      const setup = yield* scratch
      const google = yield* fakeGoogle((host, path) =>
        Match.value({ host, path }).pipe(
          Match.when({ host: "oauth2.googleapis.com" }, () => answer(200, { access_token: "fake-refreshed-access", expires_in: 3600 })),
          Match.when({ path: "/v1internal:retrieveUserQuotaSummary" }, () => answer(200, {})),
          Match.orElse(() => answer(200, { models: { "gemini-3-pro": { quotaInfo: { remainingFraction: 0.5, resetTime: "2030-01-01T05:00:00Z" } } } })),
        ),
      )
      yield* setup.write("acp_token.json", yield* Schema.encodeEffect(AcpToken)({ client_id: "client", client_secret: SECRET, refresh_token: REFRESH, project_id: "proj" }))
      yield* (yield* sourceOf(setup, google.base, {}, EMPTY)).refresh
      const refreshable = yield* google.seen
      yield* setup.fs.remove(`${setup.profile}/antigravity-acp/acp_token.json`)
      yield* setup.write("antigravity-oauth-token", yield* cliToken(60))
      yield* (yield* sourceOf(setup, google.base, { auth: "business" }, EMPTY)).refresh
      const all = yield* google.seen
      expect([...new Set(all.map((entry) => entry.wire))].toSorted()).toMatchInlineSnapshot(`
        [
          "POST cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels [accept,accept-encoding,authorization,connection,content-length,content-type,host,user-agent]",
          "POST cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary [accept,accept-encoding,authorization,connection,content-length,content-type,host,user-agent]",
          "POST daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels [accept,accept-encoding,authorization,connection,content-length,content-type,host,user-agent]",
          "POST daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary [accept,accept-encoding,authorization,connection,content-length,content-type,host,user-agent]",
          "POST oauth2.googleapis.com/token [accept,accept-encoding,connection,content-length,content-type,host,user-agent]",
        ]
      `)
      expect(refreshable.map((entry) => `${entry.host}${entry.path}`)).toEqual([
        "oauth2.googleapis.com/token",
        "daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
        "cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
        "daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
        "cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
      ])
      expect(new Set(all.filter((entry) => entry.host !== "oauth2.googleapis.com").map((entry) => entry.agent))).toEqual(new Set([userAgent("darwin", "arm64")]))
      expect(new Set(all.filter((entry) => entry.host !== "oauth2.googleapis.com").map((entry) => entry.body))).toEqual(new Set(['{"project":"proj"}', "{}"]))
    }),
  )

  live(
    "reads are spaced: none again before five minutes, one once due",
    Effect.gen(function* () {
      const setup = yield* scratch
      const google = yield* fakeGoogle(ok)
      yield* setup.write("antigravity-oauth-token", yield* cliToken(60))
      const source = yield* sourceOf(setup, google.base, {}, EMPTY)
      yield* source.refresh
      const first = (yield* google.seen).length
      yield* source.refresh
      yield* source.refresh
      yield* source.lines
      yield* source.open(Option.none())
      expect((yield* google.seen).length).toBe(first)
      const state = yield* source.state
      expect(Option.map(Option.fromUndefinedOr(state.reading), (reading) => state.nextReadAt - reading.at)).toEqual(Option.some(READ_EVERY_MS))
      const due = yield* sourceOf(setup, google.base, {}, { ...state, nextReadAt: (yield* Clock.currentTimeMillis) - 1 })
      yield* due.refresh
      expect((yield* google.seen).length).toBe(first * 2)
    }),
  )

  live(
    "an expired token is no request, and a refused bare token reads as expired; neither names the token",
    Effect.gen(function* () {
      const setup = yield* scratch
      const google = yield* fakeGoogle(() => answer(401, { error: { message: `bad token ${TOKEN}` } }))
      yield* setup.write("antigravity-oauth-token", yield* cliToken(-1))
      const expired = yield* sourceOf(setup, google.base, {}, EMPTY)
      yield* expired.refresh
      expect(yield* google.seen).toEqual([])
      expect((yield* expired.state).failure?.why).toEqual(Why.cases.SignInExpired.make({}))
      yield* setup.write("antigravity-oauth-token", yield* cliToken(60))
      const refused = yield* sourceOf(setup, google.base, {}, EMPTY)
      yield* refused.refresh
      expect((yield* google.seen).length).toBeGreaterThan(0)
      const state = yield* refused.state
      expect(state.failure?.why).toEqual(Why.cases.SignInExpired.make({}))
      const lines = yield* refused.lines
      expect(lines[0]).toBe("antigravity / Gemini · not measured (no limit seen ever): sign-in expired: start an Antigravity turn")
      expectNoSecret(yield* setup.fs.readFileString(setup.stateFile), lines.join("\n"), yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(state))
    }),
  )

  live(
    "a 429 backs the next read off, and names no token",
    Effect.gen(function* () {
      const setup = yield* scratch
      const google = yield* fakeGoogle(() => answer(429, { error: TOKEN }))
      yield* setup.write("antigravity-oauth-token", yield* cliToken(60))
      const source = yield* sourceOf(setup, google.base, {}, EMPTY)
      yield* source.refresh
      const state = yield* source.state
      expect(state.failure?.why).toEqual(Why.cases.RequestFailed.make({ why: "rate-limited", status: 429 }))
      expect(Option.map(Option.fromUndefinedOr(state.failure), (failure) => state.nextReadAt - failure.at)).toEqual(Option.some(2 * READ_EVERY_MS))
      expectNoSecret(yield* setup.fs.readFileString(setup.stateFile), (yield* source.lines).join("\n"))
    }),
  )

  live(
    "a host that hangs is cut off at the deadline",
    Effect.gen(function* () {
      const setup = yield* scratch
      const google = yield* fakeGoogle(() => Reply.cases.Hang.make({}))
      yield* setup.write("antigravity-oauth-token", yield* cliToken(60))
      const source = yield* sourceOf(setup, google.base, {}, EMPTY)
      const started = yield* Clock.currentTimeMillis
      yield* source.refresh
      expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(15_000)
      expect((yield* source.state).failure?.why).toEqual(Why.cases.RequestFailed.make({ why: "timed-out" }))
    }),
  )

  live(
    "a URL on a host that is not Google's is refused before anything is sent",
    Effect.gen(function* () {
      const setup = yield* scratch
      const google = yield* fakeGoogle(ok)
      yield* setup.write("antigravity-oauth-token", yield* cliToken(60))
      const elsewhere: Endpoints = { token: "https://example.com/token", daily: "https://example.com", prod: "http://cloudcode-pa.googleapis.com" }
      const source = yield* sourceOf(setup, google.base, { endpoints: elsewhere }, EMPTY)
      yield* source.refresh
      expect(yield* google.seen).toEqual([])
      expect((yield* source.state).failure?.why).toEqual(Why.cases.HostRefused.make({ host: "example.com" }))
    }),
  )

  live(
    "the keychain: not touched until asked, then tried once; a denial is kept across a restart until asked again",
    Effect.gen(function* () {
      const setup = yield* scratch
      const google = yield* fakeGoogle(ok)
      const source = yield* sourceOf(setup, google.base, {}, EMPTY)
      yield* source.refresh
      expect(yield* setup.keychainReads).toBe(0)
      expect((yield* source.state).failure?.why).toEqual(Why.cases.KeychainNotAsked.make({}))
      yield* Ref.set(setup.keychainAnswer, KeychainRead.cases.Denied.make({}))
      yield* source.retry
      yield* source.refresh
      expect(yield* setup.keychainReads).toBe(1)
      expect((yield* source.state).keychain?.outcome).toBe("denied")
      const restarted = yield* sourceOf(setup, google.base, {}, { ...(yield* source.state), nextReadAt: 0 })
      yield* restarted.refresh
      expect(yield* setup.keychainReads).toBe(1)
      expect((yield* restarted.state).failure?.why).toEqual(Why.cases.KeychainRefused.make({ outcome: "denied" }))
      yield* Ref.set(setup.keychainAnswer, KeychainRead.cases.Found.make({ secret: Redacted.make(`go-keyring-base64:${Base64.encode(yield* cliToken(60))}`) }))
      yield* restarted.retry
      yield* restarted.refresh
      expect(yield* setup.keychainReads).toBe(2)
      expect((yield* restarted.state).reading?.windows.length).toBe(2)
      expect((yield* google.seen).every((entry) => entry.authorization === `Bearer ${TOKEN}`)).toBe(true)
      expectNoSecret(yield* setup.fs.readFileString(setup.stateFile))
    }),
  )

  live(
    "a pane's limit message is recorded with its reset, and answers limited until then",
    Effect.gen(function* () {
      const setup = yield* scratch
      const google = yield* fakeGoogle(ok)
      const source = yield* sourceOf(setup, google.base, {}, EMPTY)
      const limit = yield* source.record("Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h8m38s.", Option.none())
      expect(Option.isSome(limit)).toBe(true)
      const answers = yield* source.open(Option.none())
      expect(answers.map((entry) => entry.answer._tag)).toEqual(["Limited", "Limited"])
      expect(Option.isNone(yield* source.record("All tests pass.", Option.none()))).toBe(true)
      expect(yield* google.seen).toEqual([])
      expect(yield* setup.fs.readFileString(setup.stateFile)).toContain("seenAt")
    }),
  )
})
