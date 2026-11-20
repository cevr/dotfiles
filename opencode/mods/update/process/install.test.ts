import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { type Build, nextRecord, proven, recordText, stagedRecord } from "../record.ts"
import { builtForTree, configPaths, flagValue, programForHand, refusals, settingsFor, treeStage } from "./install.ts"

const HOST = { host: "bite-cristian", home: "/h", state: "/h/.local/state", checkout: "/h/dotfiles", fork: "/h/opencode", bun: "/h/.local/bin/bun", resident: "/h/.local/state/opencode-prime/resident", launcher: "/h/.local/bin/opencode" }
const VERSION = "2.3.0-prime.056a7066.1c82e080"
const TREE = `/h/.local/share/opencode-prime/opencode-${VERSION}.plugins`

describe("daily's part of the update", () => {
  test("reads the value of a flag, and none for a flag that is absent or has none", () => {
    expect(flagValue(["bun", "daily.ts", "--stage", "--fork-target", "abc"], "--fork-target")).toEqual(["abc"])
    expect(flagValue(["bun", "daily.ts", "--fork-target", "--stage"], "--fork-target")).toEqual([])
    expect(flagValue(["bun", "daily.ts"], "--fork-target")).toEqual([])
  })

  test("writes the host's settings: full paths, and a Syncthing follower moves its checkout by reset", () => {
    const settings = settingsFor(HOST)
    expect(settings.mode).toBe("reset")
    expect(settingsFor({ ...HOST, host: "Cristians-MacBook-Pro.local" }).mode).toBe("ff")
    expect(settings.record).toBe("/h/.local/state/opencode/installed.json")
    expect(settings.notice).toBe("/h/.local/state/opencode-daily/upstream.json")
    expect(settings.config).toEqual(["/h/.config/opencode/opencode.json", "/h/.config/opencode/cli.json"])
    expect(settings.state).toBe("/h/.local/state/opencode-update")
  })

  test("strips the server config, the first of the configs, by what the live checkout owns in it", () => {
    const paths = configPaths(settingsFor(HOST), HOST.home)
    expect(paths.server).toBe("/h/.config/opencode/opencode.json")
    expect(paths.owned.dirs).toEqual(["/h/dotfiles/opencode/mods", "/h/dotfiles/opencode/cmd", "/h/.local/share/opencode-prime/anthropic-auth"])
  })
})

describe("daily's stage from a build's tree", () => {
  test("without --from-tree it stages from the checkout, as before", () => {
    const from = treeStage("/h/dotfiles/opencode", false, [])
    expect([from, refusals(from), builtForTree(from, VERSION)]).toEqual([{ kind: "checkout" }, [], []])
  })

  test("from a tree it names the tree's build, and stages only the version the tree was made for", () => {
    const from = treeStage(`${TREE}/opencode`, true, ["d".repeat(40)])
    expect([from, refusals(from)]).toEqual([{ kind: "tree", build: `opencode-${VERSION}` }, []])
    expect(builtForTree(from, VERSION)).toEqual([])
    expect(builtForTree(from, "2.3.0-prime.056a7066.ffffffff")).toEqual([`daily built 2.3.0-prime.056a7066.ffffffff, but runs from the tree of opencode-${VERSION}: nothing staged`])
  })

  test("refuses a root that is no tree's opencode/, or a stage that names no dotfiles commit", () => {
    expect(refusals(treeStage("/h/dotfiles/opencode", true, ["d".repeat(40)]))).toEqual(["daily --from-tree runs from a build's tree (<share>/opencode-<version>.plugins/opencode), not /h/dotfiles/opencode"])
    expect(refusals(treeStage(`${TREE}/cmd`, true, ["d".repeat(40)]))).toHaveLength(1)
    expect(refusals(treeStage(`${TREE}/opencode`, true, []))).toEqual(["daily --from-tree needs --dotfiles-target: a tree has no git to read the dotfiles commit from"])
  })
})

describe("the handoff daily by hand runs", () => {
  const settings = settingsFor(HOST)
  const build: Build = { version: VERSION, command: [`/h/.local/share/opencode-prime/opencode-${VERSION}`], dotfiles: "d".repeat(40), fork: "f".repeat(40) }
  const old = proven({ version: "2.2.9-prime.aaaaaaaa", command: ["/h/.local/share/opencode-prime/opencode-2.2.9-prime.aaaaaaaa"], dotfiles: "a".repeat(40), fork: "a".repeat(40) })
  const read = (text: string) => () => text

  test("is the next build's own, from its tree, when the tree has one: the staged build's, else the installed one's", () => {
    const tree = { path: `${TREE}/opencode/cmd/update/handoff.ts`, cwd: `${TREE}/opencode` }
    const there = (path: string) => path === tree.path
    expect(programForHand(settings, read(recordText(stagedRecord(Option.some(old), build, []))), there)).toEqual(tree)
    expect(programForHand(settings, read(recordText(nextRecord(Option.some(old), build, []))), there)).toEqual(tree)
  })

  test("is the live checkout's for a build with no tree, or with no record that reads", () => {
    const checkout = { path: "/h/dotfiles/opencode/cmd/update/handoff.ts", cwd: "/h/dotfiles" }
    expect(programForHand(settings, read(recordText(stagedRecord(Option.some(old), build, []))), () => false)).toEqual(checkout)
    expect(programForHand(settings, read("not a record"), () => true)).toEqual(checkout)
  })
})
