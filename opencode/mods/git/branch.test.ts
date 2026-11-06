// The DefaultBranch aggregate's stories: a red spell is one TurnedRed, held
// through pending reads of later commits, and ends with one TurnedGreen. Then
// who hears of it and how long a repository is followed.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as Story from "@dotfiles/decider/story"
import {
  BranchSeen,
  branchNotice,
  DefaultBranch,
  FOLLOW_MS,
  followed,
  pruned,
  RECIPIENT_MS,
  recipients,
  type BranchRead,
  TurnedGreen,
  TurnedRed,
  used,
} from "./branch.ts"
import type { Check } from "./report.ts"

const story = Story.make(DefaultBranch)
const run = (...steps: Parameters<typeof story>) => Effect.runPromise(story(...steps))

const check = (name: string, state: Check["state"]): Check => ({ name, state, word: state.toUpperCase(), url: `https://ci/${name}` })
const at = (head: string, ...checks: ReadonlyArray<Check>): BranchRead => ({ name: "main", head, checks })
const observe = (read: BranchRead) => ({ _tag: "ObserveBranch" as const, read })

describe("the default branch", () => {
  test("turns red once, stays red through a pending later commit, and turns green once", () =>
    run(
      Story.when(observe(at("a1", check("test", "pass")))),
      Story.then(BranchSeen.make({ state: { head: "a1", verdict: "pass", red: false } })),
      Story.when(observe(at("b2", check("test", "fail")))),
      Story.then(TurnedRed.make({ state: { head: "b2", verdict: "fail", red: true }, failing: ["test"] })),
      Story.when(observe(at("c3", check("test", "pending")))),
      Story.then(BranchSeen.make({ state: { head: "c3", verdict: "pending", red: true } })),
      Story.when(observe(at("d4", check("test", "fail")))),
      Story.then(BranchSeen.make({ state: { head: "d4", verdict: "fail", red: true } })),
      Story.when(observe(at("e5", check("test", "pass")))),
      Story.then(TurnedGreen.make({ state: { head: "e5", verdict: "pass", red: false } })),
    ))

  test("the same read records nothing", () =>
    run(
      Story.given(BranchSeen.make({ state: { head: "a1", verdict: "pass", red: false } })),
      Story.when(observe(at("a1", check("test", "pass")))),
      Story.then(),
    ))

  test("a cancelled check is not red", () =>
    run(
      Story.when(observe(at("a1", check("test", "pass"), check("deploy", "cancelled")))),
      Story.then(BranchSeen.make({ state: { head: "a1", verdict: "pass", red: false } })),
    ))
})

describe("who hears of it", () => {
  const T = 1_800_000_000_000
  const record = used(used({ repo: "biteinc/maitred", users: {} }, "ses_old", T - RECIPIENT_MS - 1), "ses_new", T)

  test("the sessions that used the tool on it within a day", () => expect(recipients(record, T)).toEqual(["ses_new"]))

  test("a repository is followed for a week after a use, or always when configured", () => {
    expect(followed(record, T + FOLLOW_MS, false)).toBe(true)
    expect(followed(record, T + FOLLOW_MS + 1, false)).toBe(false)
    expect(followed(record, T + FOLLOW_MS + 1, true)).toBe(true)
    expect(pruned(record, T + FOLLOW_MS + 1).users).toEqual({})
  })

  test("the red notice names the failing checks and their links", () => {
    const read = at("b2b2b2b2b2", check("test", "fail"))
    const notice = branchNotice("biteinc/maitred", read, TurnedRed.make({ state: { head: "b2", verdict: "fail", red: true }, failing: ["test"] }))
    expect(notice.title).toBe("biteinc/maitred main turned red")
    expect(notice.text).toContain("Default branch · biteinc/maitred main turned red at b2b2b2b2: test\n  ✗ test · fail · https://ci/test")
  })
})
