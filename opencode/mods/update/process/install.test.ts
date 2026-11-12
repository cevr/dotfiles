import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { parseRecord } from "../record.ts"
import { flagValue, settingsFor, stagedText } from "./install.ts"

const HOST = { host: "bite-cristian", home: "/h", state: "/h/.local/state", checkout: "/h/dotfiles", fork: "/h/opencode", bun: "/h/.local/bin/bun", resident: "/h/.local/state/opencode-prime/resident", launcher: "/h/.local/bin/opencode" }

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

  test("stages the build in the record over the last one's text, empty when there was none; the running build stays installed", () => {
    const build = { version: "2.2.7-prime.bbbbbbbb", command: ["/s/b"] as const, dotfiles: "d2", fork: "f2" }
    const first = stagedText("", build, ["opencode-2.2.7-prime.aaaaaaaa"])
    expect(Option.map(parseRecord(first), (record) => [record.version, record.previous, record.staged?.version])).toEqual(Option.some([build.version, ["2.2.7-prime.aaaaaaaa"], build.version]))
    const next = stagedText(first, { ...build, version: "2.2.7-prime.cccccccc", command: ["/s/c"] }, [])
    expect(Option.map(parseRecord(next), (record) => [record.version, record.dotfiles, record.staged?.version])).toEqual(Option.some(["2.2.7-prime.bbbbbbbb", "d2", "2.2.7-prime.cccccccc"]))
  })
})
