import { Array as Arr, Option } from "effect"
import { historyTarget, literalPath, unknownTarget } from "./executable.ts"
import { basename, resolve } from "./path.ts"
import { GIT_BARE_OPTIONS, GIT_VALUE_OPTIONS } from "./verdict.ts"

export type Revision = "moves" | "files" | "neither" | "unknown"
export interface GitAction {
  readonly revision: Revision
  readonly tree: Option.Option<string>
  readonly bisectRun: boolean
  readonly rebaseExec?: true
  readonly bisectMode?: "refs" | "checkout" | "ended"
  readonly newTree?: true
  readonly explicitTree?: true
}
interface EffectOnTree {
  readonly revision: Revision
  readonly bisectRun: boolean
  readonly rebaseExec?: true
  readonly bisectMode?: GitAction["bisectMode"]
  readonly destination?: string
}
const action = (revision: Revision, bisectRun = false): EffectOnTree => ({ revision, bisectRun })
const described = (description: string) => new Set(description.split(/\s+/))

interface Grammar {
  readonly flags: ReadonlySet<string>
  readonly values: ReadonlySet<string>
}
const grammar = (flags: string, values = ""): Grammar => ({ flags: described(`${flags} -h --help`), values: described(values) })

interface Argv {
  readonly operands: ReadonlyArray<string>
  readonly paths: ReadonlyArray<string>
  readonly flags: ReadonlySet<string>
  readonly has: (keys: ReadonlySet<string>) => boolean
  readonly last: (keys: ReadonlySet<string>) => string
  readonly values: ReadonlyMap<string, string>
}

const optionKey = (word: string): string => word.split("=", 1)[0] || ""

/** The `=` spellings of options whose values are optional, never consuming the next word. */
const OPTIONAL = described("--track --recurse-submodules --gpg-sign -S --reset-when-found --term-new --term-bad --term-old --term-good --rebase-merges")

const optionParts = (token: string, spec: Grammar): ReadonlyArray<string> => {
  const key = optionKey(token)
  if (key !== token && spec.flags.has(key) && !OPTIONAL.has(key)) return []
  if (spec.flags.has(key) || spec.values.has(key) || !/^-[^-].+/.test(token)) return [key]
  const parts: Array<string> = []
  for (const flag of token.slice(1)) {
    const short = `-${flag}`
    parts.push(short)
    if (spec.values.has(short) || OPTIONAL.has(short)) break
  }
  return parts
}

const attachedValue = (token: string, parts: ReadonlyArray<string>, key: string): string => {
  if (token.startsWith("--")) return token.slice(key.length).replace(/^=/, "")
  return token.slice(parts.length + 1)
}

/** Parse a subcommand's own options and operands, never interpreting a path after `--` as an option. */
const argvOf = (args: ReadonlyArray<string>, spec: Grammar): Option.Option<Argv> => {
  const flags = new Set<string>()
  const ordered: Array<string> = []
  const values = new Map<string, string>()
  const operands: Array<string> = []
  let paths: ReadonlyArray<string> = []
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] || ""
    if (token === "--") {
      paths = args.slice(index + 1)
      break
    }
    if (!token.startsWith("-") || token === "-") {
      operands.push(token)
      continue
    }
    const parts = optionParts(token, spec)
    if (parts.length === 0 || !parts.every((key) => spec.flags.has(key) || spec.values.has(key))) return Option.none()
    const valueKey = parts.find((key) => spec.values.has(key)) || ""
    if (valueKey !== "") {
      const attached = attachedValue(token, parts, valueKey)
      index += Number(attached === "")
      if (index >= args.length) return Option.none()
      values.set(valueKey, attached || args[index] || "")
    }
    for (const part of parts) flags.add(part)
    ordered.push(...parts)
  }
  return Option.some({
    operands, paths, flags, values, has: (keys) => Array.from(flags).some((flag) => keys.has(flag)),
    last: (keys) => ordered.findLast((flag) => keys.has(flag)) || "",
  })
}

const help = described("-h --help")
const quiet = "-q --quiet -v --verbose"
const pathspec = "--pathspec-from-file"
const conflicts = "--conflict"
const checkoutFlags = `${quiet} -f --force -m --merge --guess --no-guess --progress --no-progress --recurse-submodules --no-recurse-submodules --ignore-other-worktrees --no-track -t --track`
const checkoutSpec = grammar(`${checkoutFlags} -p --patch --ours --theirs --overlay --no-overlay --ignore-skip-worktree-bits --pathspec-file-nul --detach -l`, `-b -B --orphan ${conflicts} ${pathspec}`)
const switchSpec = grammar(`${checkoutFlags} -d --detach --discard-changes`, `-c -C --create --force-create --orphan ${conflicts}`)
const restoreSpec = grammar(`-q --quiet -p --patch -S --staged -W --worktree --ignore-unmerged --ignore-skip-worktree-bits --recurse-submodules --no-recurse-submodules --overlay --no-overlay --ours --theirs -m --merge --progress --no-progress --pathspec-file-nul`, `-s --source ${conflicts} ${pathspec} -U --unified --inter-hunk-context`)
const historicalResetModes = described("--hard --merge --keep")
const resetModes = described("--soft --mixed --hard --merge --keep")
const resetSpec = grammar(`-q --quiet -p --patch --soft --mixed --hard --merge --keep --recurse-submodules --no-recurse-submodules --pathspec-file-nul --refresh --no-refresh -N --intent-to-add`, `${pathspec} -U --unified --inter-hunk-context`)
const branchCreation = described("-b -B -c -C --create --force-create --orphan")
const restoreOnly = described("--ours --theirs")
const detached = described("-d --detach")
const patches = described(`-p --patch ${pathspec}`)
const sources = described("--source -s")
const index = described("--staged -S")
const worktreeFiles = described("--worktree -W")

const revisionExpression = (target: string): boolean =>
  /^[a-f0-9]{7,40}$/i.test(target) || /(?:[~^]|@\{|^:\/|\.\.)/.test(target)

/** The names for the commit already checked out, including any sequence of zero parent steps. */
const current = (target: string): boolean => target === "" || /^(?:HEAD|@)(?:[~^]0)*$/.test(target)

/** An unadorned name could be a branch or a tag; neither proves historical intent. */
const historical = (target: string, detach = false): boolean => !current(target) && (detach || revisionExpression(target))
const unresolved = (target: string): boolean => target.includes(unknownTarget) || target.includes(historyTarget)
const unresolvedHistory = (target: string, detach = false): boolean => unresolved(target) &&
  (detach || target.includes(historyTarget) || revisionExpression(target))

const validRefName = (word: string): boolean =>
  word !== "@" && !Array.from(word).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) &&
  !/(?:\.\.|@\{|\/\/|[~^:?*[\\]|(?:^|\/)\.|\.lock(?:\/|$)|[/.]$|^\/)/.test(word)

const explicitPath = (word: string): boolean =>
  /^(?:\.{1,2}\/|\/)/.test(word) || (!validRefName(word) && !revisionExpression(word) && !word.includes(":"))

/** An explicit historical pathspec is relevant only if it can supply runnable source or a runner's configuration. */
const launcherPath = (path: string): boolean =>
  /[?*[$]|\/$/.test(path) || /\.(?:[cm]?[jt]sx?|(?:ba|da|k|z)?sh|py|pl|rb|go|rs|ps1|bat|cmd)$/.test(path) ||
  /^(?:[Mm]akefile|GNUmakefile|[Dd]ockerfile|package\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/.test(basename(path)) ||
  /^(?:\.\/)?(?:bin|tools|scripts)(?:\/|$)/.test(path) || !basename(path).includes(".")

const fileSelection = (argv: Argv, target: string, paths = argv.paths): EffectOnTree => {
  if (current(target)) {
    if (target === "") return action("files")
    return action("neither")
  }
  if (unresolved(target)) {
    if (unresolvedHistory(target) && (argv.flags.has(pathspec) || paths.some(launcherPath))) return action("unknown")
    return action("files")
  }
  if (!historical(target)) return action("files")
  if (argv.flags.has(pathspec)) return action("unknown")
  if (paths.some(launcherPath)) return action("moves")
  return action("files")
}

const restore = (argv: Argv): EffectOnTree => {
  const source = argv.last(sources)
  if (argv.has(index) && !argv.has(worktreeFiles)) return action("files")
  return fileSelection(argv, argv.values.get(source) || "", [...argv.operands, ...argv.paths])
}

const checkout = (argv: Argv): EffectOnTree => {
  const [ref = "", ...more] = argv.operands
  if (argv.has(restoreOnly)) return action("files")
  if (argv.paths.length > 0 || argv.flags.has(pathspec)) return fileSelection(argv, ref)
  if (argv.has(patches)) return fileSelection(argv, ref, more)
  if (!current(ref) && !unresolved(ref) && explicitPath(ref)) return action("files")
  if (more.length > 0) return fileSelection(argv, ref, more)
  return checkoutTarget(argv, false)
}

const checkoutTarget = (argv: Argv, switching: boolean): EffectOnTree => {
  const [ref = ""] = argv.operands
  const detach = argv.has(detached)
  // Without -d or branch creation, switch accepts only a branch.
  if (switching && !detach && !argv.has(branchCreation)) return action("neither")
  if (unresolved(ref)) return action(unresolvedRevision(ref, detach))
  if (historical(ref, detach)) return action("moves")
  return action("neither")
}

const reset = (argv: Argv): EffectOnTree => {
  const [ref = "", ...rest] = argv.operands
  if (argv.paths.length > 0 || argv.has(patches) || (!current(ref) && !unresolved(ref) && explicitPath(ref)) || rest.length > 0) return action("files")
  if (!historicalResetModes.has(argv.last(resetModes))) return action("neither")
  if (unresolved(ref)) return action(unresolvedRevision(ref))
  if (historical(ref)) return action("moves")
  return action("neither")
}

const unresolvedRevision = (target: string, detach = false): Revision => {
  if (unresolvedHistory(target, detach)) return "unknown"
  return "neither"
}

const bisectStart = grammar("--no-checkout --first-parent --reset-when-found --term-new --term-bad --term-old --term-good")
const bisectMark = grammar("")
const bisectMarks = described("good bad new old skip")
const bisectReset = grammar("")
const bisectAction = (args: ReadonlyArray<string>, refsOnly: boolean): EffectOnTree => {
  const [verb = "", ...rest] = args
  if (verb === "run") return bisectRun(rest, refsOnly) // The rest is the launched command's argv, not Git's options.
  if (verb === "start") return parse(rest, bisectStart, startBisect)
  if (verb === "reset") return parse(rest, bisectReset, (argv) => ({ ...resetBisect(argv, refsOnly), bisectMode: "ended" }))
  if (bisectMarks.has(verb)) return parse(rest, bisectMark, () => bisectSelection(refsOnly))
  return action("neither")
}

const bisectRun = (args: ReadonlyArray<string>, refsOnly: boolean): EffectOnTree => {
  const [program = "", after = ""] = args
  if (help.has(program) || program === "") return action("neither")
  if (optionKey(program) === "--reset-when-found") return action(bisectSelection(refsOnly).revision, after !== "")
  if (program.startsWith("-") && program !== "--") return action("unknown")
  return action(bisectSelection(refsOnly).revision, true)
}

const startBisect = (argv: Argv): EffectOnTree => {
  if (argv.flags.has("--no-checkout")) return { ...action("neither"), bisectMode: "refs" }
  return { ...action("moves"), bisectMode: "checkout" }
}
const bisectSelection = (refsOnly: boolean): EffectOnTree => {
  if (refsOnly) return action("neither")
  return action("moves")
}
const resetBisect = (argv: Argv, refsOnly: boolean): EffectOnTree => {
  const [target = ""] = argv.operands
  if (argv.operands.length > 0 && current(target)) return action("neither")
  if (!refsOnly && unresolved(target)) return action("unknown")
  return bisectSelection(refsOnly)
}
const rebaseSpec = grammar(`${quiet} --abort --continue --skip --quit --edit-todo --show-current-patch --apply --merge -i --interactive --root --onto --keep-base --reapply-cherry-picks --no-reapply-cherry-picks --fork-point --no-fork-point --autostash --no-autostash --autosquash --no-autosquash --rebase-merges --no-rebase-merges --update-refs --no-update-refs --force-rebase --no-ff -f --signoff --no-signoff --committer-date-is-author-date --ignore-date --reset-author-date --keep-empty --no-keep-empty --allow-empty-message --reschedule-failed-exec --no-reschedule-failed-exec --verify --no-verify -S --gpg-sign --no-gpg-sign --rerere-autoupdate --no-rerere-autoupdate --stat --no-stat`, `--onto --empty --strategy -s -X --strategy-option -x --exec -C --whitespace -U --unified --inter-hunk-context`)
const execOptions = described("-x --exec")
const rebase = (args: ReadonlyArray<string>): EffectOnTree => {
  if (!Arr.takeWhile(args, (word) => word !== "--").some((word) => optionParts(word, rebaseSpec).some((key) => execOptions.has(key)))) return action("neither")
  return parse(args, rebaseSpec, (argv) => {
    if (!argv.has(execOptions)) return action("neither")
    return { ...action("moves"), rebaseExec: true }
  })
}

const worktreeAdd = grammar("-d --detach --checkout --no-checkout --orphan --guess-remote --no-guess-remote --track --no-track -f --force --lock -q --quiet --relative-paths --no-relative-paths", "-b -B --reason")
const worktree = (args: ReadonlyArray<string>): EffectOnTree => {
  const [verb = "", ...rest] = args
  if (verb !== "add") return action("neither")
  return parse(rest, worktreeAdd, addWorktree)
}

const checkoutToggle = described("--no-checkout --checkout")
const addWorktree = (argv: Argv): EffectOnTree => {
  const [destination = "", target = ""] = [...argv.operands, ...argv.paths]
  if (argv.flags.has("--orphan") || argv.last(checkoutToggle) === "--no-checkout") return action("neither")
  if (unresolved(target)) return { ...action(unresolvedRevision(target, argv.has(detached))), destination }
  if (!historical(target, argv.has(detached))) return action("neither")
  if (destination === "") return action("unknown")
  return { ...action("moves"), destination }
}

const parse = (args: ReadonlyArray<string>, grammar: Grammar, select: (argv: Argv) => EffectOnTree): EffectOnTree =>
  Option.match(argvOf(args, grammar), {
    onNone: () => action("unknown"),
    onSome: (argv) => {
      if (argv.has(help)) return action("neither")
      return select(argv)
    },
  })

/** Each known command owns its grammar; unrecognized options on it cannot be inferred. */
const subcommand = (name: string, args: ReadonlyArray<string>, refsOnly: boolean): EffectOnTree => {
  switch (name) {
    case "checkout": return parse(args, checkoutSpec, checkout)
    case "switch": return parse(args, switchSpec, (argv) => checkoutTarget(argv, true))
    case "restore": return parse(args, restoreSpec, restore)
    case "reset": return parse(args, resetSpec, reset)
    case "bisect": return bisectAction(args, refsOnly)
    case "rebase": return rebase(args)
    case "worktree": return worktree(args)
    default: return action("neither")
  }
}

interface GitPlace {
  readonly cwd: Option.Option<string>
  readonly gitDir: Option.Option<string>
  readonly workTree: Option.Option<string>
  readonly bare: boolean
}
const atPath = (cwd: Option.Option<string>, path: string): Option.Option<string> => {
  if (!literalPath(path)) return Option.none()
  if (path.startsWith("/")) return Option.some(resolve("/", path))
  return Option.map(cwd, (dir) => resolve(dir, path))
}

const placeOption = (at: GitPlace, key: string, value: Option.Option<string>): GitPlace => {
  if (key === "--bare") return { ...at, bare: true }
  if (key === "--work-tree") return { ...at, workTree: value }
  if (key === "--git-dir") return { ...at, gitDir: value }
  if (key === "-C" && !Option.contains(value, "")) return { ...at, cwd: Option.flatMap(value, (path) => atPath(at.cwd, path)) }
  return at
}

const treeOf = (at: GitPlace): Option.Option<string> => {
  if (Option.isSome(at.workTree)) return atPath(at.cwd, at.workTree.value)
  if (at.bare) return Option.none()
  // Explicit metadata turns discovery off; Git treats cwd as the top level, not the metadata directory's parent.
  return at.cwd
}

const globalEnd = described("-v --version -h --help --html-path --man-path --info-path --exec-path --list-cmds")
const classify = (args: ReadonlyArray<string>, at: GitPlace, refsOnly: (tree: Option.Option<string>) => boolean): GitAction => {
  const [token = "", ...rest] = args
  const tree = treeOf(at)
  if (!token.startsWith("-")) return finishAction(subcommand(token, rest, refsOnly(tree)), tree, at)
  if (globalEnd.has(token)) return { ...action("neither"), tree }
  const key = optionKey(token)
  if (key === "-C" && token !== key) return { ...action("neither"), tree }
  if (GIT_VALUE_OPTIONS.has(key)) {
    const value = globalValue(token, key, rest)
    if (Option.isNone(value)) return { ...action("neither"), tree }
    return classify(rest.slice(Number(token === key)), placeOption(at, key, value), refsOnly)
  }
  if (GIT_BARE_OPTIONS.has(key)) return classify(rest, placeOption(at, key, Option.none()), refsOnly)
  return { ...action("neither"), tree }
}
const globalValue = (token: string, key: string, tail: ReadonlyArray<string>): Option.Option<string> => {
  if (token !== key) return Option.some(token.slice(key.length + 1))
  return Arr.head(tail)
}
const finishAction = (change: EffectOnTree, tree: Option.Option<string>, at: GitPlace): GitAction => {
  if (change.destination) return { ...change, tree: atPath(at.cwd, change.destination), newTree: true }
  if (at.bare && Option.isNone(at.workTree) && !change.bisectRun && change.revision === "moves") return { ...action("neither"), tree }
  if (Option.isSome(at.workTree) || Option.isSome(at.gitDir)) return { ...change, tree, explicitTree: true }
  return { ...change, tree }
}

export interface GitLocation {
  readonly cwd: string
  readonly unknownCwd?: true
  readonly env?: ReadonlyMap<string, string>
}

/** Historical checkout content selected by this invocation and the worktree it targets. */
export const gitAction = (head: string, args: ReadonlyArray<string>, where: GitLocation = { cwd: "/" }, refsOnly: (tree: Option.Option<string>) => boolean = () => false): GitAction => {
  if (head !== "git") return { ...action("neither"), tree: Option.none() }
  return classify(args, {
    cwd: Option.liftPredicate(where.cwd, () => !where.unknownCwd),
    gitDir: Option.fromUndefinedOr(where.env?.get("GIT_DIR")),
    workTree: Option.fromUndefinedOr(where.env?.get("GIT_WORK_TREE")),
    bare: false,
  }, refsOnly)
}
