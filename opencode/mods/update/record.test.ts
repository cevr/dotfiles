import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { type Build, nextRecord, parseRecord, proven, type Record, recordText, rolledBack } from "./record.ts"

const build = (commit: string, dotfiles = "d1", fork = "f1"): Build => ({ version: `2.2.7-prime.${commit}`, command: [`/s/opencode-2.2.7-prime.${commit}`], dotfiles, fork })

describe("the installed build's record", () => {
  test("names the new build, its commits and every build it superseded, never itself", () => {
    const last: Record = { version: "2.2.7-prime.bbbbbbbb", command: ["/s/opencode-2.2.7-prime.bbbbbbbb"], previous: ["2.2.5-prime.aaaaaaaa"] }
    const record = nextRecord(Option.some(last), build("cccccccc"), ["opencode-2.2.6-prime.dddddddd", "opencode-2.2.7-prime.cccccccc", "anthropic-auth", "opencode-2.2.7-prime.bbbbbbbb"])
    expect(record).toEqual({
      version: "2.2.7-prime.cccccccc",
      command: ["/s/opencode-2.2.7-prime.cccccccc"],
      previous: ["2.2.5-prime.aaaaaaaa", "2.2.7-prime.bbbbbbbb", "2.2.6-prime.dddddddd"],
      dotfiles: "d1",
      fork: "f1",
    })
  })

  test("starts from the builds installed beside it when there is no record yet", () => {
    expect(nextRecord(Option.none(), build("cccccccc"), ["opencode-2.2.7"]).previous).toEqual(["2.2.7"])
  })

  test("reads back what it writes, and the fork's reader keeps its own keys", () => {
    const record = proven(nextRecord(Option.none(), build("cccccccc"), []))
    const read = parseRecord(recordText(record))
    expect(read).toEqual(Option.some(record))
    expect(parseRecord("{ not json")).toEqual(Option.none())
    expect(parseRecord(`{"version":"2.2.7","command":["/s/x"],"previous":["2.2.6"]}`)).toEqual(Option.some({ version: "2.2.7", command: ["/s/x"], previous: ["2.2.6"] }))
  })

  test("a new build is not good until its health check proves it; the last good build rides along", () => {
    const first = proven(nextRecord(Option.none(), build("aaaaaaaa", "d1", "f1"), []))
    expect(first.good).toEqual(build("aaaaaaaa", "d1", "f1"))
    const second = nextRecord(Option.some(first), build("bbbbbbbb", "d2", "f2"), [])
    expect(second.good).toEqual(build("aaaaaaaa", "d1", "f1"))
    expect(proven(second).good).toEqual(build("bbbbbbbb", "d2", "f2"))
  })

  test("a rollback installs the good build again, with the failed one superseded so its TUIs follow", () => {
    const first = proven(nextRecord(Option.none(), build("aaaaaaaa", "d1", "f1"), []))
    const failed = nextRecord(Option.some(first), build("bbbbbbbb", "d2", "f2"), [])
    const back = rolledBack(failed)
    expect(Option.map(back, (record) => [record.version, record.dotfiles, record.fork])).toEqual(Option.some(["2.2.7-prime.aaaaaaaa", "d1", "f1"]))
    expect(Option.map(back, (record) => record.previous)).toEqual(Option.some(["2.2.7-prime.bbbbbbbb"]))
    expect(Option.map(back, (record) => record.good)).toEqual(Option.some(build("aaaaaaaa", "d1", "f1")))
  })

  test("there is no rollback without a good build, or when the good build is the one that failed", () => {
    expect(rolledBack(nextRecord(Option.none(), build("aaaaaaaa"), []))).toEqual(Option.none())
    expect(rolledBack(proven(nextRecord(Option.none(), build("aaaaaaaa"), [])))).toEqual(Option.none())
  })
})
