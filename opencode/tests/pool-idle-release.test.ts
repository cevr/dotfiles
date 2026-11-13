// accept: deep (49.2 s alone: 1-minute load under 24 on 12 cores; it boots real OpenCode twice, one turn each)
// Real OpenCode (the fork's `serve --service`, from source) with an Anthropic
// login, the Anthropic auth plugin and the pool, against the fake Anthropic
// API. A turn pins its session's run to the login it went out on; when the
// session goes idle, however the turn ended, the pool must let the pin go.
// The host publishes no `session.idle` event: it says a session went idle with
// `session.execution.succeeded`, `.failed` or `.interrupted`. The pool's cache
// life is 1 ms here, so the status method's `live` counts pins alone.
import { describe } from "bun:test"
import { Clock, Data, Effect, FileSystem, Option, Ref, Schedule, Schema, Stream } from "effect"
import { expect, it } from "effect-bun-test"
import { Base64 } from "effect/encoding"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { forkLaunch } from "../testbeds/gamut/gamut.ts"
import { anthropicAuthPlugin, poolPlugin } from "../testbeds/anthropic-auth.ts"
import { fakeAccount, startFakeAnthropic, type FakeAnswer, type FakeRequestInfo } from "./fake-anthropic.ts"
import { ENV, Platform } from "./reconnect/host.ts"
import { forkRuns, keptScratch } from "./scratch.ts"
import { ready } from "./service.ts"

const HOUR = 3_600_000
const TIMEOUT_MS = 150_000
/** How long the pool has, after the session went idle, to let the pin go. */
const RELEASE_MS = 10_000
const LOOK_MS = 250

/** As much of the fork's client as the test uses; the fork is found at run time, so it is typed here. */
interface Client {
  readonly session: {
    readonly create: (input: { title: string; location: { directory: string } }) => Promise<{ readonly id: string }>
    readonly prompt: (input: { sessionID: string; text: string }) => Promise<object>
  }
  readonly experimental: { readonly session: { readonly wait: (input: { sessionID: string }) => Promise<void> } }
  readonly rpc: {
    readonly call: (input: { rpcID: string; method: string; location: { directory: string }; input: object }) => Promise<object>
  }
}
interface ClientModule {
  readonly OpenCode: { readonly make: (options: { baseUrl: string; headers: { readonly authorization: string } }) => Client }
}

/** The pool status method's answer, as far as the test reads it: each Anthropic login and its live sessions. */
const Status = Schema.Struct({
  output: Schema.Struct({
    anthropic: Schema.Struct({ accounts: Schema.Array(Schema.Struct({ credentialID: Schema.String, live: Schema.Number })) }),
  }),
})
const decodeStatus = Schema.decodeUnknownOption(Status)
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

class NotYet extends Data.TaggedError("NotYet")<{ readonly last: string }> {}
class TimedOut extends Data.TaggedError("TimedOut")<{ readonly message: string }> {}

/** Reads `read` until `done` holds, every 250 ms for `ms`; past it, fails with `label`, read then, and the last read. */
const until = <A, R>(read: Effect.Effect<A, never, R>, done: (value: A) => boolean, label: Effect.Effect<string>, ms: number) =>
  read.pipe(
    Effect.filterOrFail(done, (seen) => new NotYet({ last: toJson(seen) })),
    Effect.retry({ schedule: Schedule.spaced(`${LOOK_MS} millis`), times: Math.ceil(ms / LOOK_MS) }),
    Effect.catchTag("NotYet", (error) => Effect.flatMap(label, (said) => Effect.fail(new TimedOut({ message: `${said}: still ${error.last}` })))),
  )

/**
 * A server whose one login answers agent turns with `turn`; one turn of a fresh, titled session on it
 * (no title request goes out after the turn to pin it again). Its agent turns as the fake saw them,
 * the login's live sessions as the pool tells them, and the server's stderr so far.
 */
const turnOn = (root: string, turn: FakeAnswer) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const { fork, path } = yield* ENV
    const now = yield* Clock.currentTimeMillis
    const accounts = { only: fakeAccount() }
    const fake = yield* Effect.acquireRelease(
      Effect.sync(() =>
        startFakeAnthropic({
          accounts,
          // An agent turn offers tools; the rest (a title, were one asked) gets a plain answer.
          script: ({ body }: FakeRequestInfo): FakeAnswer =>
            Option.getOrElse(
              Option.liftPredicate(turn, () => Array.isArray(body.tools) && body.tools.length > 0),
              (): FakeAnswer => ({ kind: "ok", text: "Greeting" }),
            ),
        }),
      ),
      (started) => Effect.promise(() => started.stop()),
    )
    const home = `${root}/home`
    yield* fs.makeDirectory(`${home}/.config/opencode`, { recursive: true })
    yield* fs.makeDirectory(`${root}/work`)
    const work = yield* fs.realPath(`${root}/work`)
    // The global config, which every Location the server opens reads.
    yield* fs.writeFileString(
      `${home}/.config/opencode/opencode.json`,
      toJson({
        model: "anthropic/claude-haiku-4-5",
        plugins: [anthropicAuthPlugin, { package: poolPlugin, options: { sweepMinutes: 0, cacheLifeMs: 1 } }],
      }),
    )
    const launch = forkLaunch(fork, process.execPath)
    const env = {
      PATH: path,
      HOME: home,
      XDG_CONFIG_HOME: `${home}/.config`,
      XDG_DATA_HOME: `${home}/.local/share`,
      XDG_STATE_HOME: `${home}/.local/state`,
      XDG_CACHE_HOME: `${home}/.cache`,
      OPENCODE_DB: `${root}/opencode.db`,
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      ANTHROPIC_BASE_URL: fake.url,
      ...launch.env,
    }
    const [command = "", ...args] = launch.base
    // The login goes in on stdin, never in argv or a file.
    const login = {
      id: "cred_only",
      integrationID: "anthropic",
      label: "Anthropic 1",
      active: true,
      value: { type: "oauth", methodID: "claude-max", refresh: accounts.only.refresh, access: accounts.only.access, expires: now + 8 * HOUR },
    }
    const imported = yield* spawner
      .spawn(
        ChildProcess.make(command, [...args, "auth", "import", "--standalone"], {
          cwd: work,
          env,
          extendEnv: false,
          stdin: Stream.make(new TextEncoder().encode(toJson([login]))),
          stdout: "ignore",
          stderr: "ignore",
          forceKillAfter: "3 seconds",
        }),
      )
      .pipe(
        Effect.flatMap((child) => child.exitCode),
        Effect.scoped,
      )
    expect(Number(imported)).toBe(0)

    // The server runs in a process group of its own; the test's scope stops the group.
    const server = yield* spawner.spawn(
      ChildProcess.make(command, [...args, "serve", "--service", "--port", "0"], {
        cwd: work,
        env,
        extendEnv: false,
        stdin: "ignore",
        stdout: "ignore",
        forceKillAfter: "3 seconds",
      }),
    )
    const stderr = yield* Ref.make("")
    yield* server.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((text) => Ref.update(stderr, (seen) => (seen + text).slice(-2_000))),
      Effect.ignore,
      Effect.forkScoped,
    )
    const tail = Ref.get(stderr)
    const service = yield* Effect.promise(() => ready(`${home}/.local/state/opencode/service-local.json`, () => "the pool's server"))
    const module = yield* Effect.promise((): Promise<ClientModule> => import(`${fork}/packages/client/src/promise/index.ts`))
    const client = module.OpenCode.make({ baseUrl: service.url, headers: { authorization: `Basic ${Base64.encode(`opencode:${service.password}`)}` } })
    const location = { directory: work }
    // The work directory's copy of the plugin: the one that places the session's requests.
    const live = Effect.tryPromise(() => client.rpc.call({ rpcID: "dotfiles-opencode.pool", method: "status", location, input: {} })).pipe(
      Effect.map((answer) => Option.map(decodeStatus(answer), (status) => status.output.anthropic.accounts)),
      Effect.orElseSucceed(() => Option.none()),
    )
    // The pool answers once its plugin is up; it lists its logins at the first request.
    yield* until(live, Option.isSome, Effect.map(tail, (seen) => `the pool's status (${seen})`), 30_000)

    const session = yield* Effect.promise(() => client.session.create({ title: "pool idle release", location }))
    yield* Effect.promise(() => client.session.prompt({ sessionID: session.id, text: "say hello" }))
    yield* Effect.promise(() => client.experimental.session.wait({ sessionID: session.id }))
    const turns = fake.received.filter((request) => request.path === "/v1/messages" && request.tools > 0).map((request) => [request.account, request.status])
    return { turns, live, tail }
  })

/** One turn that ends with `turn`, then the wait for the login to have no live session. */
const releasedAfter = (kept: ReturnType<typeof keptScratch>, name: string, turn: (now: number) => FakeAnswer, status: number) =>
  Effect.gen(function* () {
    const root = yield* Effect.sync(() => kept.dir(`${name}-`))
    const now = yield* Clock.currentTimeMillis
    const { turns, live, tail } = yield* turnOn(root, turn(now))
    expect(turns).toEqual([["only", status]])
    const accounts = yield* until(
      live,
      (read) => Option.exists(read, (each) => each.every((account) => account.live === 0)),
      Effect.map(tail, (seen) => `the ${name} turn's pin (${seen})`),
      RELEASE_MS,
    )
    expect(Option.map(accounts, (each) => each.map((account) => account.credentialID))).toEqual(Option.some(["cred_only"]))
  })

const test = it.scopedLive.layer(Platform)

describe.skipIf(!forkRuns)("the pool lets a run's login go when its session goes idle (real OpenCode, fake Anthropic)", () => {
  const kept = keptScratch(forkRuns, "pool-idle-release-")

  // The only login is plan-limited: the pool holds it and the turn ends on the pool's refusal.
  test(
    "a turn that ends failed lets its login go",
    () => releasedAfter(kept, "failed", (now) => ({ kind: "usage-429", claim: "five_hour", resetAt: now + 3 * HOUR }), 429),
    TIMEOUT_MS,
  )

  test("a turn that succeeds lets its login go", () => releasedAfter(kept, "succeeded", () => ({ kind: "ok", text: "Hello." }), 200), TIMEOUT_MS)
})
