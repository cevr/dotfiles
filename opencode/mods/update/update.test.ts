import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { type Build, nextRecord, proven, type Record, rolledBack, stagedRecord } from "./record.ts"
import { messageOf, type Target, tagObject, targetOfTag } from "./target.ts"
import { ask, ended, IDLE, Plan, plan, type Rejected, superseded } from "./update.ts"

const TARGET: Target = { dotfiles: "a".repeat(40), fork: "b".repeat(40), batch: "batch-k" }
const TAGGER = { name: "orchestrate", email: "orchestrate@localhost", at: 1_794_416_400 }

const record = (dotfiles: string, fork: string): Record => ({ version: "2.2.7-prime.aaaaaaaa", command: ["/s/opencode"], dotfiles, fork })
const TARGET_BUILD: Build = { version: "2.2.7-prime.bbbbbbbb", command: ["/s/opencode-b"], dotfiles: TARGET.dotfiles, fork: TARGET.fork }

describe("the verified target", () => {
  test("rides in the tag object that points at the dotfiles commit, and reads back from it", () => {
    const text = tagObject(TARGET, TAGGER)
    expect(text.split("\n").slice(0, 4)).toEqual([`object ${"a".repeat(40)}`, "type commit", "tag fleet-verified", "tagger orchestrate <orchestrate@localhost> 1794416400 +0000"])
    expect(targetOfTag(text)).toEqual(Option.some(TARGET))
  })

  test("is none in a tag whose message is no target, or names another commit than the tag's", () => {
    expect(targetOfTag(tagObject(TARGET, TAGGER).replace(messageOf(TARGET), "hello"))).toEqual(Option.none())
    expect(targetOfTag(tagObject(TARGET, TAGGER).replace(`object ${"a".repeat(40)}`, `object ${"c".repeat(40)}`))).toEqual(Option.none())
    expect(targetOfTag("")).toEqual(Option.none())
  })
})

describe("an update run's plan", () => {
  test("waits for a target, does nothing on a proven build of it, and updates a host off it or with no record", () => {
    expect(plan(Option.none(), Option.none(), Option.none())).toEqual(Plan.NoTarget())
    expect(plan(Option.some(TARGET), Option.some(proven(record(TARGET.dotfiles, TARGET.fork))), Option.none())).toEqual(Plan.Current({ target: TARGET }))
    expect(plan(Option.some(TARGET), Option.some(proven(record(TARGET.dotfiles, "c".repeat(40)))), Option.none())).toEqual(Plan.Update({ target: TARGET }))
    expect(plan(Option.some(TARGET), Option.none(), Option.none())).toEqual(Plan.Update({ target: TARGET }))
  })

  test("a staged build of the target, or one installed without its proof, restarts through the handoff and is never current", () => {
    const old = proven(record("c".repeat(40), "c".repeat(40)))
    expect(plan(Option.some(TARGET), Option.some(stagedRecord(Option.some(old), TARGET_BUILD, [])), Option.none())).toEqual(Plan.Restart({ target: TARGET }))
    expect(plan(Option.some(TARGET), Option.some(nextRecord(Option.some(old), TARGET_BUILD, [])), Option.none())).toEqual(Plan.Restart({ target: TARGET }))
  })

  test("P1, P6: after a failed build, a failed advance, a rollback or a give-up, the plan is never to build or restart onto that target again", () => {
    const old = proven(record("c".repeat(40), "c".repeat(40)))
    const staged = stagedRecord(Option.some(old), TARGET_BUILD, [])
    const installed = nextRecord(Option.some(old), TARGET_BUILD, [])
    const records: ReadonlyArray<Option.Option<Record>> = [Option.none(), Option.some(old), Option.some(staged), Option.some(installed), rolledBack(installed)]
    for (const step of ["advance", "build", "health"]) {
      const rejected: Rejected = { dotfiles: TARGET.dotfiles, fork: TARGET.fork, step, cause: "exit 1" }
      for (const each of records) expect(plan(Option.some(TARGET), each, Option.some(rejected))._tag).toBe("Rejected")
      expect(plan(Option.some({ ...TARGET, fork: "e".repeat(40), batch: "batch-8" }), Option.some(old), Option.some(rejected))._tag).toBe("Update")
    }
  })

  test("a newer target supersedes the one a built run waits to restart onto", () => {
    expect(superseded(TARGET, Option.some(TARGET))).toBe(false)
    expect(superseded(TARGET, Option.some({ ...TARGET, dotfiles: "c".repeat(40) }))).toBe(true)
    expect(superseded(TARGET, Option.none())).toBe(false)
  })
})

describe("update runs", () => {
  test("run one at a time, and the requests during a run coalesce into one more run", () => {
    const [first, running] = ask(IDLE)
    expect(first).toBe(true)
    const [second, marked] = ask(running)
    const [third, still] = ask(marked)
    expect([second, third]).toEqual([false, false])
    const [again, rerun] = ended(still)
    expect(again).toBe(true)
    const [more, idle] = ended(rerun)
    expect(more).toBe(false)
    expect(idle).toEqual(IDLE)
  })
})
