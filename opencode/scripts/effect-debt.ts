/**
 * `bun scripts/effect-debt.ts`: the ratchet over oxlint-plugin-effect's recommended rules.
 *
 * `.oxlintrc.json` holds the rules the workspace already keeps as hard errors. Every other
 * recommended rule is debt: `.oxlintrc.effect-debt.json` runs the pinned preset over every
 * source file git tracks or would track, and `effect-debt.json` holds a budget per exact file
 * and rule. `--check` fails unless each count equals its own budget (a missing budget is
 * zero), so new debt fails and removed debt must be taken out of the policy in the same
 * change. A failed oxlint run, a parse error, a missing file, an unknown rule or a drifted
 * plugin, preset, ignore list or test classification fails it as well; it never passes on
 * an empty scan.
 *
 * Modes: no flag prints counts per rule and area; `--check` enforces; `--counts` prints the
 * per-file counts as JSON; `--measure` prints the unmodified preset's counts (no test
 * classification, no host exemptions); `--tighten` lowers budgets to the current counts and
 * never raises one; `--bootstrap` writes the first policy, only when none exists, with
 * budgets for files tracked at HEAD. `--root`, `--oxlint` and `--timeout-ms` point it at
 * another workspace, linter or deadline.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Array as Arr, Console, Data, Effect, Exit, Option, Order, Schema } from "effect"
import { parseSync } from "oxc-parser"

/** The policy, the enforcing inventory config and the hard config, relative to the root. */
export const POLICY = "effect-debt.json"
export const DEBT_CONFIG = ".oxlintrc.effect-debt.json"
export const HARD_CONFIG = ".oxlintrc.json"
const PLUGIN = "oxlint-plugin-effect"

/**
 * The plugin is a dev dependency of the `lint` workspace, never of the root: its `effect` peer
 * (>=4.1) resolves to the lint workspace's own `effect`, so the runtime's `effect` (the root's,
 * which opencode-drive and the OpenCode SDK are built against) does not move with it.
 */
export const LINT_MANIFEST = "lint/package.json"
const LINT_MODULES = "lint/node_modules"
export const PLUGIN_ENTRY = `./${LINT_MODULES}/${PLUGIN}/dist/plugin.js`
const PRESET = `${LINT_MODULES}/${PLUGIN}/presets/recommended.json`
const MEASURE_CONFIG = "node_modules/.cache/effect-debt/measure.json"

/** The pseudo-rule counting lint suppression directives per file, so a new one cannot hide debt. */
export const SUPPRESSION = "directive/suppression"

/** Rules a host contract may switch off for one exact file; anything else stays budgeted. */
export const EXEMPTABLE = ["effect/noGlobals", "effect/noNodeBuiltinImport", "effect/noAsyncFunction", "effect/noEffectRunInTests"]

const SOURCE = /\.(?:[cm]?[jt]sx?)$/u
const DIRECTIVE = /^\s*(?:oxlint|eslint)-disable/u
const GLOB = /[*?[\]{}!]/u

/** Per exact file, per rule: a count of diagnostics or a budget. */
export type Counts = ReadonlyMap<string, ReadonlyMap<string, number>>

/** One (file, rule) whose count differs from its budget. */
export interface Breach {
  readonly file: string
  readonly rule: string
  readonly budget: number
  readonly count: number
}

/** What a comparison found: each differing (file, rule), and each rule nobody knows. */
export interface Verdict {
  readonly breaches: ReadonlyArray<Breach>
  readonly unknownRules: ReadonlyArray<string>
}

/** A failure of the ratchet itself or of the policy: each line names one problem. */
export class DebtError extends Data.TaggedError("DebtError")<{ readonly problems: ReadonlyArray<string> }> {}

const fail = (...problems: ReadonlyArray<string>) => Effect.fail(new DebtError({ problems }))

const countOf = (counts: Counts, file: string, rule: string) =>
  Option.getOrElse(Option.fromUndefinedOr(counts.get(file)?.get(rule)), () => 0)

const pairs = (counts: Counts) => Arr.flatMap(Array.from(counts), ([file, rules]) => Array.from(rules.keys(), (rule) => `${file}\u0000${rule}`))

const splitPair = (pair: string) => {
  const [file = "", rule = ""] = pair.split("\u0000")
  return { file, rule }
}

/**
 * Each (file, rule) of either side whose count is not exactly its own budget. A budget that
 * is absent is zero; one file's or rule's headroom never covers another's; a budget above
 * its count is a breach too, so removed debt is taken out of the policy, never re-spent.
 */
export const compare = (budgets: Counts, current: Counts, known: ReadonlySet<string>): Verdict => {
  const keys = Arr.sort(Arr.dedupe([...pairs(budgets), ...pairs(current)]), Order.String)
  const breaches = Arr.flatMap(keys, (pair) => {
    const { file, rule } = splitPair(pair)
    const budget = countOf(budgets, file, rule)
    const count = countOf(current, file, rule)
    const listed = budgets.get(file)?.has(rule) ?? false
    if (budget === count && (budget > 0 || !listed)) return []
    return [{ file, rule, budget, count }]
  })
  const unknownRules = Arr.sort(Arr.dedupe(Arr.filter(Arr.map(keys, (pair) => splitPair(pair).rule), (rule) => !known.has(rule))), Order.String)
  return { breaches, unknownRules }
}

/** The line `--check` prints for a breach. */
export const describeBreach = (breach: Breach) => {
  if (breach.count > breach.budget)
    return `over: ${breach.file} ${breach.rule} has ${breach.count}, budget ${breach.budget}; fix the new findings in ${breach.file} (a budget is never raised by hand; only the ratchet's own landing re-bootstraps one)`
  if (breach.budget === 0) return `zero budget: ${breach.file} ${breach.rule}; remove the entry, a missing budget is zero`
  return `lower: ${breach.file} ${breach.rule} has ${breach.count}, budget ${breach.budget}; lower it in ${POLICY} (bun scripts/effect-debt.ts --tighten)`
}

/** Budgets no higher than the current counts: each lowered to its count, an entry at zero dropped, none raised or added. */
export const tighten = (budgets: Counts, current: Counts): Counts =>
  new Map(
    Arr.flatMap(Array.from(budgets), ([file, rules]) => {
      const kept = Arr.flatMap(Array.from(rules), ([rule, budget]) => {
        const lowered = Math.min(budget, countOf(current, file, rule))
        if (lowered < 1) return []
        return [[rule, lowered] as const]
      })
      if (kept.length === 0) return []
      return [[file, new Map(kept)] as const]
    }),
  )

/** A diagnostic code as a rule id: `effect(noAs)` is `effect/noAs`, `eslint(complexity)` is `complexity`. */
export const ruleOf = (code: string) => {
  const effect = /^effect\((\w+)\)$/u.exec(code)
  if (effect) return `effect/${effect[1]}`
  const core = /^eslint\(([\w-]+)\)$/u.exec(code)
  if (core) return core[1] ?? code
  return code
}

/** The top-level area a file counts under: `mods/<name>`, `cmd/<name>`, its first folder, or `root`. */
export const areaOf = (file: string) => {
  const [first = "", second = ""] = file.split("/")
  if ((first === "mods" || first === "cmd") && file.split("/").length > 2) return `${first}/${second}`
  if (file.includes("/")) return first
  return "root"
}

const Severity = Schema.Literal("error")
const RuleSetting = Schema.Union([Severity, Schema.Tuple([Severity, Schema.Struct({ max: Schema.Int })])])
const Rules = Schema.Record(Schema.String, RuleSetting)
const Strings = Schema.Array(Schema.String)
const Settings = Schema.Struct({ effect: Schema.Struct({ testFiles: Strings }) })
const Override = Schema.Struct({ files: Strings, rules: Schema.Record(Schema.String, Schema.Literal("off")) })

const DebtConfig = Schema.Struct({
  $schema: Schema.optionalKey(Schema.String),
  plugins: Schema.Tuple([]),
  categories: Schema.Struct({ correctness: Schema.Literal("off") }),
  ignorePatterns: Strings,
  jsPlugins: Schema.Tuple([Schema.Literal(PLUGIN_ENTRY)]),
  settings: Settings,
  rules: Rules,
  overrides: Schema.optionalKey(Schema.Array(Override)),
})
const HardConfig = Schema.Struct({ ignorePatterns: Strings, settings: Settings })
const Preset = Schema.Struct({ plugins: Schema.Tuple([]), jsPlugins: Strings, rules: Rules })
const Manifest = Schema.Struct({
  devDependencies: Schema.Struct({ oxlint: Schema.String, [PLUGIN]: Schema.optionalKey(Schema.String) }),
  dependencies: Schema.optionalKey(Schema.Struct({ [PLUGIN]: Schema.optionalKey(Schema.String) })),
})
const LintManifest = Schema.Struct({ devDependencies: Schema.Struct({ effect: Schema.String, [PLUGIN]: Schema.String }) })
const Installed = Schema.Struct({ version: Schema.String })
const Exemption = Schema.Struct({ file: Schema.String, rule: Schema.String, reason: Schema.String })
const Budgets = Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Int))

/** `effect-debt.json`: the reviewed source policy. */
export const Policy = Schema.Struct({
  plugin: Schema.String,
  oxlint: Schema.String,
  provenance: Schema.String,
  rules: Strings,
  ignorePatterns: Strings,
  testFiles: Strings,
  exemptions: Schema.Array(Exemption),
  budgets: Budgets,
})
export type Policy = typeof Policy.Type

const Diagnostic = Schema.Struct({ code: Schema.optionalKey(Schema.String), message: Schema.String, filename: Schema.String })
const Report = Schema.Struct({ diagnostics: Schema.Array(Diagnostic), number_of_files: Schema.Int, number_of_rules: Schema.Int })
type Report = typeof Report.Type

/** Reviewed files of this tool's own (the policy, the enforcing config) refuse unknown keys; files others own are read for what they hold. */
type Excess = "error" | "ignore"

const decode =
  <S extends Schema.Codec<unknown, unknown>>(schema: S, label: string, excess: Excess) =>
  (text: string) =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text, { onExcessProperty: excess }).pipe(
      Effect.mapError((cause) => new DebtError({ problems: [`${label} is not valid: ${cause.message}`] })),
    )

const readText = (file: string) =>
  Effect.tryPromise({ try: () => Bun.file(file).text(), catch: () => new DebtError({ problems: [`cannot read ${file}`] }) })

const readJson = <S extends Schema.Codec<unknown, unknown>>(root: string, file: string, schema: S, excess: Excess) =>
  readText(path.join(root, file)).pipe(Effect.flatMap(decode(schema, file, excess)))

/** What one spawned command answered. */
export interface Answer {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

const killGroup = (pid: number) =>
  Effect.try({ try: () => process.kill(-pid, "SIGKILL"), catch: () => new DebtError({ problems: [`process group ${pid} already gone`] }) }).pipe(
    Effect.orElseSucceed(() => false),
  )

/** Runs `argv` in its own process group; a run past `timeoutMs` fails and its whole group is killed. */
export const spawn = Effect.fn("EffectDebt.spawn")(function* (argv: ReadonlyArray<string>, cwd: string, timeoutMs: number) {
  const command = argv.join(" ").slice(0, 200)
  return yield* Effect.acquireUseRelease(
    Effect.try({
      try: () => Bun.spawn([...argv], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true }),
      catch: () => new DebtError({ problems: [`cannot start ${command}`] }),
    }),
    (child) =>
      Effect.all(
        [
          Effect.tryPromise({ try: () => Bun.readableStreamToText(child.stdout), catch: () => new DebtError({ problems: [`cannot read ${command}`] }) }),
          Effect.tryPromise({ try: () => Bun.readableStreamToText(child.stderr), catch: () => new DebtError({ problems: [`cannot read ${command}`] }) }),
          Effect.tryPromise({ try: () => child.exited, catch: () => new DebtError({ problems: [`${command} did not exit`] }) }),
        ],
        { concurrency: 3 },
      ).pipe(
        Effect.map(([stdout, stderr, code]): Answer => ({ code, stdout, stderr })),
        Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => fail(`${command} timed out after ${timeoutMs} ms`) }),
      ),
    (child, exit) => Effect.when(killGroup(child.pid), Effect.sync(() => Exit.isFailure(exit))),
  )
})

const ignoredBy = (patterns: ReadonlyArray<string>) => {
  const globs = Arr.map(patterns, (pattern) => new Bun.Glob(pattern))
  return (file: string) => globs.some((glob) => glob.match(file))
}

/** Every source file git tracks or would track (untracked, not ignored), that exists and no ignore pattern excludes. */
const sourceFiles = Effect.fn("EffectDebt.sourceFiles")(function* (root: string, ignorePatterns: ReadonlyArray<string>, timeoutMs: number) {
  const listed = yield* spawn(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], root, timeoutMs)
  if (listed.code !== 0) return yield* fail(`git ls-files failed in ${root}: ${listed.stderr.trim()}`)
  const ignored = ignoredBy(ignorePatterns)
  const files = Arr.filter(listed.stdout.split("\u0000"), (file) => SOURCE.test(file) && !ignored(file) && existsSync(path.join(root, file)))
  return Arr.sort(Arr.dedupe(files), Order.String)
})

const trackedAtHead = Effect.fn("EffectDebt.trackedAtHead")(function* (root: string, timeoutMs: number) {
  const listed = yield* spawn(["git", "ls-tree", "-r", "-z", "--name-only", "HEAD"], root, timeoutMs)
  if (listed.code !== 0) return yield* fail(`git ls-tree failed in ${root}: ${listed.stderr.trim()}`)
  return new Set(listed.stdout.split("\u0000"))
})

const head = Effect.fn("EffectDebt.head")(function* (root: string, timeoutMs: number) {
  const answer = yield* spawn(["git", "rev-parse", "HEAD"], root, timeoutMs)
  if (answer.code !== 0) return yield* fail(`git rev-parse failed in ${root}: ${answer.stderr.trim()}`)
  return answer.stdout.trim()
})

/** What one scan needs: the workspace, the linter, its config and the number of rules it must load. */
export interface ScanInput {
  readonly root: string
  readonly oxlint: string
  readonly config: string
  readonly files: ReadonlyArray<string>
  readonly rules: number
  readonly timeoutMs: number
}

const reportProblems = (report: Report, input: ScanInput) => {
  const listed = new Set(input.files)
  const coverage = Arr.flatMap([report.number_of_files], (count) => {
    if (count === input.files.length) return []
    return [`oxlint linted ${count} files, expected ${input.files.length}: an ignore pattern or config hides source`]
  })
  const loaded = Arr.flatMap([report.number_of_rules], (count) => {
    if (count === input.rules) return []
    return [`oxlint loaded ${count} rules, expected ${input.rules}: the plugin or a rule did not load`]
  })
  const diagnostics = Arr.flatMap(report.diagnostics, (diagnostic) => {
    if ((diagnostic.code ?? "") === "") return [`${diagnostic.filename}: ${diagnostic.message} (a parse or config error)`]
    if (!listed.has(diagnostic.filename)) return [`${diagnostic.filename}: a diagnostic for a file outside the source list`]
    return []
  })
  return [...coverage, ...loaded, ...diagnostics]
}

/** One oxlint run over exactly `files`, parsed and checked; a failed, partial or unparsable run fails, never an empty scan. */
export const scan = Effect.fn("EffectDebt.scan")(function* (input: ScanInput) {
  if (input.files.length === 0) return yield* fail(`no source files under ${input.root}`)
  const argv = [input.oxlint, "--threads=3", "--disable-nested-config", "--format=json", "-c", input.config, ...input.files]
  const answer = yield* spawn(argv, input.root, input.timeoutMs)
  if (answer.code !== 0 && answer.code !== 1) return yield* fail(`oxlint exited ${answer.code}: ${`${answer.stderr}${answer.stdout}`.trim().slice(0, 2000)}`)
  const report = yield* decode(Report, "oxlint's JSON report", "ignore")(answer.stdout)
  const problems = reportProblems(report, input)
  if (problems.length > 0) return yield* fail(...problems)
  return report
})

const add = (counts: Map<string, Map<string, number>>, file: string, rule: string, by: number) => {
  const rules = Option.getOrElse(Option.fromUndefinedOr(counts.get(file)), () => new Map<string, number>())
  rules.set(rule, countOf(counts, file, rule) + by)
  counts.set(file, rules)
}

const suppressionsIn = (root: string, file: string) =>
  readText(path.join(root, file)).pipe(
    Effect.map((text) => Arr.filter(parseSync(file, text).comments, (comment) => DIRECTIVE.test(comment.value)).length),
  )

/** The counts of a scan: its diagnostics per file and rule, and each file's suppression directives. */
const countsOf = Effect.fn("EffectDebt.countsOf")(function* (root: string, files: ReadonlyArray<string>, report: Report) {
  const counts = new Map<string, Map<string, number>>()
  for (const diagnostic of report.diagnostics) add(counts, diagnostic.filename, ruleOf(diagnostic.code ?? ""), 1)
  const suppressions = yield* Effect.forEach(files, (file) => suppressionsIn(root, file), { concurrency: 16 })
  Arr.forEach(files, (file, index) => {
    const found = suppressions[index] ?? 0
    if (found > 0) add(counts, file, SUPPRESSION, found)
  })
  return counts
})

const unless = ([ok, problem]: readonly [boolean, string]) => {
  if (ok) return []
  return [problem]
}

const sorted = (values: Iterable<string>) => Arr.sort(Array.from(values), Order.String)
const same = (left: Iterable<string>, right: Iterable<string>) => JSON.stringify(Array.from(left)) === JSON.stringify(Array.from(right))
const sameSet = (left: Iterable<string>, right: Iterable<string>) => same(sorted(left), sorted(right))

/** Everything the policy is checked against. */
export interface Inputs {
  readonly policy: Policy
  readonly debt: typeof DebtConfig.Type
  readonly hard: typeof HardConfig.Type
  readonly preset: typeof Preset.Type
  readonly manifest: typeof Manifest.Type
  readonly lintManifest: typeof LintManifest.Type
  readonly plugin: string
  readonly pluginEffect: string
  readonly oxlint: string
}

const versionProblems = (inputs: Inputs) => {
  const plugin = [inputs.lintManifest.devDependencies[PLUGIN], inputs.plugin, inputs.policy.plugin]
  const effect = [inputs.lintManifest.devDependencies.effect, inputs.pluginEffect]
  const oxlint = [inputs.manifest.devDependencies.oxlint, inputs.oxlint, inputs.policy.oxlint]
  const rooted = [inputs.manifest.devDependencies[PLUGIN], inputs.manifest.dependencies?.[PLUGIN]]
  return [
    ...Arr.flatMap([plugin], (found) => {
      if (new Set(found).size === 1) return []
      return [`${PLUGIN} drifted: ${LINT_MANIFEST} pins ${found[0]}, installed ${found[1]}, policy ${found[2]}`]
    }),
    ...Arr.flatMap([effect], (found) => {
      if (new Set(found).size === 1) return []
      return [`the plugin's effect drifted: ${LINT_MANIFEST} pins ${found[0]}, ${LINT_MODULES}/effect is ${found[1]}`]
    }),
    ...Arr.flatMap(rooted, (pin) => {
      if ((pin ?? "") === "") return []
      return [`package.json depends on ${PLUGIN} ${pin}; it belongs to ${LINT_MANIFEST} alone, so its effect peer cannot move the runtime's effect`]
    }),
    ...Arr.flatMap([oxlint], (found) => {
      if (new Set(found).size === 1) return []
      return [`oxlint drifted: package.json pins ${found[0]}, installed ${found[1]}, policy ${found[2]}`]
    }),
  ]
}

const ruleProblems = (inputs: Inputs) => {
  const preset = Object.keys(inputs.preset.rules)
  const problems = Arr.flatMap(
    [
      [sameSet(preset, inputs.policy.rules), `the policy's rules differ from the installed preset's`],
      [sameSet(preset, Object.keys(inputs.debt.rules)), `${DEBT_CONFIG}'s rules differ from the installed preset's`],
      [same(inputs.preset.jsPlugins, [`${PLUGIN}/plugin`]), `the installed preset loads ${inputs.preset.jsPlugins.join(", ")}`],
    ] as const,
    unless,
  )
  const settings = Arr.flatMap(preset, (rule) => {
    if (JSON.stringify(inputs.debt.rules[rule]) === JSON.stringify(inputs.preset.rules[rule])) return []
    return [`${DEBT_CONFIG} sets ${rule} differently from the preset`]
  })
  return [...problems, ...settings]
}

const classificationProblems = (inputs: Inputs) =>
  Arr.flatMap(
    [
      [same(inputs.debt.ignorePatterns, inputs.policy.ignorePatterns), `${DEBT_CONFIG}'s ignorePatterns differ from the policy's`],
      [same(inputs.hard.ignorePatterns, inputs.policy.ignorePatterns), `${HARD_CONFIG}'s ignorePatterns differ from the policy's`],
      [same(inputs.debt.settings.effect.testFiles, inputs.policy.testFiles), `${DEBT_CONFIG}'s effect.testFiles differ from the policy's`],
      [same(inputs.hard.settings.effect.testFiles, inputs.policy.testFiles), `${HARD_CONFIG}'s effect.testFiles differ from the policy's`],
    ] as const,
    unless,
  )

/** The (file, rule) pairs the enforcing config switches off, with a problem for each override that is not one exact file and an exemptable rule. */
export const overridePairs = (overrides: ReadonlyArray<typeof Override.Type>) => {
  const found = Arr.flatMap(overrides, (override) =>
    Arr.flatMap(override.files, (file) => Arr.map(Object.keys(override.rules), (rule) => ({ file, rule }))),
  )
  const problems = Arr.flatMap(found, ({ file, rule }) => {
    if (GLOB.test(file)) return [`${DEBT_CONFIG} exempts a glob, ${file}; exemptions name exact files`]
    if (!EXEMPTABLE.includes(rule)) return [`${DEBT_CONFIG} exempts ${rule} in ${file}; only ${EXEMPTABLE.join(", ")} can be exempted`]
    return []
  })
  return { pairs: Arr.map(found, ({ file, rule }) => `${file} ${rule}`), problems }
}

const exemptionProblems = (inputs: Inputs) => {
  const overrides = overridePairs(inputs.debt.overrides ?? [])
  const listed = Arr.map(inputs.policy.exemptions, ({ file, rule }) => `${file} ${rule}`)
  const reasons = Arr.flatMap(inputs.policy.exemptions, ({ file, rule, reason }) => {
    if (reason.trim().length > 0) return []
    return [`the exemption of ${rule} in ${file} has no reason`]
  })
  const matched = Arr.flatMap([sameSet(overrides.pairs, listed)], (ok) => {
    if (ok) return []
    return [`${DEBT_CONFIG}'s overrides (${overrides.pairs.join("; ")}) differ from the policy's exemptions (${listed.join("; ")})`]
  })
  return [...overrides.problems, ...reasons, ...matched]
}

const budgetProblems = (policy: Policy) => {
  const known = knownRules(policy)
  return Arr.flatMap(Object.entries(policy.budgets), ([file, rules]) =>
    Arr.flatMap(Object.entries(rules), ([rule, budget]) => {
      if (!known.has(rule)) return [`unknown rule ${rule}: budgeted in ${file}, not in the pinned preset`]
      if (budget > 0) return []
      return [`the budget of ${rule} in ${file} is ${budget}; budgets are positive, a missing one is zero`]
    }),
  )
}

/** Every problem with the policy, the configs and the installed versions; none means the scan can be trusted. */
export const policyProblems = (inputs: Inputs) => [
  ...versionProblems(inputs),
  ...ruleProblems(inputs),
  ...classificationProblems(inputs),
  ...exemptionProblems(inputs),
  ...budgetProblems(inputs.policy),
]

/** A policy's budgets as counts. */
export const budgetsOf = (policy: Policy): Counts =>
  new Map(Arr.map(Object.entries(policy.budgets), ([file, rules]) => [file, new Map(Object.entries(rules))] as const))

/** The rules a policy knows: the preset's, and the suppression count. */
export const knownRules = (policy: Policy) => new Set([...policy.rules, SUPPRESSION])

const versionOf = (root: string, modules: string, name: string) =>
  readJson(root, path.join(modules, name, "package.json"), Installed, "ignore").pipe(Effect.map((installed) => installed.version))

/** What a workspace has installed and configured: everything `Inputs` holds but the policy. */
export const readInstalled = (root: string) =>
  Effect.all({
    debt: readJson(root, DEBT_CONFIG, DebtConfig, "error"),
    hard: readJson(root, HARD_CONFIG, HardConfig, "ignore"),
    preset: readJson(root, PRESET, Preset, "ignore"),
    manifest: readJson(root, "package.json", Manifest, "ignore"),
    lintManifest: readJson(root, LINT_MANIFEST, LintManifest, "ignore"),
    plugin: versionOf(root, LINT_MODULES, PLUGIN),
    pluginEffect: versionOf(root, LINT_MODULES, "effect"),
    oxlint: versionOf(root, "node_modules", "oxlint"),
  })

/** The command line: one mode and the workspace it runs over. */
export interface Options {
  readonly mode: "report" | "check" | "counts" | "measure" | "tighten" | "bootstrap"
  readonly root: string
  readonly oxlint: string
  readonly timeoutMs: number
}

const MODES = ["check", "counts", "measure", "tighten", "bootstrap"] as const
const VALUED = ["--root", "--oxlint", "--timeout-ms"]
const USAGE = "usage: bun scripts/effect-debt.ts [--check|--counts|--measure|--tighten|--bootstrap] [--root dir] [--oxlint bin] [--timeout-ms n]"

const valueOf = (argv: ReadonlyArray<string>, flag: string) => {
  const index = argv.indexOf(flag)
  if (index < 0) return Option.none<string>()
  return Arr.get(argv, index + 1)
}

/** Parses the command line; an unknown flag, a flag without its value or two modes fail. */
export const parseOptions = (argv: ReadonlyArray<string>, cwd: string): Effect.Effect<Options, DebtError> => {
  const modes = Arr.filter(MODES, (mode) => argv.includes(`--${mode}`))
  const known = new Set([...Arr.map(MODES, (mode) => `--${mode}`), ...VALUED])
  const values = new Set(Arr.flatMap(VALUED, (flag) => Option.toArray(valueOf(argv, flag))))
  const unknown = Arr.filter(argv, (arg) => !known.has(arg) && !values.has(arg))
  const missing = Arr.filter(VALUED, (flag) => argv.includes(flag) && Option.isNone(valueOf(argv, flag)))
  const timeoutMs = Number(Option.getOrElse(valueOf(argv, "--timeout-ms"), () => "120000"))
  if (unknown.length + missing.length > 0 || modes.length > 1 || !(timeoutMs > 0)) return fail(`${USAGE}; got ${argv.join(" ")}`)
  const root = path.resolve(cwd, Option.getOrElse(valueOf(argv, "--root"), () => "."))
  const options: Options = {
    mode: Option.getOrElse(Arr.head(modes), () => "report" as const),
    root,
    oxlint: Option.getOrElse(valueOf(argv, "--oxlint"), () => path.join(root, "node_modules/.bin/oxlint")),
    timeoutMs,
  }
  return Effect.succeed(options)
}

/** A scan of the enforcing config over the workspace's sources, after the policy and configs check out. */
const inventory = Effect.fn("EffectDebt.inventory")(function* (options: Options) {
  const policy = yield* readJson(options.root, POLICY, Policy, "error")
  const inputs: Inputs = { policy, ...(yield* readInstalled(options.root)) }
  const problems = policyProblems(inputs)
  if (problems.length > 0) return yield* fail(...problems)
  const files = yield* sourceFiles(options.root, policy.ignorePatterns, options.timeoutMs)
  const listed = new Set(files)
  const missing = Arr.filter(policy.exemptions, ({ file }) => !listed.has(file))
  if (missing.length > 0) return yield* fail(...Arr.map(missing, ({ file, rule }) => `the policy exempts ${rule} in ${file}, which is not a source file`))
  const config = path.join(options.root, DEBT_CONFIG)
  const report = yield* scan({ root: options.root, oxlint: options.oxlint, config, files, rules: policy.rules.length, timeoutMs: options.timeoutMs })
  const counts: Counts = yield* countsOf(options.root, files, report)
  return { policy, files, counts }
})

const total = (counts: Counts) => Arr.reduce(Array.from(counts.values()), 0, (sum, rules) => sum + Arr.reduce(Array.from(rules.values()), 0, (inner, count) => inner + count))

const tally = (counts: Counts, keyOf: (file: string, rule: string) => string) => {
  const sums = new Map<string, number>()
  for (const [file, rules] of counts) for (const [rule, count] of rules) sums.set(keyOf(file, rule), (sums.get(keyOf(file, rule)) ?? 0) + count)
  const byCount = Order.mapInput(Order.flip(Order.Number), ([, count]: readonly [string, number]) => count)
  return Arr.sort(Array.from(sums), Order.combine(byCount, Order.mapInput(Order.String, ([key]: readonly [string, number]) => key)))
}

/** Counts per rule, then per area: the report a person reads. */
export const table = (counts: Counts) => {
  const rows = (entries: ReadonlyArray<readonly [string, number]>) => Arr.map(entries, ([key, count]) => `  ${String(count).padStart(6)}  ${key}`)
  return [
    `${total(counts)} diagnostics in ${counts.size} files`,
    "by rule:",
    ...rows(tally(counts, (_file, rule) => rule)),
    "by area:",
    ...rows(tally(counts, (file) => areaOf(file))),
  ].join("\n")
}

/** Counts as plain JSON, files and rules sorted. */
export const countsJson = (counts: Counts) =>
  Object.fromEntries(Arr.map(sorted(counts.keys()), (file) => [file, Object.fromEntries(Arr.map(sorted(counts.get(file)?.keys() ?? []), (rule) => [rule, countOf(counts, file, rule)]))]))

const block = (open: string, close: string, lines: ReadonlyArray<string>) => {
  if (lines.length === 0) return `${open}${close}`
  return `${open}\n${Arr.map(lines, (line) => `    ${line}`).join(",\n")}\n  ${close}`
}

/** The policy as reviewed source: one budget line per file, every list sorted where order carries no meaning. */
export const serialize = (policy: Policy) => {
  const budgets = budgetsOf(policy)
  const fields = [
    `"plugin": ${JSON.stringify(policy.plugin)}`,
    `"oxlint": ${JSON.stringify(policy.oxlint)}`,
    `"provenance": ${JSON.stringify(policy.provenance)}`,
    `"rules": ${block("[", "]", Arr.map(sorted(policy.rules), (rule) => JSON.stringify(rule)))}`,
    `"ignorePatterns": ${block("[", "]", Arr.map(policy.ignorePatterns, (pattern) => JSON.stringify(pattern)))}`,
    `"testFiles": ${block("[", "]", Arr.map(policy.testFiles, (glob) => JSON.stringify(glob)))}`,
    `"exemptions": ${block("[", "]", Arr.map(policy.exemptions, (exemption) => JSON.stringify(exemption)))}`,
    `"budgets": ${block("{", "}", Arr.map(sorted(budgets.keys()), (file) => `${JSON.stringify(file)}: ${JSON.stringify(countsJson(budgets)[file])}`))}`,
  ]
  return `{\n${Arr.map(fields, (field) => `  ${field}`).join(",\n")}\n}\n`
}

const writePolicy = (root: string, policy: Policy) =>
  Effect.try({ try: () => writeFileSync(path.join(root, POLICY), serialize(policy)), catch: () => new DebtError({ problems: [`cannot write ${POLICY}`] }) })

const withBudgets = (policy: Policy, budgets: Counts): Policy => ({ ...policy, budgets: countsJson(budgets) })

const verdictProblems = (verdict: Verdict) => [
  ...Arr.map(verdict.unknownRules, (rule) => `unknown rule ${rule}: not in the pinned preset`),
  ...Arr.map(verdict.breaches, describeBreach),
]

const check = Effect.fn("EffectDebt.check")(function* (options: Options) {
  const { policy, files, counts } = yield* inventory(options)
  const problems = verdictProblems(compare(budgetsOf(policy), counts, knownRules(policy)))
  if (problems.length > 0) return yield* fail(...problems, `${problems.length} problems against ${POLICY}`)
  yield* Console.log(`effect-debt: ${total(counts)} diagnostics in ${files.length} source files, each (file, rule) at its budget in ${POLICY}`)
})

const report = Effect.fn("EffectDebt.report")(function* (options: Options) {
  const { counts } = yield* inventory(options)
  yield* Console.log(table(counts))
})

const counts = Effect.fn("EffectDebt.counts")(function* (options: Options) {
  const found = yield* inventory(options)
  yield* Console.log(JSON.stringify(countsJson(found.counts)))
})

const tightenPolicy = Effect.fn("EffectDebt.tightenPolicy")(function* (options: Options) {
  const found = yield* inventory(options)
  const lowered = tighten(budgetsOf(found.policy), found.counts)
  yield* writePolicy(options.root, withBudgets(found.policy, lowered))
  const over = Arr.filter(compare(lowered, found.counts, knownRules(found.policy)).breaches, (breach) => breach.count > breach.budget)
  if (over.length > 0) return yield* fail(...Arr.map(over, describeBreach), `${POLICY} lowered; ${over.length} counts are still over budget`)
  yield* Console.log(`effect-debt: ${POLICY} lowered to the current counts (${total(lowered)} budgeted diagnostics)`)
})

const measure = Effect.fn("EffectDebt.measure")(function* (options: Options) {
  const installed = yield* readInstalled(options.root)
  const config = path.join(options.root, MEASURE_CONFIG)
  const raw = { plugins: [], categories: { correctness: "off" }, jsPlugins: [path.join(options.root, PLUGIN_ENTRY)], rules: installed.preset.rules }
  yield* Effect.try({
    try: () => {
      mkdirSync(path.dirname(config), { recursive: true })
      writeFileSync(config, JSON.stringify(raw))
    },
    catch: () => new DebtError({ problems: [`cannot write ${config}`] }),
  })
  const files = yield* sourceFiles(options.root, installed.hard.ignorePatterns, options.timeoutMs)
  const found = yield* scan({ root: options.root, oxlint: options.oxlint, config, files, rules: Object.keys(installed.preset.rules).length, timeoutMs: options.timeoutMs })
  yield* Console.log(`unmodified ${PLUGIN} ${installed.plugin} recommended preset, no test classification or exemptions:\n${table(yield* countsOf(options.root, files, found))}`)
})

const bootstrap = Effect.fn("EffectDebt.bootstrap")(function* (options: Options) {
  if (existsSync(path.join(options.root, POLICY))) return yield* fail(`${POLICY} exists; lower budgets with --tighten, never regenerate them`)
  const installed = yield* readInstalled(options.root)
  const files = yield* sourceFiles(options.root, installed.debt.ignorePatterns, options.timeoutMs)
  const config = path.join(options.root, DEBT_CONFIG)
  const found = yield* scan({ root: options.root, oxlint: options.oxlint, config, files, rules: Object.keys(installed.preset.rules).length, timeoutMs: options.timeoutMs })
  const all = yield* countsOf(options.root, files, found)
  const tracked = yield* trackedAtHead(options.root, options.timeoutMs)
  const commit = yield* head(options.root, options.timeoutMs)
  const budgets: Counts = new Map(Arr.filter(Array.from(all), ([file]) => tracked.has(file)))
  const policy: Policy = {
    plugin: installed.plugin,
    oxlint: installed.oxlint,
    provenance: `bun scripts/effect-debt.ts --bootstrap at ${commit}: ${DEBT_CONFIG} over ${files.length} source files with ${PLUGIN} ${installed.plugin} and oxlint ${installed.oxlint}; budgets only for files tracked at that commit`,
    rules: sorted(Object.keys(installed.preset.rules)),
    ignorePatterns: installed.debt.ignorePatterns,
    testFiles: installed.debt.settings.effect.testFiles,
    exemptions: Arr.map(overridePairs(installed.debt.overrides ?? []).pairs, (pair) => {
      const [file = "", rule = ""] = pair.split(" ")
      return { file, rule, reason: "" }
    }),
    budgets: countsJson(budgets),
  }
  yield* writePolicy(options.root, policy)
  yield* Console.log(`effect-debt: wrote ${POLICY} (${total(budgets)} budgeted diagnostics); give each exemption its reason`)
})

const MODE_RUNS = {
  report,
  check,
  counts,
  measure,
  tighten: tightenPolicy,
  bootstrap,
} satisfies { readonly [Mode in Options["mode"]]: (options: Options) => Effect.Effect<void, DebtError> }

/** The whole command: a failure prints its problems and sets exit code 1. */
export const main = (argv: ReadonlyArray<string>, cwd: string) =>
  parseOptions(argv, cwd).pipe(
    Effect.flatMap((options) => MODE_RUNS[options.mode](options)),
    Effect.catchTag("DebtError", (error) =>
      Console.error(Arr.map(error.problems, (problem) => `effect-debt: ${problem}`).join("\n")).pipe(
        Effect.andThen(
          Effect.sync(() => {
            process.exitCode = 1
          }),
        ),
      ),
    ),
  )

if (import.meta.main) void Effect.runPromise(main(process.argv.slice(2), process.cwd()))
