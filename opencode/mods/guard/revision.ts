import { Array as Arr, Option } from "effect"
import { gitSubcommand } from "./verdict.ts"

export type Revision = "moves" | "files" | "neither" | "unknown"
export interface GitAction {
  readonly revision: Revision
  readonly bisectRun: boolean
  /** Evidence of selecting another revision from within executed code, even if its launcher is indirect. */
  readonly scriptSelection: boolean
}

const action = (revision: Revision, scriptSelection = false, bisectRun = false): GitAction => ({ revision, scriptSelection, bisectRun })

/** Git ref-name restrictions (one-level names are valid for checkout's lookup). */
const validRefName = (word: string): boolean =>
  word !== "@" && !Array.from(word).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) &&
  !/(?:\.\.|@\{|\/\/|[~^:?*[\\]|(?:^|\/)\.|\.lock(?:\/|$)|[/.]$|^\/)/.test(word)

const revisionExpression = (word: string): boolean =>
  /^(?:HEAD|-|[a-f0-9]{7,40})$/i.test(word) || /^[\w./-]+(?:[~^]|@\{)/.test(word)

/** `./` is unambiguously a path. An invalid ref may still be a revision expression (`HEAD~2`). */
const explicitPath = (word: string): boolean =>
  /^(?:\.{1,2}\/|\/)/.test(word) || (!validRefName(word) && !revisionExpression(word) && !word.includes(":"))

const CHECKOUT_FLAGS: ReadonlySet<string> = new Set([
  "-q", "--quiet", "-f", "--force", "-m", "--merge", "--no-guess", "--guess", "--progress", "--no-progress",
  "--recurse-submodules", "--no-recurse-submodules", "--ignore-other-worktrees", "--discard-changes", "--no-track", "--track",
])
const NEW_BRANCH: ReadonlySet<string> = new Set(["-b", "-B", "-c", "-C", "--create", "--force-create", "--orphan"])
const CHECKOUT_VALUES: ReadonlySet<string> = new Set([...NEW_BRANCH, "--conflict"])
const PATH_ONLY: ReadonlySet<string> = new Set(["-p", "--patch", "--ours", "--theirs"])
const pathspecFile = (word: string): boolean => word === "--pathspec-from-file" || word.startsWith("--pathspec-from-file=")

const checkoutOperands = (before: ReadonlyArray<string>, switchCommand: boolean): Option.Option<ReadonlyArray<string>> => {
  const refs: Array<string> = []
  for (let index = 0; index < before.length; index += 1) {
    const word = before[index] || ""
    if (word === "--detach" || (switchCommand && word === "-d") || CHECKOUT_FLAGS.has(word)) continue
    if (CHECKOUT_VALUES.has(word)) {
      index += 1
      continue
    }
    if (word.startsWith("--conflict=") || word.startsWith("--track=")) continue
    if (word.startsWith("-") && word !== "-") return Option.none()
    refs.push(word)
  }
  return Option.some(refs)
}

const checkoutRef = ([ref = "", ...other]: ReadonlyArray<string>, switchCommand: boolean): GitAction => {
  if (ref === "") return action("neither")
  if (switchCommand) return action("moves")
  if (explicitPath(ref) || other.length > 0) return action("files")
  if (revisionExpression(ref)) return action("moves", true)
  // A single bare operand can name either a branch or a tracked path.
  return action("unknown")
}

const checkout = (name: string, args: ReadonlyArray<string>): GitAction => {
  const before = Arr.takeWhile(args, (arg) => arg !== "--")
  if (name === "checkout" && before.length < args.length - 1) return action("files")
  if (name === "switch" && before.length < args.length - 1) return action("neither")
  if (name === "checkout" && before.some((word) => PATH_ONLY.has(word) || pathspecFile(word))) return action("files")
  const switchCommand = name === "switch"
  const refs = checkoutOperands(before, switchCommand)
  if (Option.isNone(refs)) return action("unknown")
  if (before.includes("--detach") || (switchCommand && before.includes("-d"))) return action("moves", true)
  if (before.some((word) => NEW_BRANCH.has(word))) return action("moves", refs.value.length > 0)
  return checkoutRef(refs.value, switchCommand)
}

const bisect = (verb: string): GitAction => {
  if (verb === "run") return action("moves", false, true)
  if (["start", "good", "bad", "new", "old", "skip", "reset", "replay"].includes(verb)) return action("moves", true)
  return action("neither")
}

/** Classification of Git argv, without guessing whether a bare name exists as a branch or a file. */
export const gitAction = (head: string, args: ReadonlyArray<string>): GitAction => {
  if (head !== "git") return action("neither")
  const sub = gitSubcommand(args)
  if (sub.kind === "unreadable") return action("unknown")
  const options = Arr.takeWhile(sub.rest, (word) => word !== "--")
  if (options.includes("-h") || options.includes("--help")) return action("neither")
  const [verb = ""] = sub.rest
  if (sub.name === "bisect") return bisect(verb)
  if (sub.name === "switch" || sub.name === "checkout") return checkout(sub.name, sub.rest)
  if (sub.name === "restore") return action("files")
  if (sub.name === "rebase") {
    if (verb === "--show-current-patch" || verb === "--quit" || verb === "--help" || verb === "-h") return action("neither")
    return action("moves", true)
  }
  if (sub.name === "worktree" && verb === "add") return action("moves", true)
  if (sub.name === "stash" && verb === "branch") return action("moves", true)
  if (sub.name !== "reset") return action("neither")
  return reset(sub.rest)
}

const reset = (args: ReadonlyArray<string>): GitAction => {
  const before = Arr.takeWhile(args, (word) => word !== "--")
  if (before.length < args.length - 1 || before.some((word) => word === "-p" || word === "--patch" || pathspecFile(word))) return action("files")
  const targets = before.filter((word) => !word.startsWith("-"))
  if (targets.some(explicitPath) || targets.length > 1) return action("files")
  if (targets.length === 0) return action("neither")
  if (targets.some(revisionExpression)) return action("moves", true)
  if (before.some((word) => ["--hard", "--soft", "--mixed", "--merge", "--keep"].includes(word))) return action("moves", true)
  return action("unknown")
}
