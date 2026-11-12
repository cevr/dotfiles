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
 * Git's own commands: those it runs itself, built in or from its exec path (`git --list-cmds=main`,
 * git 2.56; the workbox's 2.55 lists a subset). An alias never hides one of them, so a subcommand
 * here runs what its name says; any other (an alias, a `git-*` add-on on the PATH) could run
 * anything. tests/git-options.test.ts checks the installed git lists no command this lacks.
 */
export const GIT_COMMANDS: ReadonlySet<string> = new Set([
  "add", "am", "annotate", "apply", "archimport", "archive", "backfill", "bisect", "blame", "branch",
  "bugreport", "bundle", "cat-file", "check-attr", "check-ignore", "check-mailmap", "check-ref-format",
  "checkout", "checkout--worker", "checkout-index", "cherry", "cherry-pick", "clean", "clone", "column",
  "commit", "commit-graph", "commit-tree", "config", "count-objects", "credential", "credential-cache",
  "credential-cache--daemon", "credential-netrc", "credential-osxkeychain", "credential-store",
  "cvsexportcommit", "cvsimport", "cvsserver", "daemon", "describe", "diagnose", "diff", "diff-files",
  "diff-index", "diff-pairs", "diff-tree", "difftool", "difftool--helper", "fast-export", "fast-import",
  "fetch", "fetch-pack", "filter-branch", "fmt-merge-msg", "for-each-ref", "for-each-repo", "format-patch",
  "format-rev", "fsck", "fsck-objects", "fsmonitor--daemon", "gc", "get-tar-commit-id", "grep", "hash-object",
  "help", "history", "hook", "http-backend", "http-fetch", "http-push", "imap-send", "index-pack", "init",
  "init-db", "instaweb", "interpret-trailers", "jump", "last-modified", "log", "ls-files", "ls-remote",
  "ls-tree", "mailinfo", "mailsplit", "maintenance", "merge", "merge-base", "merge-file", "merge-index",
  "merge-octopus", "merge-one-file", "merge-ours", "merge-recursive", "merge-recursive-ours",
  "merge-recursive-theirs", "merge-resolve", "merge-subtree", "merge-tree", "mergetool", "mktag", "mktree",
  "multi-pack-index", "mv", "name-rev", "notes", "p4", "pack-objects", "pack-redundant", "pack-refs",
  "patch-id", "pickaxe", "prune", "prune-packed", "pull", "push", "quiltimport", "range-diff", "read-tree",
  "rebase", "receive-pack", "reflog", "refs", "remote", "remote-ext", "remote-fd", "remote-ftp", "remote-ftps",
  "remote-http", "remote-https", "repack", "replace", "replay", "repo", "request-pull", "rerere", "reset",
  "restore", "rev-list", "rev-parse", "revert", "rm", "send-email", "send-pack", "sh-i18n--envsubst", "shell",
  "shortlog", "show", "show-branch", "show-index", "show-ref", "sparse-checkout", "stage", "stash", "status",
  "stripspace", "submodule", "submodule--helper", "subtree", "switch", "symbolic-ref", "tag", "unpack-file",
  "unpack-objects", "update-index", "update-ref", "update-server-info", "upload-archive",
  "upload-archive--writer", "upload-pack", "url-parse", "var", "verify-commit", "verify-pack", "verify-tag",
  "version", "web--browse", "whatchanged", "worktree", "write-tree",
])

/**
 * Why a git argv cannot be read, so a reader fails closed on it rather than guess:
 * - `option`: an option before the subcommand in neither options table; whether it takes the
 *   next word is unknown, so is the subcommand;
 * - `alias`: a `-c` or `--config-env` setting that defines an alias (`alias.<name>`);
 * - `command`: a subcommand that is not one of git's own (GIT_COMMANDS): an alias or an add-on,
 *   whose meaning is not in its name.
 */
export type Unreadable = "option" | "alias" | "command"

/**
 * A git command's argv read past its global options:
 * - `command`: its subcommand (`""` when no word follows the options) and the words after it;
 * - `unreadable`: the word that makes it unreadable, and why.
 */
export type GitArgv =
  | { readonly kind: "command"; readonly name: string; readonly rest: ReadonlyArray<string> }
  | { readonly kind: "unreadable"; readonly why: Unreadable; readonly word: string }

/** Whether a config setting `<key>=<value>` (or `<key>=<envvar>`) defines an alias: its section, case-insensitive, is `alias`. */
const definesAlias = (setting: string) => setting.toLowerCase().startsWith("alias.")

/** The options whose value is a config setting. */
const CONFIG_OPTIONS: ReadonlySet<string> = new Set(["-c", "--config-env"])

/**
 * An option word as its name and the value it would take: a long option's `--name=value` in the
 * one word (`joined`), else the next word. Only a long option joins; git reads `-c=x` as no option it knows.
 */
const optionParts = (word: string, next: string) => {
  const at = word.indexOf("=")
  if (!word.startsWith("--") || at < 0) return { option: word, value: next, joined: false }
  return { option: word.slice(0, at), value: word.slice(at + 1), joined: true }
}

export const gitSubcommand = (args: ReadonlyArray<string>): GitArgv => {
  const [word = "", ...after] = args
  const [next = ""] = after
  if (word === "" || (!word.startsWith("-") && GIT_COMMANDS.has(word))) return { kind: "command", name: word, rest: after }
  if (!word.startsWith("-")) return { kind: "unreadable", why: "command", word }
  const { option, value, joined } = optionParts(word, next)
  if (CONFIG_OPTIONS.has(option) && definesAlias(value)) return { kind: "unreadable", why: "alias", word: value }
  if (GIT_VALUE_OPTIONS.has(option) && !joined) return gitSubcommand(after.slice(1))
  if (GIT_VALUE_OPTIONS.has(option) || GIT_BARE_OPTIONS.has(option)) return gitSubcommand(after)
  return { kind: "unreadable", why: "option", word }
}

/** Why a reader cannot tell what `command` makes git run, for each way its argv is unreadable. */
const UNREADABLE = {
  option: (command, word) => `\`${command}\` passes git \`${word}\`, an option the guard does not know, so it cannot tell what git runs; spell the command without it`,
  alias: (command, word) => `\`${command}\` defines a git alias (\`${word}\`), so the guard cannot tell what git runs; spell the git command out`,
  command: (command, word) =>
    `\`${command}\` runs \`${word}\`, which is not one of git's own commands (an alias or an add-on), so the guard cannot tell what it does; spell the git command out`,
} satisfies { readonly [Why in Unreadable]: (command: string, word: string) => string }

/** Why a `git` command loses work for good: a hard reset, or a forced clean with `-d`, `-x` or `-X`; or why it cannot be read. */
const gitRefusal = (command: string, args: ReadonlyArray<string>): string | undefined => {
  const sub = gitSubcommand(args)
  if (sub.kind === "unreadable") return UNREADABLE[sub.why](command, sub.word)
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

/**
 * What each simple command of `line` asks of the verdict, in order. A `cd`
 * moves where the commands after it run; `sh -c` and `eval` are read as
 * lines of their own, where they run.
 */
const scan = (line: string, callCwd: string, startsIn: string, home: string, depth: number): ReadonlyArray<Finding> => {
  const findings: Array<Finding> = []
  let runsIn = startsIn
  for (const words of simpleCommands(line)) {
    const running = runningWords(words)
    const head = running[0]?.text.split("/").pop()
    const args = running.slice(1)
    const command = running.map((word) => word.text).join(" ")
    if (head === "cd") {
      const target = args[0]
      runsIn = target === undefined ? resolve("/", home) : resolve(runsIn, expandWord(target, home, runsIn))
      continue
    }
    if (head === "rm") findings.push(...rmFindings(command, args, runsIn, callCwd, home))
    if (head === "git") {
      const reason = gitRefusal(command, args.map((word) => word.text))
      if (reason !== undefined) findings.push({ _tag: "Refused", reason })
    }
    if (depth < MAX_DEPTH) {
      const script = head !== undefined && SHELLS.has(head) ? shellScript(args) : head === "eval" ? args.map((word) => word.text).join(" ") : undefined
      if (script !== undefined) findings.push(...scan(script, callCwd, runsIn, home, depth + 1))
    }
  }
  return findings
}

const findingsOf = (command: string, place: Place) => scan(command, resolve("/", place.cwd), resolve("/", place.cwd), place.home, 0)

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
