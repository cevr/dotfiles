/** @reads cmd/pool/fixtures/openai-send-hold/** tests/pool-openai-send/** */
import * as BunServices from "@effect/platform-bun/BunServices"
import { Array as Arr, Config, Console, DateTime, Effect, FileSystem, Match, Option, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { describe, expect, it } from "effect-bun-test"
import { poolPlugin } from "../testbeds/anthropic-auth.ts"
import { ROOT } from "../scripts/agents.ts"
import { readHeldSend } from "../mods/pool/refuse.ts"
import { USAGE_TIMEOUT_MS } from "../mods/pool/quota.ts"
import { hangGuard } from "./hang-guard.ts"
import { forkRuns } from "./scratch.ts"

const Quote = Schema.Struct({ ok: Schema.Boolean, measured: Schema.Boolean,
  eligible: Schema.optionalKey(Schema.Array(Schema.String)), retryAt: Schema.optionalKey(Schema.Finite),
  tracking: Schema.optionalKey(Schema.String) })
const Send = Schema.Struct({ at: Schema.Finite, authorization: Schema.String, transport: Schema.String })
const Seen = Schema.Struct({
  typed: Schema.Boolean, quote: Quote, initial: Quote, outcome: Schema.String, message: Schema.String,
  deferred: Schema.NullOr(Schema.Struct({ at: Schema.Finite, sends: Schema.Finite, upgrades: Schema.Finite, reason: Schema.String })),
  steps: Schema.Array(Schema.Struct({ id: Schema.String, attempt: Schema.Finite })),
  sent: Schema.Array(Send), warm: Schema.Array(Send), upgrades: Schema.Finite, fallback: Schema.Finite, expected: Schema.Finite,
  during: Schema.Json, after: Schema.Json, committed: Schema.Json,
  cost: Schema.Json, costUsageReads: Schema.Finite,
})
const Samples = Schema.fromJsonString(Schema.Struct({ held: Seen, open: Schema.NullOr(Seen) }))
const Fresh = Schema.fromJsonString(Schema.Struct({ held: Schema.Struct({
  before: Schema.Finite, usage: Schema.Finite, began: Schema.Finite, start: Schema.Finite, end: Schema.Finite, sent: Schema.Array(Send),
  outcome: Schema.String, message: Schema.String, status: Schema.Json, heldSend: Schema.Json,
}) }))
const Override = Schema.fromJsonString(Schema.Struct({ compilerOptions: Schema.Struct({ paths: Schema.Record(Schema.String, Schema.Array(Schema.String)) }) }))
const ResultJson = Schema.fromJsonString(Schema.Json)
const toJson = Schema.encodeSync(ResultJson)
const scheduledAt = (seen: typeof Seen.Type) => Option.getOrElse(
  Option.map(Option.fromNullishOr(seen.deferred), ({ at }) => at), () => 0,
)
const out = (stream: Stream.Stream<Uint8Array, unknown>) => stream.pipe(Stream.decodeText(), Stream.mkString)
type Sample = "http" | "websocket" | "late-http" | "late-websocket" | "api-http" | "api-websocket" | "cost"
  | "retry-http" | "retry-websocket" | "signed-out-http"
type FreshSample = "fresh-spent" | "fresh-free" | "fresh-timeout"

const outputFor = (sample: Sample | FreshSample) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const fork = yield* Config.String("OPENCODE_DEV")
  const search = yield* Config.String("PATH")
  const chrome = yield* Config.option(Config.String("CHROME"))
  const control = yield* Config.option(Config.String("POOL_OPENAI_CONTROL_PLUGIN"))
  const override = yield* Config.option(Config.String("POOL_OPENAI_CONTROL_TSCONFIG"))
  const extra = yield* Option.match(override, {
    onNone: () => Effect.succeed({}),
    onSome: (file) => fs.readFileString(file).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Override)), Effect.map((json) => json.compilerOptions.paths)),
  })
  const base = yield* fs.makeTempDirectoryScoped({ prefix: "pool-openai-send-" })
  const folder = (name: string) => {
    const dir = path.join(base, name)
    return fs.makeDirectory(dir).pipe(Effect.as(dir))
  }
  const [home, config, data, state, cache, temp] = yield* Effect.forEach(["home", "config", "data", "state", "cache", "temp"], folder)
  const settings = path.join(base, "fixture-tsconfig.json")
  const result = path.join(base, "result.json")
  yield* fs.writeFileString(settings, toJson({ compilerOptions: { paths: {
    ...extra, "pool-fixture-sdk": [path.join(fork, "packages/sdk/src/effect/index.ts")],
  } } }))
  const plugin = Option.getOrElse(control, () => {
    if (sample.startsWith("late-") || sample.startsWith("retry-") || sample === "signed-out-http" || sample === "cost")
      return path.join(poolPlugin, "fixtures/openai-send-hold")
    return poolPlugin
  })
  const child = yield* spawner.spawn(ChildProcess.make("bun", ["--tsconfig-override", settings, path.join(ROOT, "tests/pool-openai-send/run.ts")], {
    cwd: ROOT, extendEnv: false, stdin: "ignore", forceKillAfter: "3 seconds",
    env: {
      PATH: search, ...Option.match(chrome, { onNone: () => ({}), onSome: (CHROME) => ({ CHROME }) }),
      HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data, XDG_STATE_HOME: state, XDG_CACHE_HOME: cache, TMPDIR: temp,
      OPENCODE_DISABLE_MODELS_FETCH: "1", POOL_FIXTURE_BASE: base, POOL_FIXTURE_PLUGIN: plugin,
      POOL_FIXTURE_SAMPLE: sample, POOL_FIXTURE_RESULT: result,
    },
  }))
  const [stdout, stderr, code] = yield* Effect.all([out(child.stdout), out(child.stderr), child.exitCode], { concurrency: 3 })
  expect(Number(code), `${stdout}\n${stderr}`).toBe(0)
  return yield* fs.readFileString(result)
})
const boot = (sample: Sample) => outputFor(sample).pipe(Effect.flatMap((raw) =>
  Schema.decodeUnknownEffect(Samples)(raw).pipe(Effect.tapError(() => Console.log(raw)))))

const contained = (seen: typeof Seen.Type, retryAt: number, sample: Sample) => {
  const wanted = Number(sample.endsWith("websocket"))
  const after = Option.getOrNull(readHeldSend(seen.after))
  const wording = `held by the pool until ${DateTime.formatIso(DateTime.makeUnsafe(retryAt))}: not an error of the task; retry at or after that time`
  if (seen.typed) {
    expect(seen.sent.filter(({ at }) => at < retryAt)).toHaveLength(0)
    // The host can round a short remaining wait up to its minimum retry
    // interval. The durable pool fact, not the host's schedule, owns retryAt.
    expect(scheduledAt(seen)).toBeGreaterThanOrEqual(retryAt)
    expect(seen.deferred).toEqual({ at: expect.any(Number), sends: 0, upgrades: wanted, reason: expect.stringContaining(wording) })
    const attempts = seen.steps.slice(wanted)
    const id = Option.getOrElse(Option.map(Arr.head(attempts), (step) => step.id), () => "")
    expect(id).not.toBe("")
    expect(attempts).toEqual([{ id, attempt: 1 }, { id, attempt: 2 }])
    expect(Option.getOrNull(readHeldSend(seen.during))).toMatchObject({ hold: { providerID: "openai", reasonCode: "account-held", retryAt, stepID: id } })
    if (sample === "late-http") expect(Option.getOrNull(readHeldSend(seen.during))).toMatchObject({ state: "ended" })
    expect(after).toEqual({})
    expect(seen.outcome).toBe("session.execution.succeeded")
    expect(seen.sent).toHaveLength(1)
    // A concrete refusal disposes the old connection on the newer host.
    // Only the post-deadline retry can upgrade again.
    expect(seen.upgrades).toBe(wanted + Number(sample === "late-websocket"))
    expect(Option.getOrElse(Option.map(Arr.head(seen.sent), (send) => send.at), () => 0)).toBeGreaterThanOrEqual(retryAt)
    return
  }
  expect(seen.sent).toHaveLength(0)
  expect(seen.outcome).toBe("session.execution.failed")
  expect(seen.upgrades).toBe(wanted)
  if (sample === "late-websocket") expect(seen.message).toContain("Failed to read openai/openai-responses stream")
  else expect(seen.message).toContain(wording)
  expect(after).toMatchObject({ hold: { providerID: "openai", reasonCode: "account-held", retryAt } })
}

describe.skipIf(!forkRuns)("OpenAI final hold on native OpenCode", () => {
  for (const sample of ["fresh-spent", "fresh-free", "fresh-timeout"] as const)
    it.live.layer(BunServices.layer)(`the first send uses one usage read, measured or bounded (${sample})`, () =>
      Effect.gen(function* () {
        const { held } = yield* outputFor(sample).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Fresh)))
        expect(held.usage).toBe(1)
        expect(held.before).toBe(0)
        expect(held.start).toBeGreaterThan(0)
        const measurement = Match.value(sample).pipe(Match.when("fresh-timeout", () => "unmeasured"), Match.orElse(() => "measured"))
        expect(held.status).toMatchObject({ openai: { accounts: [expect.objectContaining({ measurement })] } })
        if (sample === "fresh-spent") {
          expect(held.sent).toEqual([])
          expect(held.message).toContain("held by the pool until")
          expect(Option.getOrNull(readHeldSend(held.heldSend))).toMatchObject({ state: "held", hold: { reasonCode: "account-held" } })
          return
        }
        expect(held.outcome).toBe("session.execution.succeeded")
        expect(held.sent).toHaveLength(1)
        const finished = Match.value(sample).pipe(Match.when("fresh-timeout", () => held.began + USAGE_TIMEOUT_MS), Match.orElse(() => held.end))
        const sent = Option.getOrThrow(Option.fromUndefinedOr(held.sent[0]))
        expect(sent.at).toBeGreaterThanOrEqual(finished)
        expect(held.heldSend).toEqual({})
      }).pipe(Effect.scoped), hangGuard("fork-turn"))
  for (const sample of ["retry-http", "retry-websocket"] as const)
    it.live.layer(BunServices.layer)(`a provider error does not reuse admission on the retry (${sample})`, () =>
      Effect.gen(function* () {
        const { held } = yield* boot(sample)
        const { expected, typed } = held
        expect(held.committed).toEqual({ held: true, until: expected })
        expect(held.sent.filter(({ at }) => at < expected)).toHaveLength(1)
        expect(held.fallback).toBe(0)
        if (typed) {
          const attempts = held.steps.slice(held.warm.length)
          const id = Option.getOrElse(Option.map(Arr.head(attempts), (step) => step.id), () => "")
          expect(id).not.toBe("")
          expect(attempts).toEqual([{ id, attempt: 1 }, { id, attempt: 2 }, { id, attempt: 3 }])
          expect(scheduledAt(held)).toBeGreaterThanOrEqual(expected)
          expect(held.deferred).toMatchObject({ sends: 1 })
          expect(Option.getOrNull(readHeldSend(held.during))).toMatchObject({ hold: { stepID: id, retryAt: expected } })
          expect(held.sent).toHaveLength(2)
          expect(held.sent[1]?.at).toBeGreaterThanOrEqual(expected)
          expect(held.outcome).toBe("session.execution.succeeded")
        } else {
          expect(held.sent).toHaveLength(1)
          expect(held.outcome).toBe("session.execution.failed")
          expect(Option.getOrNull(readHeldSend(held.after))).toMatchObject({ hold: { providerID: "openai", retryAt: expected } })
        }
      }).pipe(Effect.scoped), hangGuard("fork-turn"))
  it.live.layer(BunServices.layer)("after sign-out and SDK restart, no request carries the previous pool token", () =>
    Effect.gen(function* () {
      const { held } = yield* boot("signed-out-http")
      expect(held.committed).toEqual({ held: true, until: held.expected })
      expect(held.quote).toMatchObject({ ok: true, measured: false, tracking: "not-tracked-no-pool-login" })
      expect(held.sent).toEqual([expect.objectContaining({ authorization: "Bearer synthetic-api-key", transport: "http" })])
      expect(held.outcome).toBe("session.execution.succeeded")
    }).pipe(Effect.scoped), hangGuard("fork-turn"))
  it.live.layer(BunServices.layer)("each new send uses one native hold-store read; control frames do not", () =>
    Effect.gen(function* () {
      const { held } = yield* boot("cost")
      const wait = (n: number) => ({ holdLockWaitMs: { n } })
      expect(held.cost).toMatchObject({
        http: { control: wait(0), tracked: wait(1_000) },
        websocket: { control: wait(0), tracked: wait(1_000), oneStream: wait(1), eightSessions: wait(1_000) },
      })
      expect(held.costUsageReads).toBe(0)
      yield* Console.log("send-cost native", toJson(held.cost))
    }).pipe(Effect.scoped), hangGuard("fork-turn"))
  for (const sample of ["http", "websocket", "late-http", "late-websocket", "api-http", "api-websocket"] as const)
    it.live.layer(BunServices.layer)(`the held Step sends nothing before retry time (${sample})`, () =>
      Effect.gen(function* () {
        const { held, open } = yield* boot(sample)
        if (sample.startsWith("api-")) {
          expect(held.quote).toMatchObject({ ok: true, measured: false, tracking: "not-tracked-no-pool-login" })
          expect(held.outcome).toBe("session.execution.succeeded")
          expect(held.sent).toEqual([expect.objectContaining({ authorization: "Bearer synthetic-access" })])
          expect(held.after).toEqual({})
          return
        }
        const known = !sample.startsWith("late-")
        const retryAt = Match.value(known).pipe(
          Match.when(false, () => held.expected),
          Match.orElse(() => Number(held.quote.retryAt)),
        )
        expect(held.quote).toMatchObject({ ok: !known, measured: true })
        if (!known) expect(held.committed).toEqual({ held: true, until: retryAt })
        if (known && Option.isSome(Option.fromUndefinedOr(held.quote.eligible))) expect(held.quote.eligible).toEqual([])
        if (sample === "http") {
          expect(open).toMatchObject({ quote: { ok: true, measured: true }, outcome: "session.execution.succeeded",
            sent: [expect.objectContaining({ authorization: "Bearer synthetic-access", transport: "http" })] })
          expect(held.warm).toEqual([])
        } else if (sample.endsWith("websocket")) {
          expect(held.initial).toMatchObject({ ok: true, measured: true })
          expect(held.warm).toEqual([expect.objectContaining({ authorization: "Bearer synthetic-access", transport: "websocket" })])
        }
        expect(held.fallback).toBe(0)
        contained(held, retryAt, sample)
      }).pipe(Effect.scoped),
    hangGuard("fork-turn"))
})
