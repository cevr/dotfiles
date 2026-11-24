import { Array as Arr, Option } from "effect"
import { initScratchGit, installedGitManual, scratchGitVersion } from "./scratch-child.ts"
import { scratch } from "./scratch.ts"

/**
 * The installed git's global options (`git [<option>…] <command>`), read from git itself rather
 * than a copy, so the guard's tables of them (mods/guard/verdict.ts) can be checked against the
 * git that runs:
 * - the names come from its manual's OPTIONS section (`git --man-path`/man1/git.1, or .gz);
 * - whether each takes the next word as its value comes from running it: `git <opt> version`
 *   runs `version` when the option takes no value, and `git <opt> <value> version` does when it does.
 */
export interface GitGlobalOptions {
  /** Every option the manual lists, short and long, as git spells it (`-C`, `--attr-source`); none when no manual is installed. */
  readonly all: ReadonlyArray<string>
  /** Those that take the next word as their value. */
  readonly valued: ReadonlyArray<string>
  /** Those that take no value and after which git goes on to run the command (`--exec-path`, `--help` end the run). */
  readonly passing: ReadonlyArray<string>
}

/**
 * The options the manual's OPTIONS section names, from each item's head line (`\-C <path>`,
 * `\-p, \-\-paginate`, `\-\-attr\-source=<tree\-ish>`): the words before any value. None when
 * the text has no OPTIONS section.
 */
export const manualOptions = (text: string): ReadonlyArray<string> => {
  const start = text.indexOf('.SH "OPTIONS"')
  const end = text.indexOf(".SH ", start + 1)
  const lines = Arr.filter([text.slice(start, end)], () => start >= 0 && end > start).flatMap((section) => section.split("\n"))
  const heads = lines.flatMap((line, index) => Arr.filter(lines.slice(index + 1, index + 2), () => line === ".PP"))
  const names = heads.flatMap((head) =>
    head
      .replaceAll("\\-", "-")
      .split(", ")
      .flatMap((part) => Option.toArray(Arr.head(part.match(/^-{1,2}[A-Za-z][A-Za-z-]*/) ?? []))),
  )
  return Arr.dedupe(names)
}

/** Values tried for an option that may take one; each is one a valued global option accepts in a repository. */
const VALUES = [".", "core.probe=1", "core.probe=HOME", "HEAD"]

/**
 * Options not run with `version` after them: help opens a manual, and `-v`/`--version` print the
 * version themselves. None takes a value.
 */
const NOT_PROBED = new Set(["-h", "--help", "-v", "--version"])

/** The installed git's global options, and which take a value, probed in a scratch repository. */
export const gitGlobalOptions = (): GitGlobalOptions => {
  using dir = scratch("git-options-")
  const all = manualOptions(installedGitManual(dir.path))
  initScratchGit(dir.path, ["-q"])
  const probed = all.filter((option) => !NOT_PROBED.has(option))
  const passing = probed.filter((option) => scratchGitVersion(dir.path, option))
  const valued = probed.filter((option) => !passing.includes(option) && VALUES.some((value) => scratchGitVersion(dir.path, option, value)))
  return { all, valued, passing }
}
