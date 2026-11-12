// Who in a family works, as the dock's count and the hint line read it
// (`useWorking` keeps `workingIDs` in a memo under `sameIDs`): a new reading
// of the family in which the same subagents work is the same list, so the
// memo keeps its value and nothing that reads it runs; a change of who works
// is a new one.
import { describe, expect, test } from "bun:test"
import type { Family, Session } from "@dotfiles/opencode-subagents/family"
import { sameIDs, workingIDs } from "./family.ts"

const child = (id: string, running: boolean, words = ""): Session => ({
  id,
  parentID: "root",
  time: { created: 0 },
  running,
  shells: [],
  permissions: [],
  questions: [],
  messages: [{ type: "assistant", parts: [{ type: "words", text: words }] }],
})
const root: Session = { id: "root", time: { created: 0 }, running: false, shells: [], permissions: [], questions: [], messages: [] }
const family = (...children: Session[]): Family => ({ root: "root", sessions: [root, ...children] })

describe("the subagents of a family that work", () => {
  test("are the running ones and those waiting on a shell of their own, never the root", () => {
    const waiting = { ...child("c", false), shells: [{ id: "sh1", command: "bun test" }] }
    expect(workingIDs(family(child("a", true), child("b", false), waiting))).toEqual(["a", "c"])
    expect(workingIDs({ root: "root", sessions: [{ ...root, running: true }, child("a", false)] })).toEqual([])
  })

  test("read again after a token streams into a running one, are the same list", () => {
    const before = workingIDs(family(child("a", true, "Reading"), child("b", true), child("c", false)))
    const after = workingIDs(family(child("a", true, "Reading the brief"), child("b", true), child("c", false)))
    expect(after).not.toBe(before)
    expect(sameIDs(before, after)).toBe(true)
  })

  test("once one stops or another starts, are a new list", () => {
    const before = workingIDs(family(child("a", true), child("b", true), child("c", false)))
    expect(sameIDs(before, workingIDs(family(child("a", true), child("b", false), child("c", false))))).toBe(false)
    expect(sameIDs(before, workingIDs(family(child("a", true), child("b", false), child("c", true))))).toBe(false)
  })
})
