// The guard's rule: the few shell commands that lose work for good are
// refused, everything else runs. The Claude Code hook's rules
// (claude/hooks/guard-destructive.ts) with a floor under them:
//
// - A recursive `rm` (forced or not: with no terminal, `rm` never prompts) of
//   the root, the home or a directory that holds it, the directory the
//   command runs in or one above it, a `.git` directory, or a repository's
//   root. A glob over a directory (`*`, `dir/*`) reads as that directory.
// - `git reset --hard`, global options (`-C`, `-c`, `--git-dir`) skipped.
// - `git clean` forced, with `-d`, `-x` or `-X`, and not a dry run.
// - A force-push runs (the owner, 2026-10-13).
//
// The line is read as its simple commands (shell-line.ts): separators,
// quotes, heredoc bodies, prefixes (`sudo`, `env`, `FOO=1`, `nohup`), a `cd`
// that moves where the next command runs, and the script of `sh -c`,
// `bash -c` or `eval`, read as a line of its own.
//
// Whether a path is a repository's root is the one fact from outside; the
// verdict takes it as a predicate, and the model asks the `RepoRoots`
// contract (service.ts) about each path `repoCandidates` names.
import { Schema } from "effect"
import { basename, resolve, within } from "./path.ts"
import { expandWord, runningWords, SHELLS, shellScript, shortFlags, simpleCommands, type Word } from "./shell-line.ts"

/** The call may run. */
export const Allow = Schema.TaggedStruct("Allow", {})
export type Allow = typeof Allow.Type

/** The call would lose work for good; `reason` names the command and what to do instead. */
export const Deny = Schema.TaggedStruct("Deny", { reason: Schema.String })
export type Deny = typeof Deny.Type

export const Verdict = Schema.Union([Allow, Deny])
export type Verdict = typeof Verdict.Type

/** A shell call the guard refuses, with the words the model reads. */
export class Destructive extends Schema.TaggedError<Destructive>()("Destructive", {
  command: Schema.String,
  reason: Schema.String,
}) {}

/** What the model reads of a refusal, as the Claude Code hook words it. */
export const message = (reason: string): string => `guard-destructive: ${reason}.`

/** Where a line is read: the call's own directory, and the home. */
export interface Place {
  readonly cwd: string
  readonly home: string
}

/** What one simple command of a line asks of the verdict. */
type Finding =
  | { readonly _tag: "Refused"; readonly reason: string }
  /** A recursive `rm` of a path the rules pass, unless it is a repository's root. */
  | { readonly _tag: "RmTarget"; readonly command: string; readonly path: string }

const NARROWER = "name a narrower path"
const TRASH = "use `trash` on what you mean to remove"

/** How deep `sh -c` and `eval` are followed; a deeper line is not read. */
const MAX_DEPTH = 4

/**
 * Git's global options (`git [<option>…] <command>`), in two tables that together are every one
 * the installed git's manual lists; tests/git-options.test.ts checks both against that git,
 * running each option to see whether it takes the next word. The one reader of git's argv:
 * tests/git-repo.test.ts reads test code's git calls with it too.
 *
 * The options that take the next word as their value; each long one also takes `--opt=value` as one word.
 */
export const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--attr-source"])

/** The options that take no next word (some take `=value` in the same word: `--exec-path=`, `--list-cmds=`). */
export const GIT_BARE_OPTIONS: ReadonlySet<string> = new Set([
  "-v",
  "--version",
  "-h",
  "--help",
  "--exec-path",
  "--html-path",
  "--man-path",
  "--info-path",
  "-p",
  "--paginate",
  "-P",
  "--no-pager",
  "--bare",
  "--no-replace-objects",
  "--no-lazy-fetch",
  "--no-optional-locks",
  "--no-advice",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
  "--list-cmds",
])

/**
 * A git command's argv read past its global options:
 * - `command`: its subcommand (`""` when no word follows the options) and the words after it;
 * - `unreadable`: an option before the subcommand in neither table. Whether it takes the next
 *   word is unknown, so is the subcommand, and a reader fails closed on it rather than guess.
 */
export type GitArgv =
  | { readonly kind: "command"; readonly name: string; readonly rest: ReadonlyArray<string> }
  | { readonly kind: "unreadable"; readonly option: string }

export const gitSubcommand = (args: ReadonlyArray<string>): GitArgv => {
  const [word = "", ...after] = args
  if (!word.startsWith("-")) return { kind: "command", name: word, rest: after }
  const option = word.replace(/=.*/s, "")
  if (GIT_VALUE_OPTIONS.has(option) && option === word) return gitSubcommand(after.slice(1))
  if (GIT_VALUE_OPTIONS.has(option) || GIT_BARE_OPTIONS.has(option)) return gitSubcommand(after)
  return { kind: "unreadable", option: word }
}

/** Why a `git` command loses work for good: a hard reset, or a forced clean with `-d`, `-x` or `-X`; or why it cannot be read. */
const gitRefusal = (command: string, args: ReadonlyArray<string>): string | undefined => {
  const sub = gitSubcommand(args)
  if (sub.kind === "unreadable")
    return `\`${command}\` passes git \`${sub.option}\`, an option the guard does not know, so it cannot tell what git runs; spell the command without it`
  if (sub.name === "reset" && sub.rest.includes("--hard"))
    return `\`${command}\` discards uncommitted work; stash it (\`git stash -u\`) or commit first`
  if (sub.name !== "clean") return undefined
  const flags = shortFlags(sub.rest)
  const forced = flags.includes("f") || sub.rest.includes("--force")
  const wide = /[dxX]/.test(flags)
  const dry = flags.includes("n") || sub.rest.includes("--dry-run")
  if (!forced || !wide || dry) return undefined
  return `\`${command}\` deletes untracked files for good; run it with -n first and remove what you mean by path`
}

/** What a recursive `rm` asks: a refusal for a target the rules name, else each target to check for a repository. */
const rmFindings = (command: string, args: ReadonlyArray<Word>, runsIn: string, callCwd: string, home: string): ReadonlyArray<Finding> => {
  const texts = args.map((word) => word.text)
  const end = texts.indexOf("--")
  const options = end === -1 ? texts : texts.slice(0, end)
  const recursive = options.includes("--recursive") || /[rR]/.test(shortFlags(options))
  if (!recursive) return []
  const targets = args.filter((word, index) => (end === -1 ? !word.text.startsWith("-") : index > end || (index < end && !word.text.startsWith("-"))))
  const findings: Array<Finding> = []
  for (const word of targets) {
    const expanded = expandWord(word, home, runsIn)
    // `/*` is the root's files, `dir/*` the directory's, `*` the ones here.
    const glob = !word.singleQuoted && /(^|\/)\*$/.test(expanded)
    const path = resolve(runsIn, glob ? expanded.slice(0, -1) || "." : expanded)
    const refused = (reason: string) => findings.push({ _tag: "Refused", reason })
    if (path === "/") refused(`\`${command}\` would delete the root; ${NARROWER}`)
    else if (within(resolve("/", home), path)) refused(`\`${command}\` would delete your home; ${NARROWER}`)
    else if (within(runsIn, path) || within(callCwd, path)) refused(`\`${command}\` would delete the directory it runs in; ${TRASH}`)
    else if (basename(path) === ".git") refused(`\`${command}\` would delete a repository's history; ${TRASH}`)
    else findings.push({ _tag: "RmTarget", command, path })
  }
  return findings
}

/** One simple command of a line, where it runs. */
export interface PlacedCommand {
  /** The program's name, its path dropped (`/bin/rm` is `rm`); empty for a line of assignments alone. */
  readonly head: string
  readonly args: ReadonlyArray<Word>
  /** The command as the refusal names it: its running words, prefixes dropped. */
  readonly command: string
  /** The directory it runs in, absolute. */
  readonly runsIn: string
}

/**
 * Each simple command of `line` that runs, in order, with the directory it
 * runs in. A `cd` moves where the commands after it run (and is not listed);
 * the script of `sh -c` or `eval` follows its command, read as a line of its
 * own where it runs.
 */
export const placedCommands = (line: string, startsIn: string, home: string, depth = 0): ReadonlyArray<PlacedCommand> => {
  const placed: Array<PlacedCommand> = []
  let runsIn = startsIn
  for (const words of simpleCommands(line)) {
    const running = runningWords(words)
    const head = running[0]?.text.split("/").pop() ?? ""
    const args = running.slice(1)
    if (head === "cd") {
      const target = args[0]
      runsIn = target === undefined ? resolve("/", home) : resolve(runsIn, expandWord(target, home, runsIn))
      continue
    }
    placed.push({ head, args, command: running.map((word) => word.text).join(" "), runsIn })
    if (depth < MAX_DEPTH) {
      const script = SHELLS.has(head) ? shellScript(args) : head === "eval" ? args.map((word) => word.text).join(" ") : undefined
      if (script !== undefined) placed.push(...placedCommands(script, runsIn, home, depth + 1))
    }
  }
  return placed
}

/** What each simple command of `line` asks of the verdict, in order. */
const findingsOf = (line: string, place: Place): ReadonlyArray<Finding> => {
  const callCwd = resolve("/", place.cwd)
  const findings: Array<Finding> = []
  for (const { head, args, command, runsIn } of placedCommands(line, callCwd, place.home)) {
    if (head === "rm") findings.push(...rmFindings(command, args, runsIn, callCwd, place.home))
    if (head === "git") {
      const reason = gitRefusal(command, args.map((word) => word.text))
      if (reason !== undefined) findings.push({ _tag: "Refused", reason })
    }
  }
  return findings
}

/** The paths whose being a repository's root decides the verdict: every target of a recursive `rm` the other rules pass. */
export const repoCandidates = (command: string, place: Place): ReadonlyArray<string> => [
  ...new Set(findingsOf(command, place).flatMap((finding) => (finding._tag === "RmTarget" ? [finding.path] : []))),
]

/** The guard's verdict on a shell command run in `place.cwd`: the first simple command that loses work for good denies it. */
export const verdict = (command: string, place: Place & { readonly isRepoRoot: (path: string) => boolean }): Verdict => {
  for (const finding of findingsOf(command, place)) {
    if (finding._tag === "Refused") return Deny.make({ reason: finding.reason })
    if (place.isRepoRoot(finding.path))
      return Deny.make({ reason: `\`${finding.command}\` would delete the repository at ${finding.path}; the owner removes a repository` })
  }
  return Allow.make({})
}
