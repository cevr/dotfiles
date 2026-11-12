import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import type { Record } from "./record.ts"
import { messageOf, onTarget, type Target, tagObject, targetOfTag } from "./target.ts"
import { ask, ended, IDLE, Plan, plan, superseded } from "./update.ts"

const TARGET: Target = { dotfiles: "a".repeat(40), fork: "b".repeat(40), batch: "batch-k" }
const TAGGER = { name: "orchestrate", email: "orchestrate@localhost", at: 1_794_416_400 }

const record = (dotfiles: string, fork: string): Record => ({ version: "2.2.7-prime.aaaaaaaa", command: ["/s/opencode"], dotfiles, fork })

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

  test("is installed when the record names both of its commits", () => {
    expect(onTarget({ dotfiles: Option.some(TARGET.dotfiles), fork: Option.some(TARGET.fork) }, TARGET)).toBe(true)
    expect(onTarget({ dotfiles: Option.some(TARGET.dotfiles), fork: Option.some("c".repeat(40)) }, TARGET)).toBe(false)
    expect(onTarget({ dotfiles: Option.none(), fork: Option.none() }, TARGET)).toBe(false)
  })
})

describe("an update run's plan", () => {
  test("waits for a target, does nothing on it, and updates a host off it or with no record", () => {
    expect(plan(Option.none(), Option.none())).toEqual(Plan.NoTarget())
    expect(plan(Option.some(TARGET), Option.some(record(TARGET.dotfiles, TARGET.fork)))).toEqual(Plan.Current({ target: TARGET }))
    expect(plan(Option.some(TARGET), Option.some(record(TARGET.dotfiles, "c".repeat(40))))).toEqual(Plan.Update({ target: TARGET }))
    expect(plan(Option.some(TARGET), Option.none())).toEqual(Plan.Update({ target: TARGET }))
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
