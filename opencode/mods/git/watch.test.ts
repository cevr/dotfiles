// The PrWatch aggregate's stories: a watch starts from a read and refuses
// what already holds; each later read is silent, Seen or Noticed by what the
// watch waits for; it ends once that came or the request merged. Then the
// notice and list text a session reads.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as Story from "@dotfiles/decider/story"
import {
  AlreadyThere,
  Noticed,
  noticeText,
  noticeTitle,
  Observe,
  PrWatch,
  Seen,
  Start,
  Stop,
  type Summary,
  Unwatched,
  type Until,
  type Watch,
  Watched,
  watchLine,
} from "./watch.ts"

const story = Story.make(PrWatch)
const run = (...steps: Parameters<typeof story>) => Effect.runPromise(story(...steps))

const T = 1_800_000_000_000
const READ: Summary = {
  title: "Add the pr tool",
  url: "https://github.com/cevr/dotfiles/pull/7",
  state: "OPEN",
  head: "aaaaaaaa11",
  verdict: "pending",
  failing: [],
  reviews: [],
  threads: 0,
  mergeable: "MERGEABLE",
}
const read = (fields: Partial<Summary>): Summary => ({ ...READ, ...fields })
const watchOf = (until: Until, note?: string): Watch => ({
  sessionID: "ses_1",
  repo: "cevr/dotfiles",
  number: 7,
  until,
  ...(note === undefined ? {} : { note }),
  since: T,
  last: READ,
})
const start = (until: Until, at: Summary = READ) => Start.make({ sessionID: "ses_1", repo: "cevr/dotfiles", number: 7, until, read: at })

describe("starting a watch", () => {
  test("records the read it starts from", () =>
    run(Story.clock(T), Story.when(start("green")), Story.then(Watched.make({ watch: watchOf("green") })), Story.state(watchOf("green"))))

  test("refuses green when the checks pass already", () =>
    run(Story.when(start("green", read({ verdict: "pass" }))), Story.rejected(new AlreadyThere({ ref: "cevr/dotfiles#7", reason: "its checks pass" }))))

  test("refuses any watch on a merged request", () =>
    run(Story.when(start("changed", read({ state: "MERGED" }))), Story.rejected(new AlreadyThere({ ref: "cevr/dotfiles#7", reason: "it is merged" }))))

  test("stop ends it, and stopping no watch records nothing", () =>
    run(
      Story.given(Watched.make({ watch: watchOf("green") })),
      Story.when(Stop.make({})),
      Story.then(Unwatched.make({})),
      Story.state(undefined),
      Story.when(Stop.make({})),
      Story.then(),
    ))
})

describe("a read of a watched request", () => {
  test("the same read is silent", () =>
    run(Story.given(Watched.make({ watch: watchOf("green") })), Story.when(Observe.make({ read: READ })), Story.then()))

  test("green: a new head is Seen, not told", () =>
    run(
      Story.given(Watched.make({ watch: watchOf("green") })),
      Story.when(Observe.make({ read: read({ head: "bbbbbbbb22" }) })),
      Story.then(Seen.make({ last: read({ head: "bbbbbbbb22" }) })),
    ))

  test("green: passing checks end the watch", () =>
    run(
      Story.given(Watched.make({ watch: watchOf("green") })),
      Story.when(Observe.make({ read: read({ verdict: "pass" }) })),
      Story.then(Noticed.make({ last: read({ verdict: "pass" }), lines: ["checks pending → pass"], ended: true })),
      Story.state(undefined),
    ))

  test("green: failing checks are told and the watch goes on; a new failure is told again", () =>
    run(
      Story.given(Watched.make({ watch: watchOf("green") })),
      Story.when(Observe.make({ read: read({ verdict: "fail", failing: ["test"] }) })),
      Story.then(Noticed.make({ last: read({ verdict: "fail", failing: ["test"] }), lines: ["checks pending → fail: test"], ended: false })),
      Story.when(Observe.make({ read: read({ verdict: "fail", failing: ["test", "lint"] }) })),
      Story.then(Noticed.make({ last: read({ verdict: "fail", failing: ["test", "lint"] }), lines: ["checks still fail: test, lint"], ended: false })),
    ))

  test("reviewed: a new review ends the watch", () =>
    run(
      Story.given(Watched.make({ watch: watchOf("reviewed") })),
      Story.when(Observe.make({ read: read({ reviews: ["alice approved"], decision: "APPROVED" }) })),
      Story.then(
        Noticed.make({
          last: read({ reviews: ["alice approved"], decision: "APPROVED" }),
          lines: ["review: none → approved", "new review: alice approved"],
          ended: true,
        }),
      ),
    ))

  test("changed: mergeability settling from UNKNOWN is Seen, a new head is told", () =>
    run(
      Story.given(Watched.make({ watch: { ...watchOf("changed"), last: read({ mergeable: "UNKNOWN" }) } })),
      Story.when(Observe.make({ read: READ })),
      Story.then(Seen.make({ last: READ })),
      Story.when(Observe.make({ read: read({ head: "bbbbbbbb22" }) })),
      Story.then(Noticed.make({ last: read({ head: "bbbbbbbb22" }), lines: ["new head bbbbbbbb (was aaaaaaaa)"], ended: false })),
    ))

  test("any watch ends when the request merges", () =>
    run(
      Story.given(Watched.make({ watch: watchOf("reviewed") })),
      Story.when(Observe.make({ read: read({ state: "MERGED" }) })),
      Story.then(Noticed.make({ last: read({ state: "MERGED" }), lines: ["merged"], ended: true })),
    ))
})

describe("what a session reads", () => {
  const noticed = Noticed.make({ last: read({ verdict: "fail", failing: ["test"] }), lines: ["checks pending → fail: test"], ended: false })

  test("the notice names the request, the change, the note and how to stop", () => {
    expect(noticeTitle(watchOf("green"), noticed)).toBe("PR cevr/dotfiles#7: checks pending → fail: test")
    expect(noticeText(watchOf("green", "merge when green"), noticed, "test: 2 failed")).toBe(
      [
        "PR watch · cevr/dotfiles#7 Add the pr tool",
        "https://github.com/cevr/dotfiles/pull/7",
        "- checks pending → fail: test",
        "",
        "test: 2 failed",
        "",
        "note: merge when green",
        "",
        'Still watching (until green); pr({ action: "unwatch" }) stops it.',
      ].join("\n"),
    )
  })

  test("list names each watch on one line", () =>
    expect(watchLine(watchOf("green", "ship"))).toBe("cevr/dotfiles#7 Add the pr tool · until green · checks pending · note: ship"))
})
