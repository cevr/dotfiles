import { Array as Arr, Option } from "effect"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"
import { gitInit } from "./git-repo.ts"
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

/** The manual's text: git.1, or git.1.gz as Debian ships it; empty when neither is installed. */
const manual = (): string => {
  const page = join(execFileSync("git", ["--man-path"], { encoding: "utf8" }).trim(), "man1", "git.1")
  const plain = Arr.filter([page], existsSync).map((path) => readFileSync(path, "utf8"))
  const zipped = Arr.filter([`${page}.gz`], existsSync).map((path) => new TextDecoder().decode(gunzipSync(readFileSync(path))))
  return [...plain, ...zipped].join("")
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

/** The installed git's own commands, built in or from its exec path, as git lists them (`git --list-cmds=main`). */
export const gitCommands = (): ReadonlyArray<string> =>
  execFileSync("git", ["--list-cmds=main"], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line !== "")

/** Values tried for an option that may take one; each is one a valued global option accepts in a repository. */
const VALUES = [".", "core.probe=1", "core.probe=HOME", "HEAD"]

/** Whether the installed git ran its `version` command for `git <args>` in `cwd`, with no pager, prompt or global config. */
const ranVersion = (cwd: string, args: ReadonlyArray<string>) =>
  spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
    env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  }).stdout.startsWith("git version ")

/**
 * Options not run with `version` after them: help opens a manual, and `-v`/`--version` print the
 * version themselves. None takes a value.
 */
const NOT_PROBED = new Set(["-h", "--help", "-v", "--version"])

/** The installed git's global options, and which take a value, probed in a scratch repository. */
export const gitGlobalOptions = (): GitGlobalOptions => {
  const all = manualOptions(manual())
  using dir = scratch("git-options-")
  gitInit(dir.path, ["-q"])
  const probed = all.filter((option) => !NOT_PROBED.has(option))
  const passing = probed.filter((option) => ranVersion(dir.path, [option, "version"]))
  const valued = probed.filter((option) => !passing.includes(option) && VALUES.some((value) => ranVersion(dir.path, [option, value, "version"])))
  return { all, valued, passing }
}
