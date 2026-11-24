import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import type { Build, Record } from "../record.ts"
import { alreadyInstalled, builtForTree, configPaths, flagValue, notInstalledLine, refusals, settingsFor, STAGED_LINE, treeStage } from "./install.ts"

const HOST = { host: "bite-cristian", home: "/h", state: "/h/.local/state", checkout: "/h/dotfiles", fork: "/h/opencode", bun: "/h/.local/bin/bun", resident: "/h/.local/state/opencode-prime/resident", launcher: "/h/.local/bin/opencode" }
const VERSION = "2.3.0-prime.056a7066.1c82e080"
const TREE = `/h/.local/share/opencode-prime/opencode-${VERSION}.plugins`

describe("daily's part of the update", () => {
  test("reads the value of a flag, and none for a flag that is absent or has none", () => {
    expect(flagValue(["bun", "daily.ts", "--stage", "--fork-target", "abc"], "--fork-target")).toEqual(["abc"])
    expect(flagValue(["bun", "daily.ts", "--fork-target", "--stage"], "--fork-target")).toEqual([])
    expect(flagValue(["bun", "daily.ts"], "--fork-target")).toEqual([])
  })

  test("writes the host's settings: full paths, and no way to move the checkout", () => {
    const settings = settingsFor(HOST)
    expect(settings).not.toHaveProperty("mode")
    expect(settings.record).toBe("/h/.local/state/opencode/installed.json")
    expect(settings.notice).toBe("/h/.local/state/opencode-daily/upstream.json")
    expect(settings.config).toEqual(["/h/.config/opencode/opencode.json", "/h/.config/opencode/cli.json"])
    expect(settings.state).toBe("/h/.local/state/opencode-update")
  })

  test("reads the server config, the first of the configs, by what the live checkout owned in it", () => {
    const paths = configPaths(settingsFor(HOST), HOST.home)
    expect(paths.server).toBe("/h/.config/opencode/opencode.json")
    expect(paths.owned.dirs).toEqual(["/h/dotfiles/opencode/mods", "/h/dotfiles/opencode/cmd", "/h/.local/share/opencode-prime/anthropic-auth"])
  })

  test("daily's staged line says what the handoff does: it moves no checkout and writes no config", () => {
    expect(STAGED_LINE).toContain("no checkout moves and no config is written")
    expect(STAGED_LINE).not.toContain("writes the configs")
  })

  test("daily by hand says it installs the commit, never the edits as they stand, and how many files under opencode/ differ", () => {
    expect(notInstalledLine("c".repeat(40), 0)).toBe(`daily: installing commit ${"c".repeat(10)}; uncommitted edits in this checkout are not installed (to run them: bun run verify:launch)`)
    expect(notInstalledLine("c".repeat(40), 3)).toBe(`${notInstalledLine("c".repeat(40), 0)}; 3 files under opencode/ differ from it`)
  })

  test("daily by hand builds nothing only for the build the record installs, proven, with its tree standing", () => {
    const build = (version: string): Build => ({ version, command: [`/s/opencode-${version}`], dotfiles: "d".repeat(40), fork: "f".repeat(40) })
    const [installedBuild, other] = [build("2.3.0-prime.aaaaaaaa.bbbbbbbb.tree"), build("2.3.0-prime.aaaaaaaa.cccccccc.tree")]
    const record = (installed: typeof installedBuild, good: typeof installedBuild): Option.Option<Record> => Option.some({ ...installed, good })
    expect(alreadyInstalled(record(installedBuild, installedBuild), installedBuild.version, true)).toBe(true)
    // Its tree gone, unproven, another build installed, or no record: it builds (and its stage never removes a tree that stood).
    expect(alreadyInstalled(record(installedBuild, installedBuild), installedBuild.version, false)).toBe(false)
    expect(alreadyInstalled(record(installedBuild, other), installedBuild.version, true)).toBe(false)
    expect(alreadyInstalled(record(other, installedBuild), installedBuild.version, true)).toBe(false)
    expect(alreadyInstalled(Option.none(), installedBuild.version, true)).toBe(false)
  })
})

describe("what daily is asked to do", () => {
  test("with neither --stage nor --from-tree, it installs by hand", () => {
    const from = treeStage("/h/dotfiles/opencode", false, false, [])
    expect([from, refusals(from), builtForTree(from, VERSION)]).toEqual([{ kind: "hand" }, [], []])
  })

  test("a stage is only ever from a build's tree: --stage or --from-tree alone is refused", () => {
    for (const [stage, flagged] of [
      [true, false],
      [false, true],
    ] as const)
      expect(refusals(treeStage(`${TREE}/opencode`, stage, flagged, ["d".repeat(40)]))).toEqual(["daily stages only from a build's tree (--stage --from-tree, as the update runs it); by hand it takes neither flag"])
  })

  test("from a tree it names the tree's build, and stages only the version the tree was made for", () => {
    const from = treeStage(`${TREE}/opencode`, true, true, ["d".repeat(40)])
    expect([from, refusals(from)]).toEqual([{ kind: "tree", build: `opencode-${VERSION}` }, []])
    expect(builtForTree(from, VERSION)).toEqual([])
    expect(builtForTree(from, "2.3.0-prime.056a7066.ffffffff")).toEqual([`daily built 2.3.0-prime.056a7066.ffffffff, but runs from the tree of opencode-${VERSION}: nothing staged`])
  })

  test("refuses a root that is no tree's opencode/, or a stage that names no dotfiles commit", () => {
    expect(refusals(treeStage("/h/dotfiles/opencode", true, true, ["d".repeat(40)]))).toEqual(["daily --from-tree runs from a build's tree (<share>/opencode-<version>.plugins/opencode), not /h/dotfiles/opencode"])
    expect(refusals(treeStage(`${TREE}/cmd`, true, true, ["d".repeat(40)]))).toHaveLength(1)
    expect(refusals(treeStage(`${TREE}/opencode`, true, true, []))).toEqual(["daily --from-tree needs --dotfiles-target: a tree has no git to read the dotfiles commit from"])
  })
})
