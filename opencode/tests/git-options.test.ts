// The guard's tables of git's global options (mods/guard/verdict.ts), checked against the git
// installed here rather than a copy: every option its manual lists is in one table, and the
// value-taking table is exactly the options that git, run, makes take the next word. A git that
// adds an option the tables lack (as 2.56's --attr-source was) fails this test; until then both
// readers fail closed on it.
import { describe, expect, test } from "bun:test"
import { GIT_BARE_OPTIONS, GIT_VALUE_OPTIONS } from "../mods/guard/verdict.ts"
import { gitGlobalOptions, manualOptions } from "./git-options.ts"

/** Running git once or a few times per option, in a scratch repository: a loaded machine gets room. */
const PROBE_MS = 60_000

describe("the guard's git global options", () => {
  test(
    "are every option the installed git's manual lists, and take the next word exactly when git does",
    () => {
      const git = gitGlobalOptions()
      const known = new Set([...GIT_VALUE_OPTIONS, ...GIT_BARE_OPTIONS])
      // No manual, no options: the check cannot pass on nothing read.
      expect(git.all).toContain("-C")
      expect({
        missing: git.all.filter((option) => !known.has(option)),
        valued: [...git.valued].sort(),
        both: [...GIT_VALUE_OPTIONS].filter((option) => GIT_BARE_OPTIONS.has(option)),
      }).toEqual({ missing: [], valued: [...GIT_VALUE_OPTIONS].filter((option) => git.all.includes(option)).sort(), both: [] })
    },
    PROBE_MS,
  )

  test("the manual's option items are read as git spells them, a value's placeholder dropped", () => {
    const page = [
      '.SH "OPTIONS"',
      ".PP",
      "\\-v, \\-\\-version",
      ".RS 4",
      "Prints the Git suite version\\&.",
      ".PP",
      "\\-C <path>",
      ".PP",
      "\\-\\-attr\\-source=<tree\\-ish>",
      ".PP",
      "\\-\\-list\\-cmds=<group>[,<group>\\&...\\:]",
      '.SH "GIT COMMANDS"',
      ".PP",
      "\\-\\-not\\-an\\-option",
    ].join("\n")
    expect(manualOptions(page)).toEqual(["-v", "--version", "-C", "--attr-source", "--list-cmds"])
    expect(manualOptions("no manual")).toEqual([])
  })
})
