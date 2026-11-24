import { Array as Arr, Option } from "effect"
import { literalPath } from "./executable.ts"
import { basename, resolve } from "./path.ts"
import { GIT_BARE_OPTIONS, GIT_VALUE_OPTIONS } from "./verdict.ts"

export type Revision = "moves" | "files" | "neither" | "unknown"
export interface GitAction {
  readonly revision: Revision
  readonly tree: Option.Option<string>
  readonly bisectRun: boolean
  /** An executed old-revision driver may select a commit whose launcher is indirect. */
  readonly scriptSelection: boolean
  readonly bisectMode?: "refs" | "checkout" | "ended"
  readonly newTree?: true
  readonly explicitTree?: true
}
interface EffectOnTree {
  readonly revision: Revision
  readonly bisectRun: boolean
  readonly scriptSelection: boolean
  readonly bisectMode?: GitAction["bisectMode"]
  readonly destination?: string
}
const action = (revision: Revision, scriptSelection = false, bisectRun = false): EffectOnTree => ({ revision, scriptSelection, bisectRun })
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
}

const optionKey = (word: string): string => word.split("=", 1)[0] || ""

/** The `=` spellings of options whose values are optional, never consuming the next word. */
const OPTIONAL = described("--track --recurse-submodules --gpg-sign -S --rebase --log --porcelain --color --relative --untracked-files --reset-when-found --term-new --term-bad --term-old --term-good --rebase-merges --strategy --guess-remote")

const optionParts = (token: string, spec: Grammar): ReadonlyArray<string> => {
  const key = optionKey(token)
  if (key !== token && spec.flags.has(key) && !OPTIONAL.has(key)) return []
  if (spec.flags.has(key) || spec.values.has(key) || !/^-[^-].+/.test(token)) return [key]
  const short = token.slice(0, 2)
  if (spec.values.has(short) || OPTIONAL.has(short)) return [short]
  return token.slice(1).split("").map((flag) => `-${flag}`)
}

const optionValueCount = (parts: ReadonlyArray<string>, token: string, spec: Grammar): number =>
  Number(parts.some((key) => spec.values.has(key) && key === token))

/** Parse a subcommand's own options and operands, never interpreting a path after `--` as an option. */
const argvOf = (args: ReadonlyArray<string>, spec: Grammar): Option.Option<Argv> => {
  const flags = new Set<string>()
  const ordered: Array<string> = []
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
    const count = optionValueCount(parts, token, spec)
    if (index + count >= args.length) return Option.none()
    for (const part of parts) flags.add(part)
    ordered.push(...parts)
    index += count
  }
  return Option.some({
    operands, paths, flags, has: (keys) => Array.from(flags).some((flag) => keys.has(flag)),
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
const resetModes = described("--soft --mixed --hard --merge --keep")
const resetSpec = grammar(`-q --quiet -p --patch --soft --mixed --hard --merge --keep --recurse-submodules --no-recurse-submodules --pathspec-file-nul --refresh --no-refresh -N --intent-to-add`, `${pathspec} -U --unified --inter-hunk-context`)
const branchCreation = described("-b -B -c -C --create --force-create --orphan")
const restoreOnly = described(`-p --patch --ours --theirs ${pathspec}`)
const detached = described("-d --detach")
const patches = described(`-p --patch ${pathspec}`)

const revisionExpression = (word: string): boolean =>
  /^(?:HEAD|-|[a-f0-9]{7,64})$/i.test(word) || /^[\w./-]+(?:[~^]|@\{)/.test(word)

const validRefName = (word: string): boolean =>
  word !== "@" && !Array.from(word).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) &&
  !/(?:\.\.|@\{|\/\/|[~^:?*[\\]|(?:^|\/)\.|\.lock(?:\/|$)|[/.]$|^\/)/.test(word)

const explicitPath = (word: string): boolean =>
  /^(?:\.{1,2}\/|\/)/.test(word) || (!validRefName(word) && !revisionExpression(word) && !word.includes(":"))

const checkout = (name: string, args: ReadonlyArray<string>): EffectOnTree => {
  const spec = checkoutGrammar(name)
  const argv = argvOf(args, spec)
  if (Option.isNone(argv)) return action("unknown")
  if (argv.value.has(help)) return action("neither")
  // Preserve the separate pathspec exclusion: tree-qualified paths do not change HEAD.
  const before = Arr.takeWhile(args, (word) => word !== "--")
  if (name === "checkout" && before.length < args.length - 1) return action("files")
  return checkoutTarget(name, argv.value)
}

const checkoutGrammar = (name: string): Grammar => {
  if (name === "switch") return switchSpec
  return checkoutSpec
}

const checkoutTarget = (name: string, argv: Argv): EffectOnTree => {
  const [ref = "", ...more] = argv.operands
  if (name === "checkout" && argv.has(restoreOnly)) return action("files")
  if (argv.flags.has("--orphan")) return action("moves", true)
  if (ref === "HEAD") return action("neither")
  if (argv.has(detached) && argv.operands.length > 0) return action("moves", true)
  if (ref === "") return action("neither")
  if (argv.has(branchCreation)) return action("moves", true)
  if (name === "switch") return action("moves")
  if (explicitPath(ref) || more.length > 0) return action("files")
  if (revisionExpression(ref)) return action("moves", true)
  return action("unknown")
}

const reset = (argv: Argv): EffectOnTree => {
  const [ref = "", ...rest] = argv.operands
  if (argv.paths.length > 0 || argv.has(patches) || explicitPath(ref) || rest.length > 0) return action("files")
  if (ref === "" || ref === "HEAD") return action("neither")
  if (argv.has(resetModes) || revisionExpression(ref)) return action("moves", true)
  return action("unknown")
}

const bisectStart = grammar("--no-checkout --first-parent --reset-when-found --term-new --term-bad --term-old --term-good")
const bisectMark = grammar("")
const bisectReadOnly = described("log visualize view terms")
const bisectMarks = described("good bad new old skip next")
const bisectReset = grammar("")
const bisectAction = (args: ReadonlyArray<string>, refsOnly: boolean): EffectOnTree => {
  const [verb = "", ...rest] = args
  if (verb === "run") return bisectRun(rest, refsOnly) // The rest is the launched command's argv, not Git's options.
  if (verb === "start") return parse(rest, bisectStart, startBisect)
  if (verb === "reset") return parse(rest, bisectReset, (argv) => ({ ...resetBisect(argv, refsOnly), bisectMode: "ended" }))
  if (bisectMarks.has(verb)) return parse(rest, bisectMark, () => bisectSelection(refsOnly))
  if (verb === "replay") return parse(rest, grammar(""), () => bisectSelection(refsOnly))
  if (bisectReadOnly.has(verb) || help.has(verb) || verb === "") return action("neither")
  return action("unknown")
}

const bisectRun = (args: ReadonlyArray<string>, refsOnly: boolean): EffectOnTree => {
  const [program = "", after = ""] = args
  if (help.has(program) || program === "") return action("neither")
  if (optionKey(program) === "--reset-when-found") return action(bisectSelection(refsOnly).revision, false, after !== "")
  if (program.startsWith("-") && program !== "--") return action("unknown")
  return action(bisectSelection(refsOnly).revision, false, true)
}

const startBisect = (argv: Argv): EffectOnTree => {
  if (argv.flags.has("--no-checkout")) return { ...action("neither"), bisectMode: "refs" }
  return { ...action("moves", true), bisectMode: "checkout" }
}
const bisectSelection = (refsOnly: boolean): EffectOnTree => {
  if (refsOnly) return action("neither")
  return action("moves", true)
}
const resetBisect = (argv: Argv, refsOnly: boolean): EffectOnTree => {
  if (argv.operands[0] === "HEAD") return action("neither")
  return bisectSelection(refsOnly)
}

const mergeFlags = `${quiet} -n --stat --no-stat --summary --no-summary --compact-summary --no-compact-summary --log --no-log --squash --no-squash --commit --no-commit --edit --no-edit -e --ff --no-ff --ff-only --verify-signatures --no-verify-signatures --signoff --no-signoff --allow-unrelated-histories --no-allow-unrelated-histories --autostash --no-autostash --overwrite-ignore --no-overwrite-ignore --rerere-autoupdate --no-rerere-autoupdate -S --gpg-sign --no-gpg-sign --progress --no-progress --verify --no-verify`
const mergeValues = "-s --strategy -X --strategy-option -m --message -F --file --cleanup --into-name"
const mergeSpec = grammar(`${mergeFlags} --abort --continue --quit`, mergeValues)
const pullSpec = grammar(`${mergeFlags} -r --rebase --no-rebase --all -a --append --atomic --dry-run -f --force --keep -k --multiple --prune -p --prune-tags -t --tags -n --no-tags --no-recurse-submodules --recurse-submodules --no-write-fetch-head --write-fetch-head --set-upstream --update-shallow --unshallow --show-forced-updates --no-show-forced-updates --allow-unrelated-histories --negotiate-only --ipv4 --ipv6 -4 -6 --porcelain --auto-maintenance --no-auto-maintenance --auto-gc --no-auto-gc`, `${mergeValues} --depth --deepen --shallow-since --shallow-exclude -j --jobs --refmap --server-option -o --negotiation-tip --upload-pack`)
const rebaseSpec = grammar(`${quiet} --abort --continue --skip --quit --edit-todo --show-current-patch --apply --merge -i --interactive --root --onto --keep-base --reapply-cherry-picks --no-reapply-cherry-picks --fork-point --no-fork-point --autostash --no-autostash --autosquash --no-autosquash --rebase-merges --no-rebase-merges --update-refs --no-update-refs --force-rebase --no-ff -f --signoff --no-signoff --committer-date-is-author-date --ignore-date --reset-author-date --keep-empty --no-keep-empty --allow-empty-message --reschedule-failed-exec --no-reschedule-failed-exec --verify --no-verify -S --gpg-sign --no-gpg-sign --rerere-autoupdate --no-rerere-autoupdate --stat --no-stat`, `--onto --empty --strategy -s -X --strategy-option -x --exec -C --whitespace -U --unified --inter-hunk-context`)
const noMerge = described("--quit")
const noPull = described("--dry-run --negotiate-only")
const noRebase = described("--quit --edit-todo --show-current-patch")
const squash = described("--squash --no-squash")
const commit = described("--commit --no-commit")
const fastForward = described("--ff --no-ff --ff-only")
const integration = (argv: Argv, none: ReadonlySet<string>): EffectOnTree => {
  if (argv.has(none)) return action("neither")
  if (argv.last(squash) === "--squash") return action("files")
  return action("moves", true)
}

const merge = (argv: Argv): EffectOnTree => {
  if (argv.last(commit) === "--no-commit" && argv.last(fastForward) === "--no-ff") return action("files")
  return integration(argv, noMerge)
}

const stashPush = grammar(`-q --quiet -p --patch -S --staged -k --keep-index --no-keep-index -u --include-untracked -a --all --pathspec-file-nul`, `-m --message ${pathspec}`)
const stashApply = grammar("-q --quiet --index --no-index", "--label-ours --label-theirs --label-base")
const stashList = grammar("-q --quiet --stat --no-stat -p --patch -u --include-untracked --only-untracked --name-only --name-status --oneline --all --decorate --no-decorate --graph", "-n --max-count --format --pretty")
const stash = (args: ReadonlyArray<string>): EffectOnTree => {
  const [verb = "push", ...rest] = args
  if (verb === "branch") return parse(rest, grammar(""), () => action("moves", true))
  if (verb === "apply" || verb === "pop") return parse(rest, stashApply, () => action("files"))
  if (verb === "push" || verb === "save") return parse(rest, stashPush, () => action("files"))
  if (verb === "list" || verb === "show") return parse(rest, stashList, () => action("neither"))
  if (["clear", "drop", "create", "store", "export", "import"].includes(verb)) return parse(rest, grammar("-q --quiet --print", "-m --message --to-ref"), () => action("neither"))
  if (verb.startsWith("-")) return parse(args, stashPush, () => action("files"))
  return action("unknown")
}

const worktreeAdd = grammar("-d --detach --checkout --no-checkout --orphan --guess-remote --no-guess-remote --track --no-track -f --force --lock -q --quiet --relative-paths --no-relative-paths", "-b -B --reason")
const worktree = (args: ReadonlyArray<string>): EffectOnTree => {
  const [verb = "", ...rest] = args
  if (verb === "add") return parse(rest, worktreeAdd, (argv) => createCheckout(argv, argv.operands[0] || argv.paths[0] || ""))
  if (["list", "lock", "move", "prune", "remove", "repair", "unlock"].includes(verb)) {
    return parse(rest, grammar("-v --verbose -f --force -n --dry-run --porcelain -z --relative-paths --no-relative-paths", "--expire --reason"), () => action("neither"))
  }
  return action("unknown")
}
const cloneSpec = grammar(`${quiet} --progress -n --no-checkout --bare --mirror -l --local --no-local -s --shared --no-hardlinks --dissociate --recurse-submodules --recursive --no-recurse-submodules --shallow-submodules --no-shallow-submodules --remote-submodules --no-remote-submodules --single-branch --no-single-branch --tags --no-tags --reject-shallow --no-reject-shallow --sparse --also-filter-submodules --filter-submodules --no-filter-submodules --ipv4 --ipv6 -4 -6`, `--template --reference --reference-if-able -o --origin -b --branch --revision -u --upload-pack --depth --shallow-since --shallow-exclude --separate-git-dir -c --config --server-option -j --jobs --filter --bundle-uri --ref-format`)
const noCheckout = described("--bare --mirror --orphan")
const checkoutToggle = described("-n --no-checkout --checkout")
const createCheckout = (argv: Argv, destination: string): EffectOnTree => {
  if (argv.has(noCheckout)) return action("neither")
  const checkout = argv.last(checkoutToggle)
  if (checkout === "-n" || checkout === "--no-checkout") return action("neither")
  if (destination === "") return action("unknown")
  return { ...action("moves", true), destination }
}

const clone = (argv: Argv): EffectOnTree => {
  const [source = "", destination = ""] = [...argv.operands, ...argv.paths]
  const derived = basename(source.replace(/\/+$/, "")).split(":").at(-1) || ""
  return createCheckout(argv, destination || derived.replace(/\.(?:git|bundle)$/, ""))
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
    case "checkout":
    case "switch": return checkout(name, args)
    case "restore": return parse(args, restoreSpec, () => action("files"))
    case "reset": return parse(args, resetSpec, reset)
    case "bisect": return bisectAction(args, refsOnly)
    case "merge": return parse(args, mergeSpec, merge)
    case "pull": return parse(args, pullSpec, (argv) => integration(argv, noPull))
    case "rebase": return parse(args, rebaseSpec, (argv) => integration(argv, noRebase))
    case "stash": return stash(args)
    case "worktree": return worktree(args)
    case "clone": return parse(args, cloneSpec, clone)
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
  if (key === "-C" && token !== key) return { ...action("unknown"), tree: Option.none() }
  if (GIT_VALUE_OPTIONS.has(key)) {
    const value = globalValue(token, key, rest)
    if (Option.isNone(value)) return { ...action("unknown"), tree: Option.none() }
    return classify(rest.slice(Number(token === key)), placeOption(at, key, value), refsOnly)
  }
  if (GIT_BARE_OPTIONS.has(key)) return classify(rest, placeOption(at, key, Option.none()), refsOnly)
  return { ...action("unknown"), tree: Option.none() }
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

/** Git's checked-out commit effect and its target worktree, independent of shell cwd changes. */
export const gitAction = (head: string, args: ReadonlyArray<string>, where: GitLocation = { cwd: "/" }, refsOnly: (tree: Option.Option<string>) => boolean = () => false): GitAction => {
  if (head !== "git") return { ...action("neither"), tree: Option.none() }
  return classify(args, {
    cwd: Option.liftPredicate(where.cwd, () => !where.unknownCwd),
    gitDir: Option.fromUndefinedOr(where.env?.get("GIT_DIR")),
    workTree: Option.fromUndefinedOr(where.env?.get("GIT_WORK_TREE")),
    bare: false,
  }, refsOnly)
}
