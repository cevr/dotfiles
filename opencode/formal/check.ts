// `bun formal/check.ts` (from opencode/): the formal check of the orchestrate batch machine's pipeline rule.
//
//   1. `quint typecheck` the model (formal/orchestrate/machine.qnt);
//   2. `quint run`: random walks of the model, checking `pipeline` at every state, and each witness reached
//      at least once (a check whose runs never reach a second batch proves nothing);
//   3. replays every trace the run wrote through the real machine (mods/orchestrate/machine.ts `machine`):
//      the code must refuse what the model refuses, by the same rule, and fold to the same state;
//   4. with --deep, `quint verify` (Apalache): every run of the model up to --depth steps, not a sample;
//   5. with --mutants, the check's own proof that it can fail: each mutant breaks one guard, in a scratch copy
//      of machine.ts (the replay must part from the model) and of the model (`pipeline` must break).
//
// Flags: --step <action> (default `step`; a finding's own step, such as `stepLandAny`, shows its
// counterexample), --samples N (default 4000), --steps N (40), --seed S (fixed, so a rerun is the same run),
// --threads N (4), --depth N (--deep's bound, default 8: about a minute; 12 runs past 20 minutes).
// Exit 0 green, 1 red (a break, a divergence, an unreached witness, a missed mutant), 2 a usage or tool error.
// The tool versions are pinned: Quint by formal/package.json, its evaluator and Apalache by that Quint.
//
// A CLI adapter: the root has no Effect platform layer, so it reads argv from process, runs Quint and git with
// Bun.spawn, reads and writes the scratch files with node:fs, imports each mutant of machine.ts by its path,
// and exits with process.exit.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Array as Arr, Console, Data, Effect, Option, Order } from "effect"
import * as Real from "../mods/orchestrate/machine.ts"
import { pick, replay, storyOf, type Real as Machine } from "./orchestrate/replay.ts"
import { decodeTrace, type Step } from "./orchestrate/trace.ts"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, "..")
const QUINT = path.join(HERE, "node_modules", ".bin", "quint")
const MODEL = path.join(HERE, "orchestrate", "machine.qnt")
const CODE = path.join(ROOT, "mods", "orchestrate", "machine.ts")
const WITNESSES = ["witnessSecondBatch", "witnessFoldedLand", "witnessRefusedPending", "witnessRefusedUnfolded"]

/**
 * The commit at which the model was last confirmed to describe the covered code, and that code. A change to a
 * covered file since this commit is printed: the model may have drifted (the replay catches a change of
 * behavior on the paths the runs reach; a reviewer reads the rest). Move it forward only after confirming the
 * model at the new commit (.claude/skills/formal-opencode/SKILL.md, "Keep it in step").
 */
export const SYNC = "7f5120d8"
export const COVERED = ["opencode/mods/orchestrate/machine.ts", "opencode/mods/orchestrate/model.ts", "opencode/cmd/orchestrate/server.ts", "opencode/mods/rift/model.ts"]

const ARGV = process.argv.slice(2)
const flag = (name: string) => ARGV.includes(name)
const option = (name: string, fallback: string) => Option.getOrElse(Arr.get(ARGV, ARGV.indexOf(name) + 1).pipe(Option.filter(() => ARGV.includes(name))), () => fallback)
const STEP = option("--step", "step")
const SAMPLES = option("--samples", "4000")
const STEPS = option("--steps", "40")
const SEED = option("--seed", "0x5eed")
const THREADS = option("--threads", "4")
const DEPTH = option("--depth", "8")
/** How many of the run's traces are written and replayed. */
const TRACES = "200"

/** One guard broken on purpose: the same break in the code and in the model. */
interface Mutant {
  readonly name: string
  readonly why: string
  readonly code: readonly [string, string]
  readonly model: readonly [string, string]
}

export const MUTANTS: ReadonlyArray<Mutant> = [
  {
    name: "verdict-pending",
    why: "a land no longer waits for the last batch's verdict",
    code: ['if (verdictPending(state)) rules.push("VerdictPending")', 'if (false) rules.push("VerdictPending")'],
    model: ['else if (verdictPending(s)) "VerdictPending" // mutant: verdict-pending', 'else if (false) "VerdictPending"'],
  },
  {
    name: "finding-unfolded",
    why: "a land no longer waits for the last verdict's findings to be folded",
    code: [
      'if (unfoldedOf(state, lands).length > 0 || unresolvedOf(state).length > 0) rules.push("FindingUnfolded")',
      'if (false) rules.push("FindingUnfolded")',
    ],
    model: ['else if (unfoldedOf(s, lands) != Set() or s.unresolved != Set()) "FindingUnfolded" // mutant: finding-unfolded', 'else if (false) "FindingUnfolded"'],
  },
  {
    name: "silent-verdict",
    why: "a verifier that died or was stopped counts as a verdict",
    code: ['const silent = event.verdict === "none" || event.verdict === "stopped"', "const silent = false"],
    model: ['val silent = verdict == "none" or verdict == "stopped" // mutant: silent-verdict', "val silent = false"],
  },
]

/** The check's end: red (1) or a tool's failure (2), with what to say. */
class Stop extends Data.TaggedError("Stop")<{ readonly code: 1 | 2; readonly lines: ReadonlyArray<string> }> {}

const red = (...lines: ReadonlyArray<string>) => new Stop({ code: 1, lines })

/** Runs `argv` in `cwd`; its exit and its output, stdout then stderr. */
const run = Effect.fn("Formal.run")(function* (argv: ReadonlyArray<string>, cwd: string) {
  const failed = () => new Stop({ code: 2, lines: [`cannot run ${argv.join(" ")}`] })
  const child = yield* Effect.try({ try: () => Bun.spawn([...argv], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" }), catch: failed })
  const [stdout, stderr, code] = yield* Effect.all(
    [
      Effect.tryPromise({ try: () => Bun.readableStreamToText(child.stdout), catch: failed }),
      Effect.tryPromise({ try: () => Bun.readableStreamToText(child.stderr), catch: failed }),
      Effect.tryPromise({ try: () => child.exited, catch: failed }),
    ],
    { concurrency: 3 },
  )
  return { code, out: `${stdout}${stderr}` }
})


const quint = (args: ReadonlyArray<string>) => run([QUINT, ...args], HERE)

/** `quint run` of `model` with `step`, its traces written to `dir`: whether `pipeline` held or broke, each witness's count, and the output. */
const simulate = (model: string, step: string, dir: string) =>
  quint([
    "run",
    model,
    "--invariant=pipeline",
    `--step=${step}`,
    `--max-samples=${SAMPLES}`,
    `--max-steps=${STEPS}`,
    `--seed=${SEED}`,
    `--n-threads=${THREADS}`,
    `--n-traces=${TRACES}`,
    `--out-itf=${path.join(dir, "t{seq}.itf.json")}`,
    "--witnesses",
    ...WITNESSES,
  ]).pipe(
    Effect.map((ran) => ({
      held: ran.out.includes("[ok] No violation found"),
      broke: ran.out.includes("[violation]"),
      witnessed: Arr.map(WITNESSES, (name) => ({ name, count: Number(Option.getOrElse(Option.fromNullishOr(new RegExp(`${name} was witnessed in (\\d+) trace`).exec(ran.out)?.[1]), () => "0")) })),
      out: ran.out,
    })),
  )

/** A trace file's steps. */
const readTrace = (file: string) =>
  Effect.try({ try: () => readFileSync(file, "utf8"), catch: () => new Stop({ code: 2, lines: [`cannot read ${file}`] }) }).pipe(
    Effect.flatMap((text) => Effect.mapError(decodeTrace(text), (failure) => new Stop({ code: 2, lines: [`${file}: ${failure.why}`] }))),
  )

/** The traces written to `dir`, in order, with their paths. */
const tracesIn = (dir: string) => {
  const names = Arr.filter(readdirSync(dir), (name) => name.endsWith(".itf.json"))
  const byNumber = Order.mapInput(Order.Number, (name: string) => Number(Option.getOrElse(Option.fromNullishOr(/\d+/.exec(name)?.[0]), () => "0")))
  return Effect.forEach(Arr.sort(names, byNumber), (name) => Effect.map(readTrace(path.join(dir, name)), (steps) => ({ file: path.join(dir, name), steps })))
}

/** The covered files changed since the sync commit. */
const drifted = run(["git", "diff", "--name-only", `${SYNC}..HEAD`, "--", ...COVERED], path.join(ROOT, "..")).pipe(
  Effect.map((ran) =>
    pick(
      ran.code === 0,
      () => Arr.filter(ran.out.split("\n"), (line) => line !== ""),
      () => [`(git diff against ${SYNC} failed: is the sync commit in this clone?)`],
    ),
  ),
)

/** How the real machine.ts takes a trace that broke the rule: the same, or where it parts. */
const verdictOnCode = (steps: ReadonlyArray<Step>) =>
  Effect.map(replay(Real, steps), (parted) =>
    Option.match(parted, {
      onNone: () => "machine.ts decides and folds every step of it as the model does: the break is the code's.",
      onSome: (at) => `machine.ts parts from the model at step ${at.step} (${at.what}): fix the model first.`,
    }),
  )

/** A break: the shortest breaking trace's story, then red. */
const tellBreak = Effect.fn("Formal.tellBreak")(function* (dir: string, heading: string, rerun: string) {
  const traces = yield* tracesIn(dir)
  const broken = Arr.head(Arr.sort(Arr.filter(traces, (trace) => !Option.getOrElse(Option.map(Arr.last(trace.steps), (last) => last.ok), () => true)), Order.mapInput(Order.Number, (trace: { readonly steps: ReadonlyArray<Step> }) => trace.steps.length)))
  if (Option.isNone(broken)) return yield* red(heading, "(no breaking trace was written)")
  const code = yield* verdictOnCode(broken.value.steps)
  return yield* red(heading, ...Arr.map(storyOf(broken.value.steps), (line) => `  ${line}`), `  (trace: ${broken.value.file}; ${rerun})`, `  ${code}`)
})

/** The run of the model and the replay of its traces through machine.ts; the traces, for the mutants. */
const runAndReplay = Effect.fn("Formal.runAndReplay")(function* (scratch: string) {
  const dir = path.join(scratch, "run")
  mkdirSync(dir)
  const ran = yield* simulate(MODEL, STEP, dir)
  if (ran.broke) return yield* tellBreak(dir, "RED: the pipeline rule breaks. The shortest breaking walk the run wrote, in the code's words:", `the rerun: bun formal/check.ts --step ${STEP} --seed ${SEED}`)
  if (!ran.held) return yield* new Stop({ code: 2, lines: [ran.out] })
  yield* Console.log(`quint run (${STEP}, ${SAMPLES} walks of ${STEPS} steps, seed ${SEED}): pipeline holds`)
  yield* Console.log(`  witnesses: ${Arr.map(ran.witnessed, (each) => `${each.name} ${each.count}`).join(", ")}`)
  const unreached = Arr.map(Arr.filter(ran.witnessed, (each) => each.count === 0), (each) => each.name)
  if (unreached.length > 0) return yield* red(`RED: the walks never reached ${unreached.join(", ")}: the pass is vacuous there. Raise --samples or --steps.`)
  const traces = yield* tracesIn(dir)
  for (const trace of traces) {
    const parted = yield* replay(Real, trace.steps)
    if (Option.isSome(parted))
      return yield* red(
        `RED: machine.ts parts from the model in ${trace.file} at step ${parted.value.step}: ${parted.value.what}`,
        ...Arr.map(storyOf(Arr.take(trace.steps, parted.value.step + 1)), (line) => `  ${line}`),
      )
  }
  const steps = Arr.reduce(traces, 0, (sum, trace) => sum + trace.steps.length - 1)
  yield* Console.log(`replay: machine.ts decides and folds all ${steps} steps of ${traces.length} traces as the model does`)
  return traces
})

/** `quint verify` (Apalache) to --depth; a break is told as its trace's story. */
const deep = Effect.fn("Formal.deep")(function* () {
  const verified = yield* quint(["verify", MODEL, "--invariant=pipeline", `--step=${STEP}`, `--max-steps=${DEPTH}`])
  if (verified.out.includes("[ok]")) return yield* Console.log(`quint verify (Apalache): pipeline holds in every run of up to ${DEPTH} steps`)
  const itf = Option.fromNullishOr(/(\S+violation\d*\.itf\.json)/.exec(verified.out)?.[1])
  if (Option.isNone(itf)) return yield* red(`RED: quint verify (Apalache, ${DEPTH} steps):`, Arr.takeRight(verified.out.split("\n"), 60).join("\n"))
  const steps = yield* readTrace(itf.value)
  const code = yield* verdictOnCode(steps)
  return yield* red(
    `RED: quint verify (Apalache, ${DEPTH} steps): the pipeline rule breaks. Its shortest breaking walk, in the code's words:`,
    ...Arr.map(storyOf(steps), (line) => `  ${line}`),
    `  (trace: ${itf.value}) ${code}`,
  )
})

/** Loads a mutant of machine.ts by its path. */
const loadMutant = (file: string): Promise<Machine> => import(file)

/** A scratch copy of machine.ts with `mutant`'s break, imported from `dir`; none when its text is gone. */
const codeMutant = (mutant: Mutant, dir: string) => {
  const source = readFileSync(CODE, "utf8")
  if (!source.includes(mutant.code[0])) return Effect.succeed(Option.none<Machine>())
  const file = path.join(dir, `machine.${mutant.name}.ts`)
  writeFileSync(file, source.replaceAll('from "./', `from "${path.dirname(CODE)}/`).replace(mutant.code[0], mutant.code[1]))
  return Effect.tryPromise({ try: () => loadMutant(file), catch: () => new Stop({ code: 2, lines: [`cannot import ${file}`] }) }).pipe(Effect.map(Option.some))
}

/** Whether the model with `mutant`'s break breaks `pipeline`; none when its text is gone. */
const modelMutant = Effect.fn("Formal.modelMutant")(function* (mutant: Mutant, scratch: string) {
  const model = readFileSync(MODEL, "utf8")
  if (!model.includes(mutant.model[0])) return Option.none<boolean>()
  const file = path.join(scratch, `machine.${mutant.name}.qnt`)
  writeFileSync(file, model.replace(mutant.model[0], mutant.model[1]))
  const dir = path.join(scratch, mutant.name)
  mkdirSync(dir)
  return Option.some((yield* simulate(file, STEP, dir)).broke)
})

const word = (caught: Option.Option<boolean>) => Option.match(caught, { onNone: () => "its text is gone: update MUTANTS", onSome: (yes) => pick(yes, () => "caught", () => "MISSED") })

/** Each mutant must be caught twice: by the replay of `traces` and by the model. */
const mutants = Effect.fn("Formal.mutants")(function* (traces: ReadonlyArray<{ readonly steps: ReadonlyArray<Step> }>, scratch: string, dir: string) {
  mkdirSync(dir, { recursive: true })
  const missed: Array<string> = []
  for (const mutant of MUTANTS) {
    const real = yield* codeMutant(mutant, dir)
    const byReplay = yield* Effect.forEach(Option.toArray(real), (machine) => Effect.map(Effect.forEach(traces, (trace) => replay(machine, trace.steps)), (parts) => Arr.some(parts, Option.isSome)))
    const replayCaught = Arr.head(byReplay)
    const modelCaught = yield* modelMutant(mutant, scratch)
    yield* Console.log(`mutant ${mutant.name} (${mutant.why}): replay ${word(replayCaught)}; model ${word(modelCaught)}`)
    if (!Option.getOrElse(replayCaught, () => false) || !Option.getOrElse(modelCaught, () => false)) missed.push(mutant.name)
  }
  if (missed.length > 0) return yield* red(`RED: the check did not catch ${missed.join(", ")}`)
})

// The run's traces go to a scratch dir, kept when the check is red (its message names the trace) and removed when green.
const scratch = mkdtempSync(path.join(tmpdir(), "formal-"))
// Mutants of machine.ts must resolve `effect` from this workspace: they go under formal/, git-ignored, and always go.
const mutantDir = path.join(HERE, ".mutants")

const main = Effect.gen(function* () {
  const checked = yield* quint(["typecheck", MODEL])
  if (checked.code !== 0) return yield* new Stop({ code: 2, lines: [checked.out] })
  const changed = yield* drifted
  if (changed.length > 0) yield* Console.log(`note: covered code changed since sync ${SYNC}: ${changed.join(", ")}. Read the diff against the model before trusting a pass.`)
  const traces = yield* runAndReplay(scratch)
  if (flag("--deep")) yield* deep()
  if (flag("--mutants")) yield* mutants(traces, scratch, mutantDir)
  yield* Console.log("green")
  return 0
}).pipe(
  Effect.catchTag("Stop", (stop) => Effect.as(Console.log(stop.lines.join("\n")), stop.code)),
  Effect.ensuring(Effect.sync(() => rmSync(mutantDir, { recursive: true, force: true }))),
)

void Effect.runPromise(main).then((code) => {
  if (code === 0) rmSync(scratch, { recursive: true, force: true })
  process.exit(code)
})
