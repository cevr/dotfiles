import { expect, test } from "bun:test"
import { LISTED, noteOf, stepOf } from "./skill-drift.ts"

/** The note's last line: where the skill says how to reconcile. */
const RECONCILE_LINE = "Reconcile the run's rules file once, as the orchestrate skill's references/run-rules.md says (When the skill changes). This note comes once per skill version."

const A = "a".repeat(40)
const B = "b".repeat(40)

test("a run never seen records; the same version, an older one or one not read stays; a newer or unrelated one tells", () => {
  expect(stepOf(undefined, B, undefined)).toEqual({ _tag: "Record" })
  expect(stepOf(B, B, undefined)).toEqual({ _tag: "Stay" })
  expect(stepOf(A, B, undefined)).toEqual({ _tag: "Stay" })
  expect(stepOf(A, B, { _tag: "Same" })).toEqual({ _tag: "Stay" })
  expect(stepOf(A, B, { _tag: "Older" })).toEqual({ _tag: "Stay" })
  expect(stepOf(A, B, { _tag: "Newer", subjects: ["x"] })).toEqual({ _tag: "Tell", subjects: ["x"], unrelated: false })
  expect(stepOf(A, B, { _tag: "Unrelated", subjects: ["y"] })).toEqual({ _tag: "Tell", subjects: ["y"], unrelated: true })
})

test("the note names each run, lists at most LISTED lines of each kind, and ends with the reconcile", () => {
  const subjects = Array.from({ length: LISTED + 2 }, (_, n) => `feat: ${n}`)
  const note = noteOf([
    { run: "wf10", seen: A, installed: B, subjects, unrelated: false, departures: [] },
    { run: "p5", seen: A, installed: B, subjects: ["feat: x"], unrelated: true, departures: ["common.md:1: Departs from X: y"] },
  ]).split("\n")
  expect(note[0]).toBe(`The orchestrate skill changed since run wf10 saw it (aaaaaaa..bbbbbbb, ${LISTED + 2} commits):`)
  expect(note).toContain("- and 2 more")
  expect(note).toContain(`Run wf10's rules files mark no departure ("Departs from <rule>: <why>").`)
  expect(note).toContain("The orchestrate skill changed since run p5 saw it (aaaaaaa, not in this checkout's history; now bbbbbbb). Its newest changes:")
  expect(note).toContain("- common.md:1: Departs from X: y")
  expect(note.at(-1)).toBe(RECONCILE_LINE)
})

test("the note points at the skill's reconcile and restates none of it: no drift, no offer upstream at close, no rules list", () => {
  const note = noteOf([{ run: "p5", seen: A, installed: B, subjects: ["feat: x"], unrelated: false, departures: [] }])
  expect(note).toContain("references/run-rules.md")
  expect(note).not.toMatch(/\bdrift\b|upstream|at close|thread shares|round boundary/i)
})
