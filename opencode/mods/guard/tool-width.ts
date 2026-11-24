import { Option, Predicate } from "effect"
import { widthOf, type Width } from "./admission-wire.ts"
import type { CommandEnvironment } from "./command-line.ts"

export type ToolWidth = Width | "invalid"
type ToolEnvironment = CommandEnvironment
const numeric = (n: number): Width => Option.getOrElse(widthOf(n), () => "full" as const)
export const serial = numeric(1)
export const readWidth = (value: string): ToolWidth => {
  if (/^\+?\d+$/u.test(value) && Number(value) > 0) return numeric(Number(value))
  if (/^[+-]?\d+$/u.test(value)) return "invalid"
  return "unknown"
}
export const joinWidth = (a: ToolWidth, b: ToolWidth): ToolWidth => {
  if (a === "invalid" || b === "invalid") return "invalid"
  if (a === "unknown" || b === "unknown") return "unknown"
  if (a === "full" || b === "full") return "full"
  return numeric(Math.max(a, b))
}
const words = (text: string) => new Set(text.trim().split(/\s+/u))
type Grammar = {
  readonly values: ReadonlySet<string>
  readonly switches: ReadonlySet<string>
  readonly concurrency: ReadonlySet<string>
  readonly stop?: ReadonlySet<string>
  readonly attached?: string
  readonly equalsOnly?: boolean
  readonly implicit?: ToolWidth
  readonly zero?: ToolWidth
  readonly normalize?: (name: string) => string
  readonly read?: (value: string) => ToolWidth
}
const compactNumber = (name: string, grammar: Grammar) => Option.filter(
  Option.fromNullishOr(grammar.attached),
  (prefix) => name.startsWith(prefix) && name !== prefix,
).pipe(Option.map((prefix) => name.slice(prefix.length)))

const positionalNumber = (next: Option.Option<string>, grammar: Grammar) => Option.filter(next, (value) =>
  !grammar.equalsOnly && (/^[+-]?\d|^\$/u.test(value) || Predicate.isUndefined(grammar.implicit)))

const widthValue = (value: string, grammar: Grammar) => {
  if (grammar.zero && /^0+$/u.test(value)) return grammar.zero
  return (grammar.read ?? readWidth)(value)
}
const concurrencyOption = (spelling: string, recognized: boolean, attached: Option.Option<string>,
  following: Option.Option<string>, grammar: Grammar) => {
  if (Option.isSome(attached) && recognized) return { width: widthValue(attached.value, grammar), skip: 0 }
  if (!recognized) {
    const compact = compactNumber(spelling, grammar)
    if (Option.isNone(compact) || Option.isSome(attached)) return { width: "unknown" as const, skip: 0 }
    return { width: widthValue(compact.value, grammar), skip: 0 }
  }
  const next = positionalNumber(following, grammar)
  if (Option.isSome(next)) return { width: widthValue(next.value, grammar), skip: 1 }
  return { width: grammar.implicit ?? "unknown", skip: 0 }
}
// A documented option's operand cannot be mistaken for another option:
// e.g. `go test -run -p=1` leaves -p at its default.
const workers = (args: ReadonlyArray<string>, grammar: Grammar): ToolWidth => {
  let width = Option.none<ToolWidth>()
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? ""
    if (arg === "--" || grammar.stop?.has(arg)) break
    if (!arg.startsWith("-") || arg === "-") continue
    const [spelling = "", value] = arg.split(/=(.*)/su, 2)
    const attached = Option.fromNullishOr(value)
    const name = grammar.normalize?.(spelling) ?? spelling
    if (grammar.switches.has(name)) continue
    if (grammar.values.has(name)) {
      if (Option.isNone(attached)) i += 1
      continue
    }
    const option = concurrencyOption(spelling, grammar.concurrency.has(name), attached, Option.fromNullishOr(args[i + 1]), grammar)
    const explicit = option.width
    i += option.skip
    if (explicit === "invalid" || explicit === "unknown") return explicit
    // Multiple explicit settings can only raise this bound. No dependence
    // on a particular tool's duplicate-flag choice.
    width = Option.some(Option.match(width, { onNone: () => explicit, onSome: (earlier) => joinWidth(earlier, explicit) }))
  }
  return Option.getOrElse(width, () => "unknown" as const)
}

const goFlags: Grammar = {
  concurrency: words("-p"),
  values: words(`-C -covermode -coverpkg -asmflags -buildmode -compiler -gccgoflags -gcflags -installsuffix
    -ldflags -mod -modfile -overlay -pgo -pkgdir -tags -bench -benchtime -count -list -outputdir
    -parallel -cpu -run -shuffle -skip -timeout -vet -blockprofile -blockprofilerate -coverprofile
    -cpuprofile -memprofile -memprofilerate -mutexprofile -mutexprofilefraction -trace`),
  switches: words(`-a -n -race -msan -asan -cover -v -work -x -buildvcs -json -linkshared
    -modcacherw -trimpath -artifacts -failfast -fullpath -short -benchmem`),
  stop: words("-args --args"),
  normalize: (name) => name.replace(/^--/u, "-").replace(/^-test\.(?!p$)/u, "-"),
}
const explicitRuntime = (env: ToolEnvironment): ToolWidth => {
  const width = readWidth(env.GOMAXPROCS ?? "")
  if (width === "invalid") return "unknown" // Go ignores non-positive values.
  return width
}
const cpuList = (list: string): ToolWidth => {
  if (!/^[1-9]\d*(?:,[1-9]\d*)*$/u.test(list)) return "unknown"
  return numeric(list.split(",").reduce((max, value) => Math.max(max, Number(value)), 0))
}
const goRuntimeFlags: Grammar = {
  ...goFlags, values: new Set([...goFlags.values].filter((name) => name !== "-cpu").concat("-p")),
  concurrency: words("-cpu"), read: cpuList,
}
const multiply = (a: ToolWidth, b: ToolWidth): ToolWidth => {
  const joined = joinWidth(a, b)
  if (Predicate.isNumber(a) && Predicate.isNumber(b)) return numeric(a * b)
  return joined
}
const persistentFlagsOff = (env: ToolEnvironment) => env.GOENV === "off" && !env.GOFLAGS
const boundedGoMode = (env: ToolEnvironment) =>
  persistentFlagsOff(env) ||
  // A nonempty process GOFLAGS replaces persistent GOFLAGS. Admit only
  // the two overridden flags; do not parse an open-ended build mode.
  /^-(?:p=[1-9]\d*|cpu=[1-9]\d*(?:,[1-9]\d*)*)(?: +-(?:p=[1-9]\d*|cpu=[1-9]\d*(?:,[1-9]\d*)*))*$/u.test(env.GOFLAGS ?? "")
/** `go help environment`: explicit argv overrides GOFLAGS; GOENV=off
 * disables the persistent file. `go doc runtime.GOMAXPROCS`: explicit
 * process env sets startup width. `go help testflag`: -cpu changes test
 * GOMAXPROCS; -parallel does not. cmd/go/internal/test/testflag.go
 * suppresses a GOFLAGS test flag when the same flag is supplied in argv. */
const testRuntime = (args: ReadonlyArray<string>, env: ToolEnvironment, startup: ToolWidth) => {
  // With all persistent flags disabled there is no hidden -cpu. Otherwise
  // insist on the explicit test-binary width at a provable flag boundary.
  if (persistentFlagsOff(env) && !args.some((arg) => /^(?:--?cpu|-test\.cpu)(?:=|$)/u.test(arg)))
    return startup
  return workers(args, goRuntimeFlags)
}
export const goTestWidth = (args: ReadonlyArray<string>, env: ToolEnvironment): ToolWidth => {
  // Forwarded arguments can override earlier test flags at the test
  // binary, independently of cmd/go's own flag precedence.
  if (args.some((arg) => arg === "--" || goFlags.stop?.has(arg))) return "unknown"
  const startup = explicitRuntime(env)
  const width = multiply(workers(args, goFlags), joinWidth(startup, testRuntime(args, env, startup)))
  // GOFLAGS may also select a different execution mode (e.g. -fuzz,
  // where -parallel bounds processes and -cpu does not apply).
  if (width !== "invalid" && !boundedGoMode(env)) return "unknown"
  return width
}

const bunFlags: Grammar = {
  concurrency: words("--parallel"),
  equalsOnly: true,
  values: words(`--timeout --rerun-each --retry --seed --coverage-reporter --coverage-dir -t --test-name-pattern
    --reporter --reporter-outfile --max-concurrency --path-ignore-patterns --parallel-delay --shard --timings`),
  switches: words(`--no-orphans -u --update-snapshots --todo --only --pass-with-no-tests --concurrent --randomize
    --coverage --dots --only-failures --isolate --no-isolate --update-timings`),
}
/** `bun test --help`: only literal --parallel=N requests N worker processes.
 * Bun's bunfig configuration guide gives explicit CLI flags priority. */
export const bunTestWidth = (args: ReadonlyArray<string>): ToolWidth => workers(args, bunFlags)

const makeFlags: Grammar = {
  concurrency: words("-j --jobs"),
  attached: "-j",
  implicit: "full",
  values: words("-C --directory -f --file --makefile -I --include-dir -o --old-file --assume-old -W --what-if --new-file --assume-new"),
  switches: words(`-B --always-make -d -e --environment-overrides -h --help -i --ignore-errors -k --keep-going
    -L --check-symlink-times -n --just-print --dry-run --recon -p --print-data-base -q --question -r --no-builtin-rules
    -R --no-builtin-variables -s --silent --quiet -S --no-keep-going --stop -t --touch -v --version
    -w --print-directory --no-print-directory --warn-undefined-variables`),
}
/** GNU `make --help` / GNU Make manual “Parallel Execution”: -j [N] /
 * --jobs[=N], no value unlimited. GNU Make "Options/Recursion" documents
 * explicit command-line job slots; inherited jobserver,
 * expansion, or unparsed MAKEFLAGS/MFLAGS cannot bind this invocation. */
export const makeWidth = (args: ReadonlyArray<string>, env: ToolEnvironment): ToolWidth => {
  const inherited = [env.MAKEFLAGS, env.MFLAGS, env.GNUMAKEFLAGS].filter(Boolean)
  if (inherited.length > 0 || args.some((arg) => /^(?:MAKEFLAGS|GNUMAKEFLAGS|MFLAGS)=/u.test(arg))) return "unknown"
  return workers(args, makeFlags)
}

const ninjaFlags: Grammar = {
  concurrency: words("-j"), attached: "-j", zero: "full",
  values: words("-C -f -k -l -d -w"),
  switches: words("-n -v --verbose -h --help --version --quiet"),
}
/** Ninja's `-h` (src/ninja.cc: Usage, GuessParallelism, ReadFlags):
 * -j N runs N jobs, 0 = infinity, default processors + 2 above two cores.
 * See https://github.com/ninja-build/ninja/blob/v1.13.2/src/ninja.cc */
export const ninjaWidth = (args: ReadonlyArray<string>): ToolWidth =>
  // SetupJobserverClient: explicit -j disables the inherited jobserver.
  workers(args, ninjaFlags)

const goAdvice = (args: ReadonlyArray<string>, env: ToolEnvironment) => {
  const startup = explicitRuntime(env)
  const missing: string[] = []
  if (!Predicate.isNumber(workers(args, goFlags))) missing.push("packages: pass -p N")
  if (!Predicate.isNumber(startup)) missing.push("startup threads: set GOMAXPROCS=N")
  if (!Predicate.isNumber(testRuntime(args, env, startup)))
    missing.push("test threads: pass -cpu=N (or set GOENV=off and unset GOFLAGS)")
  if (!boundedGoMode(env)) missing.push("execution mode: set GOENV=off and unset GOFLAGS")
  if (missing.length === 0) return "go test: lower -p, GOMAXPROCS, or -cpu to narrow this bound."
  return `go test: ${missing.join("; ")}.`
}
export const widthAdvice = (tool: string, args: ReadonlyArray<string>, env: ToolEnvironment) => {
  const [sub] = args
  if (tool === "go" && sub === "test") return goAdvice(args.slice(1), env)
  if (tool === "bun" && sub === "test") return "bun test: worker count: pass --parallel=N."
  if (tool === "make" || tool === "gmake") return "make: pass -j N without an inherited jobserver."
  if (tool === "ninja") return "ninja: pass -j N (positive N)."
  return "No tool model can prove a narrower width for this command."
}

/** No generic concurrency flag is a contract. Model dispatch, not option
 * spelling, selects a source of bounds. */
export const toolWidth = (tool: string, args: ReadonlyArray<string>, env: ToolEnvironment): ToolWidth => {
  const [sub] = args
  if (tool === "go" && sub === "test") return goTestWidth(args.slice(1), env)
  if (tool === "bun" && sub === "test") return bunTestWidth(args.slice(1))
  if (tool === "make" || tool === "gmake") return makeWidth(args, env)
  if (tool === "ninja") return ninjaWidth(args)
  // POSIX printf/echo/sleep have no worker option or child execution.
  if (tool === "printf" || tool === "echo" || tool === "sleep" || tool === "true") return serial
  return "unknown"
}
