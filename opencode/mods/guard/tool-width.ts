import { Option, Predicate } from "effect"
import { widthOf, type Width } from "./admission-wire.ts"

export type ToolWidth = Width | "invalid"
export type ToolEnvironment = Readonly<Partial<Record<string, string>>>
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
}
const compactNumber = (name: string, grammar: Grammar) => Option.filter(
  Option.fromNullishOr(grammar.attached),
  (prefix) => name.startsWith(prefix) && name !== prefix,
).pipe(Option.map((prefix) => name.slice(prefix.length)))

const positionalNumber = (next: Option.Option<string>, grammar: Grammar) => Option.filter(next, (value) =>
  !grammar.equalsOnly && (/^[+-]?\d|^\$/u.test(value) || Predicate.isUndefined(grammar.implicit)))

const widthValue = (value: string, grammar: Grammar) => {
  if (grammar.zero && /^0+$/u.test(value)) return grammar.zero
  return readWidth(value)
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
const workers = (args: ReadonlyArray<string>, grammar: Grammar, fallback: ToolWidth): ToolWidth => {
  let width = fallback
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
    width = option.width
    i += option.skip
    if (width === "invalid" || width === "unknown") return width
  }
  return width
}

const goFlags: Grammar = {
  concurrency: words("-p"),
  values: words(`-C -covermode -coverpkg -asmflags -buildmode -compiler -gccgoflags -gcflags -installsuffix
    -ldflags -mod -modfile -overlay -pgo -pkgdir -tags -bench -benchtime -count -list -outputdir
    -parallel -run -shuffle -skip -timeout -vet -blockprofile -blockprofilerate -coverprofile
    -cpuprofile -memprofile -memprofilerate -mutexprofile -mutexprofilefraction -trace`),
  switches: words(`-a -n -race -msan -asan -cover -v -work -x -buildvcs -json -linkshared
    -modcacherw -trimpath -artifacts -failfast -fullpath -short -benchmem`),
  stop: words("-args --args"),
  normalize: (name) => name.replace(/^--/u, "-").replace(/^-test\.(?!p$)/u, "-"),
}
const goDefault = (env: ToolEnvironment): ToolWidth => {
  const runtime = env.GOMAXPROCS
  // runtime.GOMAXPROCS docs: non-positive/non-numeric env is ignored;
  // otherwise the logical/affinity/quota default is bounded by the host.
  if (!runtime || !/^\+?\d+$/u.test(runtime) || Number(runtime) <= 0) {
    if (runtime?.includes("$")) return "unknown"
    return "full"
  }
  return numeric(Number(runtime))
}
const multiply = (a: ToolWidth, b: ToolWidth): ToolWidth => {
  const joined = joinWidth(a, b)
  if (Predicate.isNumber(a) && Predicate.isNumber(b)) return numeric(a * b)
  return joined
}
/** `go help build` (-p defaults to GOMAXPROCS) and `go help testflag`
 * (-parallel governs t.Parallel, not CPU; -fuzz spawns separate workers).
 * See `go doc runtime.GOMAXPROCS` for the host default. */
export const goTestWidth = (args: ReadonlyArray<string>, env: ToolEnvironment): ToolWidth => {
  const runtime = goDefault(env)
  const inherited = env.GOFLAGS ?? ""
  // `go help environment`: GOFLAGS carries space-separated flag=value
  // settings, processed before argv; quoting/expansion is not this parser's.
  if (/['"\\$]/u.test(inherited)) return "unknown"
  const defaults = workers(inherited.trim().split(/\s+/u).filter(Boolean), goFlags, runtime)
  if (defaults === "unknown" || defaults === "invalid") return defaults
  // Not in this grammar: -cpu can change runtime width; -fuzz spawns
  // subprocesses; -exec and -toolexec delegate to arbitrary commands.
  return multiply(workers(args, goFlags, defaults), runtime)
}

const bunFlags: Grammar = {
  concurrency: words("--parallel"),
  implicit: "full",
  equalsOnly: true,
  values: words(`--timeout --rerun-each --retry --seed --coverage-reporter --coverage-dir -t --test-name-pattern
    --reporter --reporter-outfile --max-concurrency --path-ignore-patterns --parallel-delay --shard --timings`),
  switches: words(`--no-orphans -u --update-snapshots --todo --only --pass-with-no-tests --concurrent --randomize
    --coverage --dots --only-failures --isolate --no-isolate --update-timings`),
}
/** `bun test --help`: --parallel=N worker processes; without a value
 * the flag defaults to CPU core count. Without the flag, one test worker
 * runs test files in the invoking runtime (async tests do not add workers). */
export const bunTestWidth = (args: ReadonlyArray<string>): ToolWidth => workers(args, bunFlags, serial)

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
 * --jobs[=N], default one job, no value unlimited. An inherited jobserver,
 * expansion, or unparsed MAKEFLAGS/MFLAGS cannot bind this invocation. */
export const makeWidth = (args: ReadonlyArray<string>, env: ToolEnvironment): ToolWidth => {
  const inherited = [env.MAKEFLAGS, env.MFLAGS, env.GNUMAKEFLAGS].filter(Boolean)
  if (inherited.length > 0 || args.some((arg) => /^(?:MAKEFLAGS|GNUMAKEFLAGS|MFLAGS)=/u.test(arg))) return "unknown"
  return workers(args, makeFlags, serial)
}

const ninjaFlags: Grammar = {
  concurrency: words("-j"), attached: "-j", zero: "full",
  values: words("-C -f -k -l -d -w"),
  switches: words("-n -v --verbose -h --help --version --quiet"),
}
/** Ninja's `-h` (src/ninja.cc: Usage, GuessParallelism, ReadFlags):
 * -j N runs N jobs, 0 = infinity, default processors + 2 above two cores.
 * See https://github.com/ninja-build/ninja/blob/v1.13.2/src/ninja.cc */
export const ninjaWidth = (args: ReadonlyArray<string>, env: ToolEnvironment = {}): ToolWidth => {
  // Ninja 1.13 can join a GNU jobserver when there is no explicit -j.
  if (env.MAKEFLAGS) return "unknown"
  return workers(args, ninjaFlags, "full")
}

/** No generic concurrency flag is a contract. Model dispatch, not option
 * spelling, selects a source of bounds. */
export const toolWidth = (tool: string, args: ReadonlyArray<string>, env: ToolEnvironment): ToolWidth => {
  const [sub] = args
  if (tool === "go" && sub === "test") return goTestWidth(args.slice(1), env)
  if (tool === "bun" && sub === "test") return bunTestWidth(args.slice(1))
  if (tool === "make" || tool === "gmake") return makeWidth(args, env)
  if (tool === "ninja") return ninjaWidth(args, env)
  // POSIX printf/echo/sleep have no worker option or child execution.
  if (tool === "printf" || tool === "echo" || tool === "sleep" || tool === "true") return serial
  return "unknown"
}
