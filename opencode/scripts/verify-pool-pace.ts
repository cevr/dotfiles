// Run from opencode/: bun scripts/verify-pool-pace.ts
// --replay-only compares saved Quint snapshots to the current implementation.
import { BunServices } from "@effect/platform-bun"
import { Array as Arr, Console, Effect, FileSystem, Match, Option, Path, Schema, Stdio, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { dispatchPace } from "../mods/pool/pace.ts"
import type { AccountStatus } from "../mods/pool/status.ts"

const MODEL = "mods/pool/dynamic-pace.qnt"
const VERSION = "0.34.0"
const NOW = Date.parse("2026-11-25T19:00:00Z")
const BigIntField = Schema.Struct({ "#bigint": Schema.String })
const Account = Schema.Struct({
  used: BigIntField, left: BigIntField, fresh: Schema.Boolean, held: Schema.Boolean,
  shortOpen: Schema.Boolean, modelOpen: Schema.Boolean,
})
const State = Schema.Struct({ a: Account, b: Account, charged: BigIntField, eligible: Schema.Struct({ "#set": Schema.Array(BigIntField) }) })
const Trace = Schema.Struct({ vars: Schema.Array(Schema.String), states: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)) })
class VerificationFailed extends Schema.TaggedError<VerificationFailed>()("VerificationFailed", { message: Schema.String }) {}
const number = (field: typeof BigIntField.Type) => Number(field["#bigint"])

const command = Effect.fn("PoolProof.command")(function* (evidence: string, name: string, args: ReadonlyArray<string>, counterexample = false) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const child = yield* ChildProcess.make("quint", args, { stdout: "pipe", stderr: "pipe", forceKillAfter: "5 seconds" })
  const [stdout, stderr, code] = yield* Effect.all([
    Stream.mkString(child.stdout.pipe(Stream.decodeText())), Stream.mkString(child.stderr.pipe(Stream.decodeText())), child.exitCode,
  ], { concurrency: "unbounded" })
  yield* fs.writeFileString(path.join(evidence, `${name}.log`), stdout + stderr)
  const valid = Match.value(counterexample).pipe(
    Match.when(true, () => code === 1 && stderr.includes("found a counterexample")),
    Match.orElse(() => code === 0),
  )
  if (!valid) return yield* new VerificationFailed({ message: `${name}: exit ${code}\n${stdout}${stderr}` })
  const outcome = Match.value(counterexample).pipe(Match.when(true, () => "counterexample found as required"), Match.orElse(() => "passed"))
  yield* Console.log(`${name}: ${outcome}`)
  return stdout.trim()
})

const snapshotAccount = (credentialID: string, a: typeof Account.Type): AccountStatus => ({
  credentialID, live: 0, load: 0, noRoom: false,
  ...Option.match(Option.filter(Option.some({ kind: "rate-limit" as const, at: NOW, until: NOW + 3_600_000 }), () => a.held), {
    onNone: () => ({}), onSome: (hold) => ({ hold }),
  }),
  reading: {
    at: NOW - Number(!a.fresh) * 31 * 60_000,
    windows: [
      { name: "7d", utilization: number(a.used) / 16800, resetAt: NOW + number(a.left) * 3_600_000 },
      { name: "5h", utilization: Number(!a.shortOpen) * 0.95, resetAt: NOW + 3_600_000 },
      { name: "7d:Fable", utilization: Number(!a.modelOpen), resetAt: NOW + 3_600_000 },
    ],
  },
})

const prove = Effect.fn("PoolProof.prove")(function* (evidence: string) {
  const path = yield* Path.Path
  const installed = yield* command(evidence, "version", ["--version"])
  if (installed !== VERSION) return yield* new VerificationFailed({ message: `expected Quint ${VERSION}, found ${installed}` })
  yield* command(evidence, "typecheck", ["typecheck", MODEL])
  yield* command(evidence, "verify", ["verify", MODEL, "--main", "dynamic_pace", "--invariant", "safe", "--max-steps", "8", "--verbosity", "1"])
  for (const mutant of ["pooled_debt", "unpaced_placement", "free_starts", "ignored_limits"])
    yield* command(evidence, mutant, ["verify", MODEL, "--main", mutant, "--invariant", "safe", "--max-steps", "1", "--out-itf", path.join(evidence, `${mutant}.itf.json`), "--verbosity", "1"], true)
  for (const init of ["init", "initWitness", "initFleet", "initRollover"])
    yield* command(evidence, `traces-${init}`, ["run", MODEL, "--main", "dynamic_pace", "--init", init,
      "--invariant", "safe", "--seed", "20261125", "--max-samples", "64", "--max-steps", "30",
      "--n-traces", "32", "--out-itf", path.join(evidence, `trace-${init}-{seq}.json`), "--verbosity", "1"])
})

const replay = Effect.fn("PoolProof.replay")(function* (evidence: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  let snapshots = 0
  let admitted = 0
  let held = 0
  const files = yield* fs.readDirectory(evidence)
  for (const name of files.filter((name) => name.startsWith("trace-") && name.endsWith(".json"))) {
    const trace = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Trace))(yield* fs.readFileString(path.join(evidence, name)))
    const key = Arr.findFirst(trace.vars, (name) => name.endsWith("::s"))
    if (Option.isNone(key)) return yield* new VerificationFailed({ message: `${name}: no admission snapshot` })
    for (const raw of trace.states) {
      const state = yield* Schema.decodeUnknownEffect(State)(raw[key.value])
      const charged = number(state.charged)
      const starts = Arr.filter([NOW - 1], () => charged > 0)
      const answer = dispatchPace([snapshotAccount("0", state.a), snapshotAccount("1", state.b)], NOW, {}, 0.005, "claude-fable-5-2", {
        inflight: { starts, cost: charged / 16800, settleMs: 600_000 },
      })
      const expected = state.eligible["#set"].map((id) => String(number(id))).toSorted()
      const actual = Match.value(answer).pipe(
        Match.when({ ok: true }, (answer) => [...Option.getOrElse(Option.fromUndefinedOr(answer.eligible), () => [])].toSorted()),
        Match.orElse((): string[] => []),
      )
      if (answer.ok !== (expected.length > 0) || actual.join(",") !== expected.join(","))
        return yield* new VerificationFailed({ message: `${name} snapshot ${snapshots}: Quint eligible [${expected}], TypeScript [${actual}], ok=${answer.ok}: ${answer.reason}` })
      snapshots++
      if (answer.ok) admitted++
      else held++
    }
  }
  if (admitted === 0 || held === 0) return yield* new VerificationFailed({ message: "trace replay must exercise admissions and holds" })
  yield* Console.log(`TypeScript conformance: ${snapshots} snapshots (${admitted} admitted, ${held} held) match Quint; evidence: ${evidence}`)
})

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const args = yield* (yield* Stdio.Stdio).args
  const evidence = path.resolve("out/pool-pace")
  yield* fs.makeDirectory(evidence, { recursive: true })
  if (!args.includes("--replay-only")) yield* prove(evidence)
  yield* replay(evidence)
})

void Effect.runPromise(main.pipe(Effect.scoped, Effect.provide(BunServices.layer)))
