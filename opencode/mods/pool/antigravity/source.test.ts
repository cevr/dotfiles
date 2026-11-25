// @reads all
// @reads-reason computed read at mods/pool/antigravity/live.ts: fs.exists and fs.readFileString of a path in the test's own makeTempDirectoryScoped root (`confined` dies on any other)
// @reads-reason subprocess reads at mods/pool/antigravity/source.test.ts: spawn(["bun", writer, setup.root, name]) runs race-writer.ts over the test's own makeTempDirectoryScoped root
// The Antigravity read authority against a fake Google on loopback: Google's
// own URLs, carried by the test's transport to a local server that answers as
// each host would. Success, an expired or refused token, a 429, a hang past
// the deadline, a host that is not Google's, the floor between reads across
// authorities, the keychain only with a consent (one attempt per consent, none
// at a restart, on expiry or after a refusal), the request pin against T3
// Code, containment of every dependency's failure, and no token in any error,
// line or file. Fixtures live in a scratch directory; the profile's files are
// read through a guard that fails the test on any path outside it, so no test
// can read the real ~/.gemini, and the keychain is a stand-in that counts its
// reads.
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import * as BunServices from "@effect/platform-bun/BunServices"
import { spawn } from "bun"
import { describe } from "bun:test"
import { DateTime, Duration, Effect, Exit, FileSystem, Layer, Match, Option, Path, Redacted, Ref, Schedule, Schema, type Scope } from "effect"
import { Base64 } from "effect/encoding"
import { expect, it } from "effect-bun-test"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { fileStore, places as livePlaces, prepareProfile } from "./live.ts"
import { envFileText, managedProfile, signInLine } from "./profile.ts"
import { GOOGLE, userAgent, type Endpoints } from "./reader.ts"
import { KeychainRead, type Places } from "./signin.ts"
import { make, type Options, type Source, type Store } from "./source.ts"
import { EMPTY, READ_EVERY_MS, type State, Why } from "./state.ts"

const TOKEN = "fake-access-token-7f3c9e"
const REFRESH = "fake-refresh-token-1a2b"
const SECRET = "fake-client-secret-9z8y"
const AGENT = userAgent("darwin", "arm64")
const writerFile = Effect.flatMap(Path.Path, (path) => path.fromFileUrl(new URL("./race-writer.ts", import.meta.url)))

interface Seen {
  readonly host: string
  readonly path: string
  readonly authorization: string
  readonly agent: string
  readonly body: string
  /** What Google would see of it: method, host, path, the header names sorted, content-type's value and the authorization's scheme. */
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
      const scheme = header(request, "authorization").split(" ")[0] ?? ""
      const wire = `${request.method} ${host}${path} [${Object.keys(request.headers).toSorted().join(",")}] content-type=${header(request, "content-type")} auth=${scheme}`
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
const decodeForm = (body: string) => [...new URLSearchParams(body).keys()].toSorted()

/** The CLI's token file, expiring `minutes` from now. */
const cliToken = Effect.fn("cliToken")(function* (minutes: number) {
  const expiry = DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes }))
  return yield* Schema.encodeEffect(CliToken)({ token: { access_token: TOKEN, refresh_token: REFRESH, expiry } })
})

/** The keychain entry as go-keyring stores the CLI's token, expiring `minutes` from now. */
const keychainEntry = Effect.fn("keychainEntry")(function* (minutes: number) {
  return KeychainRead.cases.Found.make({ secret: Redacted.make(`go-keyring-base64:${Base64.encode(yield* cliToken(minutes))}`) })
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
  const stateFile = `${root}/state/antigravity.json`
  const store = yield* fileStore(stateFile)
  /** Time passes: the floor after the last attempt is let go. */
  const floorPassed = store.transact((state) => Effect.succeed([{ ...state, nextReadAt: 0 }, true] as const))
  return { fs, root, profile: `${root}/profile`, stateFile, store, places: confined, keychainReads: Ref.get(reads), keychainAnswer, write, state: store.load, floorPassed }
})
type Setup = Effect.Success<typeof scratch>

/** An authority over the setup's state file, as another plugin instance or process builds it: its own memory, the same file. */
const sourceOf = Effect.fn("sourceOf")(function* (setup: Setup, base: string, overrides: Partial<Pick<Options, "endpoints" | "auth" | "places" | "store" | "agent">> = {}) {
  return yield* make({
    profile: setup.profile,
    places: Option.getOrElse(Option.fromUndefinedOr(overrides.places), () => setup.places),
    store: Option.getOrElse(Option.fromUndefinedOr(overrides.store), () => setup.store),
    auth: Option.getOrElse(Option.fromUndefinedOr(overrides.auth), () => "personal"),
    endpoints: Option.getOrElse(Option.fromUndefinedOr(overrides.endpoints), () => GOOGLE),
    agent: Option.getOrElse(Option.fromUndefinedOr(overrides.agent), () => Effect.succeed(AGENT)),
  }).pipe(Effect.provideService(HttpClient.HttpClient, yield* toFake(base)))
})

/** A business sign-in: the only kind the keychain is ever read for, as T3 reads it. */
const BUSINESS = { auth: "business" } as const

const expectNoSecret = (...texts: ReadonlyArray<string>) => {
  for (const text of texts) for (const secret of [TOKEN, REFRESH, SECRET]) expect(text).not.toContain(secret)
}

/** A test on the real clock with the platform's file system, its scope closed at its end. */
const live = <E,>(name: string, body: Effect.Effect<void, E, FileSystem.FileSystem | Scope.Scope | Path.Path | HttpClient.HttpClient>) =>
  it.scopedLive(name, () => body.pipe(Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer))), 30_000)

const ok = () => answer(200, SUMMARY)
const failureOf = (state: State) => Option.map(Option.fromUndefinedOr(state.failure), (failure) => failure.why)

describe("Antigravity read authority on a fake Google", () => {
  live(
    "a CLI token reads the summary from the daily host first, with the bearer and Antigravity's user agent",
    Effect.gen(function* () {
      const setup = yield* scratch
      const google = yield* fakeGoogle(ok)
      yield* setup.write("antigravity-oauth-token", yield* cliToken(60))
      const source = yield* sourceOf(setup, google.base)
      expect((yield* source.read(false)).note).toBe("Read now.")
      const state = yield* setup.state
      expect(Option.fromUndefinedOr(state.reading).pipe(Option.map((reading) => reading.windows.map((window) => [window.group, window.span, window.used])))).toEqual(
        Option.some([
          ["claude-gpt", "5h", 0.75],
          ["claude-gpt", "7d", 0.4],
        ]),
      )
      const seen = yield* google.seen
      expect(seen.map((entry) => [entry.host, entry.path])).toContainEqual(["daily-cloudcode-pa.googleapis.com", "/v1internal:retrieveUserQuotaSummary"])
      expect(seen.every((entry) => entry.authorization === `Bearer ${TOKEN}` && entry.agent === AGENT)).toBe(true)
      expect(yield* setup.keychainReads).toBe(0)
      const open = yield* source.open(Option.some("claude-gpt"))
      expect(open.map((entry) => entry.answer._tag)).toEqual(["Open"])
      expectNoSecret(yield* setup.fs.readFileString(setup.stateFile), (yield* source.lines).join("\n"))
    }),
  )

  live(
    "a business sign-in asks production; a refreshable sign-in trades its refresh token at Google's token host first",
    Effect.gen(function* () {
      const setup = yield* scratch
      const google = yield* fakeGoogle((host) =>
        Match.value(host).pipe(
          Match.when("oauth2.googleapis.com", () => answer(200, { access_token: "fake-refreshed-access", expires_in: 3600 })),
          Match.orElse(ok),
        ),
      )
      yield* setup.write("acp_token.json", yield* Schema.encodeEffect(AcpToken)({ client_id: "client", client_secret: SECRET, refresh_token: REFRESH, project_id: "proj" }))
      yield* (yield* sourceOf(setup, google.base, { auth: "business" })).read(false)
      const seen = yield* google.seen
      expect(seen.map((entry) => entry.host).slice(0, 1)).toEqual(["oauth2.googleapis.com"])
      expect(seen.slice(1).every((entry) => entry.authorization === "Bearer fake-refreshed-access")).toBe(true)
      expect(Option.flatMap(Option.fromUndefinedOr(seen[1]), (entry) => Schema.decodeUnknownOption(Body)(entry.body))).toEqual(Option.some({ project: "proj" }))
      expectNoSecret(yield* setup.fs.readFileString(setup.stateFile))
    }),
  )

  // Every request a read can make, as Google sees it, is one T3 Code makes
  // (apps/server/src/provider/antigravityUsageLimits.ts at 55085df2) and no other:
  // - POST oauth2.googleapis.com/token, a form body of client_id, client_secret,
  //   refresh_token and grant_type: T3's refresh of acp_token.json (its lines
  //   402-411), on which T3 sets no header and neither does this;
  // - POST {daily,prod}/v1internal:retrieveUserQuotaSummary to both hosts, then,
  //   when no summary reads, v1internal:fetchAvailableModels to both (its lines
  //   24-31 and 436-476), each with only Authorization (Bearer) and User-Agent
  //   (T3's `antigravityUserAgent`, its line 21) set and a JSON body `{ project }`
  //   or `{}` (its line 455).
  // T3's GET www.googleapis.com/oauth2/v2/userinfo (an account fingerprint) is
  // not made here: this reads one sign-in per host; nor are the b3 and
  // traceparent trace headers T3's Effect client sends. The other header names
  // are the fetch transport's (Bun's here, Node's in T3), set by neither.
  live(
    "every request a read can make is one T3 Code makes: each run's whole set pinned, none twice, none extra",
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
      yield* (yield* sourceOf(setup, google.base)).read(false)
      const personal = yield* google.seen
      yield* setup.fs.remove(`${setup.profile}/antigravity-acp/acp_token.json`)
      yield* setup.write("antigravity-oauth-token", yield* cliToken(60))
      yield* setup.floorPassed
      yield* (yield* sourceOf(setup, google.base, { auth: "business" })).read(false)
      const business = (yield* google.seen).slice(personal.length)
      const quota = "[accept,accept-encoding,authorization,connection,content-length,content-type,host,user-agent] content-type=application/json auth=Bearer"
      // Sorted: the hosts are asked two at a time, so arrival order within a pair is not fixed.
      expect(personal.map((entry) => entry.wire).toSorted()).toEqual([
        `POST cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels ${quota}`,
        `POST cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary ${quota}`,
        `POST daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels ${quota}`,
        `POST daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary ${quota}`,
        "POST oauth2.googleapis.com/token [accept,accept-encoding,connection,content-length,content-type,host,user-agent] content-type=application/x-www-form-urlencoded auth=",
      ])
      expect(business.map((entry) => entry.wire).toSorted()).toEqual([
        `POST cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels ${quota}`,
        `POST cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary ${quota}`,
        `POST daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels ${quota}`,
        `POST daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary ${quota}`,
      ])
      // The order rule per run: the token first; every summary before any per-model call.
      for (const run of [personal, business]) {
        const paths = run.map((entry) => entry.path)
        const lastSummary = paths.lastIndexOf("/v1internal:retrieveUserQuotaSummary")
        expect(paths.findIndex((path) => path === "/v1internal:fetchAvailableModels")).toBeGreaterThan(lastSummary)
      }
      expect(personal[0]?.path).toBe("/token")
      expect(decodeForm(personal[0]?.body ?? "")).toEqual(["client_id", "client_secret", "grant_type", "refresh_token"])
      // The one header rule: the header names T3's code sets, and the runtime's defaults (Bun's user agent here, where T3 carries Node's).
      expect(personal[0]?.agent).toStartWith("Bun/")
      const quotaCalls = [...personal, ...business].filter((entry) => entry.host !== "oauth2.googleapis.com")
      expect(new Set(quotaCalls.map((entry) => entry.agent))).toEqual(new Set([AGENT]))
      expect(personal.slice(1).map((entry) => entry.body)).toEqual(Array.from({ length: 4 }, () => '{"project":"proj"}'))
      expect(business.map((entry) => entry.body)).toEqual(Array.from({ length: 4 }, () => "{}"))
    }),
  )

  live(
    "the floor holds across authorities: no read within five minutes of the last attempt, whoever made it; the tool's read included",
    Effect.gen(function* () {
      const setup = yield* scratch
      const google = yield* fakeGoogle(ok)
      yield* setup.write("antigravity-oauth-token", yield* cliToken(60))
      const first = yield* sourceOf(setup, google.base)
      const second = yield* sourceOf(setup, google.base)
      yield* first.read(false)
      const once = (yield* google.seen).length
      const floored = yield* second.read(false)
      expect(floored.note).toContain("Not read: a read was attempted within the floor")
      expect(floored.lines.join("\n")).toContain("antigravity / Claude & GPT (shared) · open")
      yield* first.read(true)
      yield* first.lines
      yield* second.open(Option.none())
      expect((yield* google.seen).length).toBe(once)
      const state = yield* setup.state
      expect(Option.map(Option.fromUndefinedOr(state.attempt), (attempt) => state.nextReadAt - attempt.at)).toEqual(Option.some(READ_EVERY_MS))
      yield* setup.floorPassed
      yield* second.read(false)
      expect((yield* google.seen).length).toBe(once * 2)
    }),
  )

  live(
    "an expired token is no request, and a refused bare token reads as expired; neither names the token",
    Effect.gen(function* () {
      const setup = yield* scratch
      const google = yield* fakeGoogle(() => answer(401, { error: { message: `bad token ${TOKEN}` } }))
      yield* setup.write("antigravity-oauth-token", yield* cliToken(-1))
      const source = yield* sourceOf(setup, google.base)
      yield* source.read(false)
      expect(yield* google.seen).toEqual([])
      expect(failureOf(yield* setup.state)).toEqual(Option.some(Why.cases.SignInExpired.make({})))
      yield* setup.write("antigravity-oauth-token", yield* cliToken(60))
      yield* setup.floorPassed
      yield* source.read(false)
      expect((yield* google.seen).length).toBeGreaterThan(0)
      const state = yield* setup.state
      expect(failureOf(state)).toEqual(Option.some(Why.cases.SignInExpired.make({})))
      const lines = yield* source.lines
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
      const source = yield* sourceOf(setup, google.base)
      yield* source.read(false)
      const state = yield* setup.state
      expect(failureOf(state)).toEqual(Option.some(Why.cases.RequestFailed.make({ why: "rate-limited", status: 429 })))
      expect(Option.map(Option.fromUndefinedOr(state.attempt), (attempt) => state.nextReadAt - attempt.at)).toEqual(Option.some(2 * READ_EVERY_MS))
      expectNoSecret(yield* setup.fs.readFileString(setup.stateFile), (yield* source.lines).join("\n"))
    }),
  )

  live(
    "a host that hangs is cut off at the deadline",
    Effect.gen(function* () {
      const setup = yield* scratch
      const google = yield* fakeGoogle(() => Reply.cases.Hang.make({}))
      yield* setup.write("antigravity-oauth-token", yield* cliToken(60))
      const source = yield* sourceOf(setup, google.base)
      const started = yield* DateTime.now
      yield* source.read(false)
      expect(Duration.toMillis(DateTime.distance(started, yield* DateTime.now))).toBeLessThan(15_000)
      expect(failureOf(yield* setup.state)).toEqual(Option.some(Why.cases.RequestFailed.make({ why: "timed-out" })))
    }),
  )

  live(
    "a URL on a host that is not Google's is refused before anything is sent",
    Effect.gen(function* () {
      const setup = yield* scratch
      const google = yield* fakeGoogle(ok)
      yield* setup.write("antigravity-oauth-token", yield* cliToken(60))
      const elsewhere: Endpoints = { token: "https://example.com/token", daily: "https://example.com", prod: "http://cloudcode-pa.googleapis.com" }
      yield* (yield* sourceOf(setup, google.base, { endpoints: elsewhere })).read(false)
      expect(yield* google.seen).toEqual([])
      expect(failureOf(yield* setup.state)).toEqual(Option.some(Why.cases.HostRefused.make({ host: "example.com" })))
    }),
  )

  live(
    "a personal sign-in never reads the keychain, with or without consent: no token file in the managed profile is 'sign in to the managed profile'",
    Effect.gen(function* () {
      const setup = yield* scratch
      const google = yield* fakeGoogle(ok)
      yield* Ref.set(setup.keychainAnswer, yield* keychainEntry(60))
      const source = yield* sourceOf(setup, google.base)
      const read = yield* source.read(true)
      expect(read.note).toContain(`no sign-in in the managed profile ${setup.profile}`)
      yield* setup.floorPassed
      yield* source.read(false)
      expect(yield* setup.keychainReads).toBe(0)
      expect(yield* google.seen).toEqual([])
      expect(failureOf(yield* setup.state)).toEqual(Option.some(Why.cases.NotSignedIn.make({ profile: setup.profile })))
      expect((yield* source.lines).join("\n")).toContain(`sign-in not readable: sign in to the managed profile (bun cmd/pool/antigravity-read.ts --profile-env ${setup.profile})`)
    }),
  )

  live(
    "the managed profile is made from its description as T3 makes it, and a sign-in that lands where it says is what the reader reads",
    Effect.gen(function* () {
      const setup = yield* scratch
      const home = `${setup.root}/home`
      yield* setup.fs.makeDirectory(`${home}/.gemini/config/skills`, { recursive: true })
      yield* setup.fs.writeFileString(`${home}/.gemini/GEMINI.md`, "rules")
      const managed = managedProfile(`${setup.root}/profiles/default`, home)
      // Left from before: a dangling link where T3 makes none, an empty placeholder, and a real file T3 keeps.
      yield* setup.fs.makeDirectory(managed.root, { recursive: true })
      yield* setup.fs.symlink(`${home}/.gemini/AGENTS.md`, `${managed.root}/AGENTS.md`)
      yield* setup.fs.makeDirectory(`${managed.root}/config/skills`, { recursive: true })
      yield* setup.fs.writeFileString(`${managed.root}/config/skills.json`, "{}")
      const prepared = yield* prepareProfile(managed)
      expect(prepared.envFile).toBe(managed.envFile)
      expect(prepared.signIn).toBe(signInLine(managed))
      expect(prepared.links).toEqual([
        [`${managed.root}/config/skills`, "linked"],
        [`${managed.root}/antigravity-cli/skills`, "no target"],
        [`${managed.root}/AGENTS.md`, "no target"],
        [`${managed.root}/GEMINI.md`, "linked"],
        [`${managed.root}/config/skills.json`, "no target"],
      ])
      expect(yield* setup.fs.readLink(`${managed.root}/GEMINI.md`)).toBe(`${home}/.gemini/GEMINI.md`)
      expect(yield* setup.fs.readLink(`${managed.root}/config/skills`)).toBe(`${home}/.gemini/config/skills`)
      expect(yield* setup.fs.exists(`${managed.root}/AGENTS.md`)).toBe(false)
      expect(yield* setup.fs.readFileString(`${managed.root}/config/skills.json`)).toBe("{}")
      for (const directory of managed.directories) expect((yield* setup.fs.stat(directory)).mode & 0o777).toBe(0o700)
      expect(yield* setup.fs.readFileString(managed.settings.path)).toBe('{"auth":{"type":"oauth-personal"}}\n')
      expect((yield* setup.fs.stat(managed.envFile)).mode & 0o777).toBe(0o600)
      expect(yield* setup.fs.readFileString(managed.envFile)).toBe(envFileText(managed))
      // Again over what is there: the same outcome, no failure.
      expect((yield* prepareProfile(managed)).links).toEqual(prepared.links)
      // A sign-in on the profile lands at its token file; the reader on that profile reads it.
      const google = yield* fakeGoogle(ok)
      yield* setup.fs.writeFileString(managed.tokenFiles.cli, yield* cliToken(60))
      const source = yield* make({ profile: managed.root, places: setup.places, store: setup.store, auth: "personal", endpoints: GOOGLE, agent: Effect.succeed(AGENT) }).pipe(
        Effect.provideService(HttpClient.HttpClient, yield* toFake(google.base)),
      )
      expect((yield* source.read(false)).note).toBe("Read now.")
    }),
  )

  live(
    "the keychain: never without a consent; one consent is one attempt; its token is held in memory only, so a restart, an expiry or a refusal touches it no more",
    Effect.gen(function* () {
      const setup = yield* scratch
      const google = yield* fakeGoogle(ok)
      const source = yield* sourceOf(setup, google.base, BUSINESS)
      // No file and no consent: nothing is read, and nothing waits on the floor.
      yield* source.read(false)
      expect(yield* setup.keychainReads).toBe(0)
      expect(failureOf(yield* setup.state)).toEqual(Option.some(Why.cases.NotHeld.make({})))
      expect(yield* google.seen).toEqual([])
      // A consent buys one attempt: it reads, and the consent is used.
      yield* Ref.set(setup.keychainAnswer, yield* keychainEntry(60))
      expect((yield* source.read(true)).note).toBe("Read now.")
      expect(yield* setup.keychainReads).toBe(1)
      const read = yield* setup.state
      expect(read.consentAt).toBeUndefined()
      expect(read.keychain?.outcome).toBe("read")
      expect(read.reading?.windows.length).toBe(2)
      // The token is held: a later read uses it, with no keychain read.
      yield* setup.floorPassed
      yield* source.read(false)
      expect(yield* setup.keychainReads).toBe(1)
      expect((yield* google.seen).length).toBe(4)
      // A restart after a successful read: nothing held, nothing read from the keychain.
      const restarted = yield* sourceOf(setup, google.base, BUSINESS)
      yield* setup.floorPassed
      yield* restarted.read(false)
      expect(yield* setup.keychainReads).toBe(1)
      expect(failureOf(yield* setup.state)).toEqual(Option.some(Why.cases.NotHeld.make({})))
      // A token that has expired: the attempt uses the consent; the next read touches nothing.
      yield* Ref.set(setup.keychainAnswer, yield* keychainEntry(-1))
      yield* restarted.read(true)
      expect(yield* setup.keychainReads).toBe(2)
      expect(failureOf(yield* setup.state)).toEqual(Option.some(Why.cases.SignInExpired.make({})))
      yield* setup.floorPassed
      yield* restarted.read(false)
      expect(yield* setup.keychainReads).toBe(2)
      // A denial uses the consent too; a new consent buys one more attempt.
      yield* Ref.set(setup.keychainAnswer, KeychainRead.cases.Denied.make({}))
      yield* setup.floorPassed
      yield* restarted.read(true)
      expect(yield* setup.keychainReads).toBe(3)
      expect((yield* setup.state).keychain?.outcome).toBe("denied")
      yield* setup.floorPassed
      yield* restarted.read(false)
      expect(yield* setup.keychainReads).toBe(3)
      expectNoSecret(yield* setup.fs.readFileString(setup.stateFile))
    }),
  )

  live(
    "a consent is for its own read: with a token file it goes unused and is dropped, never kept for a later read",
    Effect.gen(function* () {
      const setup = yield* scratch
      const google = yield* fakeGoogle(ok)
      yield* setup.write("antigravity-oauth-token", yield* cliToken(60))
      yield* Ref.set(setup.keychainAnswer, yield* keychainEntry(60))
      const source = yield* sourceOf(setup, google.base, BUSINESS)
      yield* source.read(true)
      expect(yield* setup.keychainReads).toBe(0)
      expect((yield* setup.state).consentAt).toBeUndefined()
      yield* setup.fs.remove(`${setup.profile}/antigravity-acp/antigravity-oauth-token`)
      const restarted = yield* sourceOf(setup, google.base, BUSINESS)
      yield* setup.floorPassed
      yield* restarted.read(false)
      expect(yield* setup.keychainReads).toBe(0)
      // A consent's own read uses it; a floored read with consent records none.
      yield* restarted.read(true)
      expect(yield* setup.keychainReads).toBe(1)
      yield* restarted.read(true)
      expect((yield* setup.state).consentAt).toBeUndefined()
      const again = yield* sourceOf(setup, google.base, BUSINESS)
      yield* setup.floorPassed
      yield* again.read(false)
      expect(yield* setup.keychainReads).toBe(1)
    }),
  )

  live(
    "a token Google refuses (401) is let go: the next read touches the keychain no more",
    Effect.gen(function* () {
      const setup = yield* scratch
      const google = yield* fakeGoogle(() => answer(401, {}))
      const source = yield* sourceOf(setup, google.base, BUSINESS)
      yield* Ref.set(setup.keychainAnswer, yield* keychainEntry(60))
      yield* source.read(true)
      expect(yield* setup.keychainReads).toBe(1)
      expect(failureOf(yield* setup.state)).toEqual(Option.some(Why.cases.SignInExpired.make({})))
      yield* setup.floorPassed
      yield* source.read(false)
      expect(yield* setup.keychainReads).toBe(1)
      expect(failureOf(yield* setup.state)).toEqual(Option.some(Why.cases.NotHeld.make({})))
    }),
  )

  live(
    "many readers on one state file racing one consent make exactly one keychain attempt and one read",
    Effect.gen(function* () {
      const setup = yield* scratch
      const google = yield* fakeGoogle(ok)
      yield* Ref.set(setup.keychainAnswer, yield* keychainEntry(60))
      const authorities = yield* Effect.forEach([1, 2, 3], () => sourceOf(setup, google.base, BUSINESS))
      const calls = authorities.flatMap((source, at) => [source.read(at === 0), source.read(true), source.read(false), source.read(true)])
      yield* Effect.all(calls, { concurrency: 12 })
      expect(yield* setup.keychainReads).toBe(1)
      expect((yield* google.seen).length).toBe(2)
      expect((yield* setup.state).consentAt).toBeUndefined()
    }),
  )

  live(
    "two processes and this one, six authorities on one state file, racing one consent at one moment: exactly one keychain attempt",
    Effect.gen(function* () {
      const setup = yield* scratch
      const attempts = `${setup.root}/keychain-attempts`
      const keychain = Effect.as(setup.fs.writeFileString(attempts, "attempt\n", { flag: "a" }).pipe(Effect.orDie), KeychainRead.cases.Absent.make({}))
      const places = { read: setup.places.read, keychain }
      const elsewhere: Endpoints = { token: "https://example.invalid/token", daily: "https://example.invalid", prod: "https://example.invalid" }
      const here = yield* Effect.forEach([1, 2], () => sourceOf(setup, "http://127.0.0.1:1", { ...BUSINESS, places, endpoints: elsewhere }))
      const writer = yield* writerFile
      const children = yield* Effect.acquireRelease(
        Effect.sync(() => ["w0", "w1"].map((name) => spawn(["bun", writer, setup.root, name], { stdout: "ignore", stderr: "pipe", detached: true }))),
        (started) => Effect.sync(() => started.forEach((child) => child.kill())),
      )
      // Every process ready, then all six authorities let go at once.
      yield* setup.fs.readDirectory(setup.root).pipe(
        Effect.filterOrFail((names) => names.filter((entry) => entry.startsWith("ready-")).length === 2),
        Effect.retry({ schedule: Schedule.spaced(5), times: 4_000 }),
      )
      yield* setup.fs.writeFileString(`${setup.root}/go`, "")
      yield* Effect.all(
        here.map((source) => source.read(true)),
        { concurrency: 2 },
      )
      const codes = yield* Effect.forEach(children, (child) => Effect.promise(() => child.exited), { concurrency: 2 }).pipe(Effect.timeout("20 seconds"), Effect.orDie)
      expect(codes).toEqual([0, 0])
      const lines = (yield* setup.fs.readFileString(attempts)).split("\n").filter((line) => line !== "")
      expect(lines.length).toBe(1)
      const state = yield* setup.state
      expect(state.consentAt).toBeUndefined()
      expect(state.keychain?.outcome).toBe("absent")
    }),
  )

  live(
    "building an authority does no I/O: no file, no keychain, no host lookup, no store",
    Effect.gen(function* () {
      const setup = yield* scratch
      const touched = yield* Ref.make<ReadonlyArray<string>>([])
      const note = (what: string) => Ref.update(touched, (all) => [...all, what])
      const places: Places = { read: () => Effect.as(note("file"), Option.none()), keychain: Effect.as(note("keychain"), KeychainRead.cases.Absent.make({})) }
      const store: Store = { load: Effect.as(note("load"), EMPTY), transact: (step) => Effect.flatMap(note("transact"), () => Effect.map(step(EMPTY), ([, value]) => value)) }
      yield* sourceOf(setup, "http://127.0.0.1:1", { places, store, agent: Effect.as(note("agent"), AGENT) })
      expect(yield* Ref.get(touched)).toEqual([])
    }),
  )

  live(
    "a failure of any dependency, a defect too, is contained: every method answers and none fails",
    Effect.gen(function* () {
      const setup = yield* scratch
      const google = yield* fakeGoogle(ok)
      yield* setup.write("antigravity-oauth-token", yield* cliToken(60))
      const dying: ReadonlyArray<Partial<Pick<Options, "places" | "store" | "agent">>> = [
        { places: { read: () => Effect.die("file read threw"), keychain: setup.places.keychain } },
        { places: { read: () => Effect.succeed(Option.none()), keychain: Effect.die("keychain threw") } },
        { agent: Effect.die("host lookup threw") },
        { store: { load: Effect.die("load threw"), transact: () => Effect.die("transact threw") } },
        { store: { load: setup.store.load, transact: () => Effect.die("transact threw") } },
      ]
      for (const overrides of dying) {
        const source = yield* sourceOf(setup, google.base, overrides)
        yield* setup.floorPassed
        const exits: ReadonlyArray<Exit.Exit<unknown>> = [
          yield* Effect.exit(source.read(true)),
          yield* Effect.exit(source.read(false)),
          yield* Effect.exit(source.lines),
          yield* Effect.exit(source.open(Option.none())),
          yield* Effect.exit(source.record("Individual quota reached. Resets in 1h.", Option.none())),
          yield* Effect.exit(source.clear(Option.none())),
        ]
        expect(exits.every((exit) => Exit.isSuccess(exit))).toBe(true)
      }
      // A transport that throws is contained too.
      const throwing = make({
        profile: setup.profile,
        places: setup.places,
        store: setup.store,
        auth: "personal",
        endpoints: GOOGLE,
        agent: Effect.succeed(AGENT),
      }).pipe(Effect.provideService(HttpClient.HttpClient, HttpClient.make(() => Effect.die("fetch threw"))))
      yield* setup.floorPassed
      const read = yield* Effect.exit(Effect.flatMap(throwing, (source: Source) => source.read(false)))
      expect(Exit.isSuccess(read)).toBe(true)
    }),
  )

  live(
    "a pane's limit message is recorded with its reset, and answers limited until then",
    Effect.gen(function* () {
      const setup = yield* scratch
      const google = yield* fakeGoogle(ok)
      const source = yield* sourceOf(setup, google.base)
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
