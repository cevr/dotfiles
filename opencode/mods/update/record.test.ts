import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { type Build, goodOf, nextRecord, parseRecord, promoted, proven, type Record, recordText, rolledBack, stagedOf, stagedRecord } from "./record.ts"

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

  test("a dotfiles-only target keeps the version, and still rolls back to the good dotfiles commit", () => {
    const first = proven(nextRecord(Option.none(), build("aaaaaaaa", "d1", "f1"), []))
    const failed = nextRecord(Option.some(first), build("aaaaaaaa", "d2", "f1"), [])
    expect(Option.map(rolledBack(failed), (record) => record.dotfiles)).toEqual(Option.some("d1"))
  })

  test("M1: a staged build waits beside the running one; the handoff installs it, and only its proof makes it good", () => {
    const running = proven(nextRecord(Option.none(), build("aaaaaaaa", "d1", "f1"), []))
    const staged = stagedRecord(Option.some(running), build("bbbbbbbb", "d2", "f2"), ["opencode-2.2.7-prime.aaaaaaaa", "opencode-2.2.6-prime.cccccccc", "opencode-2.2.7-prime.bbbbbbbb"])
    expect([staged.version, staged.dotfiles, staged.good, staged.staged, staged.previous]).toEqual([
      "2.2.7-prime.aaaaaaaa",
      "d1",
      build("aaaaaaaa", "d1", "f1"),
      build("bbbbbbbb", "d2", "f2"),
      ["2.2.6-prime.cccccccc"],
    ])
    expect(stagedOf(staged)).toEqual(Option.some(build("bbbbbbbb", "d2", "f2")))
    const installed = promoted(staged)
    expect([installed.version, installed.dotfiles, installed.good, stagedOf(installed), installed.previous]).toEqual([
      "2.2.7-prime.bbbbbbbb",
      "d2",
      build("aaaaaaaa", "d1", "f1"),
      Option.none(),
      ["2.2.6-prime.cccccccc", "2.2.7-prime.aaaaaaaa"],
    ])
    expect(promoted(installed)).toEqual(installed)
    expect(parseRecord(recordText(staged))).toEqual(Option.some(staged))
  })

  test("a first install by hand names its build installed and staged, with no good build yet", () => {
    const first = stagedRecord(Option.none(), build("aaaaaaaa"), [])
    expect([first.version, goodOf(first), stagedOf(first)]).toEqual(["2.2.7-prime.aaaaaaaa", Option.none(), Option.some(build("aaaaaaaa"))])
  })

  test("there is no rollback without a good build, or when the good build is the one that failed", () => {
    expect(rolledBack(nextRecord(Option.none(), build("aaaaaaaa"), []))).toEqual(Option.none())
    expect(rolledBack(proven(nextRecord(Option.none(), build("aaaaaaaa"), [])))).toEqual(Option.none())
  })
})
