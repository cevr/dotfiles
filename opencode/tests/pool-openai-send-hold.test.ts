/** @reads cmd/pool/fixtures/openai-send-hold/** tests/pool-openai-send/** */
import * as BunServices from "@effect/platform-bun/BunServices"
import { Array as Arr, Config, Console, DateTime, Effect, FileSystem, Match, Option, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { describe, expect, it } from "effect-bun-test"
import { poolPlugin } from "../testbeds/anthropic-auth.ts"
import { ROOT } from "../scripts/agents.ts"
import { readHeldSend } from "../mods/pool/refuse.ts"
import { hangGuard } from "./hang-guard.ts"
import { forkRuns } from "./scratch.ts"

const Quote = Schema.Struct({ ok: Schema.Boolean, measured: Schema.Boolean,
  eligible: Schema.optionalKey(Schema.Array(Schema.String)), retryAt: Schema.optionalKey(Schema.Finite) })
const Send = Schema.Struct({ at: Schema.Finite, authorization: Schema.String, transport: Schema.String })
const Seen = Schema.Struct({
  typed: Schema.Boolean, quote: Quote, initial: Quote, outcome: Schema.String, message: Schema.String,
  deferred: Schema.NullOr(Schema.Struct({ at: Schema.Finite, sends: Schema.Finite, upgrades: Schema.Finite, reason: Schema.String })),
  steps: Schema.Array(Schema.Struct({ id: Schema.String, attempt: Schema.Finite })),
  sent: Schema.Array(Send), warm: Schema.Array(Send), upgrades: Schema.Finite, fallback: Schema.Finite, expected: Schema.Finite,
  during: Schema.Json, after: Schema.Json, committed: Schema.Json,
})
const Samples = Schema.fromJsonString(Schema.Struct({ held: Seen, open: Schema.NullOr(Seen) }))
const Override = Schema.fromJsonString(Schema.Struct({ compilerOptions: Schema.Struct({ paths: Schema.Record(Schema.String, Schema.Array(Schema.String)) }) }))
const ResultJson = Schema.fromJsonString(Schema.Json)
const toJson = Schema.encodeSync(ResultJson)
const out = (stream: Stream.Stream<Uint8Array, unknown>) => stream.pipe(Stream.decodeText(), Stream.mkString)
type Sample = "http" | "websocket" | "late-websocket"

const boot = (sample: Sample) => Effect.gen(function* () {
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
    if (sample === "late-websocket") return path.join(poolPlugin, "fixtures/openai-send-hold")
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
  const raw = yield* fs.readFileString(result)
  return yield* Schema.decodeUnknownEffect(Samples)(raw).pipe(Effect.tapError(() => Console.log(raw)))
})

const contained = (seen: typeof Seen.Type, retryAt: number, sample: Sample) => {
  const wanted = Match.value(sample).pipe(Match.when("http", () => 0), Match.orElse(() => 1))
  const after = Option.getOrNull(readHeldSend(seen.after))
  const wording = `held by the pool until ${DateTime.formatIso(DateTime.makeUnsafe(retryAt))}: not an error of the task; retry at or after that time`
  if (seen.typed) {
    expect(seen.sent.filter(({ at }) => at < retryAt)).toHaveLength(0)
    expect(seen.deferred).toEqual({ at: retryAt, sends: 0, upgrades: wanted, reason: expect.stringContaining(wording) })
    const attempts = seen.steps.slice(wanted)
    const id = Option.getOrElse(Option.map(Arr.head(attempts), (step) => step.id), () => "")
    expect(id).not.toBe("")
    expect(attempts).toEqual([{ id, attempt: 1 }, { id, attempt: 2 }])
    expect(Option.getOrNull(readHeldSend(seen.during))).toMatchObject({ hold: { providerID: "openai", reasonCode: "account-held", retryAt, stepID: id } })
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
  for (const sample of ["http", "websocket", "late-websocket"] as const)
    it.live.layer(BunServices.layer)(`the held Step sends nothing before retry time (${sample})`, () =>
      Effect.gen(function* () {
        const { held, open } = yield* boot(sample)
        const retryAt = Match.value(sample).pipe(
          Match.when("late-websocket", () => held.expected),
          Match.orElse(() => Number(held.quote.retryAt)),
        )
        const known = sample !== "late-websocket"
        expect(held.quote).toMatchObject({ ok: !known, measured: true })
        if (!known) expect(held.committed).toEqual({ held: true, until: retryAt })
        if (known && Option.isSome(Option.fromUndefinedOr(held.quote.eligible))) expect(held.quote.eligible).toEqual([])
        if (sample === "http") {
          expect(open).toMatchObject({ quote: { ok: true, measured: true }, outcome: "session.execution.succeeded",
            sent: [expect.objectContaining({ authorization: "Bearer synthetic-access", transport: "http" })] })
          expect(held.warm).toEqual([])
        } else {
          expect(held.initial).toMatchObject({ ok: true, measured: true })
          expect(held.warm).toEqual([expect.objectContaining({ authorization: "Bearer synthetic-access", transport: "websocket" })])
        }
        expect(held.fallback).toBe(0)
        contained(held, retryAt, sample)
      }).pipe(Effect.scoped),
    hangGuard("fork-turn"))
})
