// The round policy's public seams, focused: render then decode is the identity for every role; a delivered block that
// lost an artifact, a stop field or its role is named part by part; a hand-back is judged on exact evidence values (a
// flag never stands in for one); a step is admitted only when its claim matches what the checked records owe. The
// whole-domain suites (every host render, every reachable record and pair, traces, mutation kills) are in
// skills/orchestrate/scripts/round-policy.test.ts.
import { describe, expect, test } from "bun:test"
import {
  admit,
  block,
  type Claim,
  decode,
  differences,
  due,
  type Facts,
  type Field,
  type HandBack,
  type ItemRecord,
  fieldKey,
  judge,
  policyFaults,
  project,
  recordFaults,
  render,
  ROLES,
  type Step,
} from "./round-policy.ts"

const facts = (over: Partial<Facts>): Facts => ({
  assigned: true,
  required: true,
  attempt: "never",
  settled: false,
  refused: false,
  hostCannot: false,
  wait: false,
  provenance: "none",
  ...over,
})

/** A required gate that ran red, with its content-bound run: what `completed` must carry, value for value. */
const red: ItemRecord = {
  id: "gate",
  facts: facts({ attempt: "fail" }),
  fields: [
    {
      field: "completed",
      run: { id: "att-7", command: "cmd:gate", output: { kind: "log", digest: "sha:7" }, exit: 1, receipt: "rcpt:7", head: "head:a", result: "fail" },
    },
  ],
}
const done: ItemRecord = {
  id: "spec",
  facts: facts({ attempt: "pass", settled: true }),
  fields: [
    {
      field: "completed",
      run: { id: "att-1", command: "cmd:spec", output: { kind: "log", digest: "sha:1" }, exit: 0, receipt: "rcpt:1", head: "head:a", result: "pass" },
    },
  ],
}

/** The hand-back exactly as the record owes it; an empty one (which every judge refuses) when it owes none. */
const handBackOf = (record: ItemRecord): HandBack => {
  const owed = dueOf(record)
  return { item: owed.item, rule: owed.rule, label: owed.label, fields: owed.fields }
}

/** A run with one value replaced: the same-looking evidence the judge must still refuse. */
const withRun = (field: Field, key: "id" | "receipt" | "head" | "command", value: string): Field => {
  if (field.field !== "completed") return field
  return { ...field, run: { ...field.run, [key]: value } }
}

describe("the notation", () => {
  test("each role's block decodes to exactly its source policy, and a host's surrounding text changes nothing", () => {
    for (const role of ROLES) {
      expect([role, decode(block(role))]).toEqual([role, { ok: true, value: project(role) }])
      expect([role, render(project(role)) === block(role), policyFaults(role, `before\n\n${block(role)}\n\nafter`)]).toEqual([role, true, []])
    }
  })
  test("F2 artifact loss (control 1): dropping state.md from the blocked verdict is named by the decoder", () => {
    const shown = block("implementor").replace("`<unit dir>/state.md` current (even with no commit since) and ", "")
    const got = decode(shown)
    expect(shown).not.toBe(block("implementor"))
    expect(got.ok && differences(project("implementor"), got.value).map((line) => line.split(":")[0])).toEqual(["verdict blocked"])
  })
  test("form loss (control 2): dropping the refusal's exact form field is named by the decoder", () => {
    const shown = block("implementor").replace(/\n\| a refusal named an accepted form \| `refused\.form` \|[^\n]*/, "")
    const got = decode(shown)
    expect(shown).not.toBe(block("implementor"))
    expect(got.ok && differences(project("implementor"), got.value).map((line) => line.split(":")[0])).toEqual(["stop refusalForm"])
  })
  test("an unknown version, a stray clause, a second block and an old end-of-step block are refused", () => {
    const text = block("planner")
    expect(decode(text.replace("round-policy v1 planner", "round-policy v2 planner"))).toEqual({ ok: false, error: "unknown round-policy version v2" })
    expect(decode(text.replace("\n\nTake the first row that is true", "\n\nSkip the acceptance check.\n\nTake the first row that is true")).ok).toBe(false)
    expect(policyFaults("planner", `${text}\n${text}`)).toEqual(["planner: 2 policy blocks open and 2 close: exactly one of each"])
    expect(policyFaults("planner", `${text}\n<!-- end-of-step: old -->`)).toEqual(["planner: an end-of-step block of an unknown version"])
  })
})

describe("a hand-back, judged on exact evidence", () => {
  test("the hand-back a record owes is accepted as it is", () => {
    expect(judge(dueOf(red), handBackOf(red))).toEqual([])
  })
  test("forged evidence (control 3): a `lastAttempt` flag, or no `completed` content, is refused", () => {
    const given = handBackOf(red)
    const flagged = { ...given, fields: [], lastAttempt: true }
    expect(judge(dueOf(red), flagged)).toEqual([
      "unknown hand-back keys [lastAttempt]: no flag stands in for evidence",
      `completed: due completed id="att-7" command="cmd:gate" output=log "sha:7" exit=1 receipt="rcpt:7" head="head:a" result=fail, given none`,
    ])
  })
  test("a same-looking run with another receipt, head or digest is refused, naming both values", () => {
    for (const [key, value] of [
      ["receipt", "rcpt:8"],
      ["head", "head:b"],
      ["command", "cmd:other"],
    ] as const) {
      const given = handBackOf(red)
      const swapped = { ...given, fields: given.fields.map((field) => withRun(field, key, value)) }
      expect([key, judge(dueOf(red), swapped).length]).toEqual([key, 1])
    }
  })
  test("values compared member by member (B1): an id and a command that print alike are still two values", () => {
    const record: ItemRecord = { ...red, fields: red.fields.map((field) => withRun(field, "command", "verify command=fixture")) }
    const given = handBackOf(record)
    const moved = { ...given, fields: given.fields.map((field) => withRun(withRun(field, "id", "att-7 command=verify"), "command", "fixture")) }
    expect(moved.fields.map(fieldKey)).toEqual(given.fields.map(fieldKey))
    expect(judge(dueOf(record), moved).length).toBe(1)
    expect(judge(dueOf(record), given)).toEqual([])
  })
  test("unreachable facts (B3) owe no hand-back: a typed rejection, never a fallback row", () => {
    const stray: ItemRecord = { id: "stray", facts: facts({ assigned: false, required: true }), fields: [] }
    expect(due(project("verifier"), stray)).toEqual({
      ok: false,
      error: "stray: a provenance belongs exactly to a verifier's finding outside its assignment; work outside the assignment is never attempted, required or held back, and is settled as found",
    })
    expect(due(project("implementor"), { ...red, facts: facts({ attempt: "fail", required: false }) }).ok).toBe(false)
  })
  test("a record whose evidence disagrees with its facts owes nothing: it is refused", () => {
    expect(recordFaults("implementor", { ...red, fields: [] })).toEqual(["`completed` is due exactly when an attempt finished (facts: fail)"])
  })
})

const dueOf = (record: ItemRecord) => {
  const owed = due(project("implementor"), record)
  if (!owed.ok) return { item: "", rule: "", state: "done" as const, label: "", fields: [] }
  return owed.value
}

describe("a step, admitted only against its checked records", () => {
  const step: Step = { stop: { stop: "limit", values: [{ id: "limit", value: "timebox 2 h" }] }, items: [done, red] }
  test("`ready` with a runnable item left (control 4) is refused; the claim the records owe is admitted", () => {
    const ready: Claim = { verdict: "ready", writes: ["request"], stop: [], items: [handBackOf(done), handBackOf(red)] }
    expect(admit(project("implementor"), step, ready)).toEqual([
      "verdict: due blocked, given ready",
      "writes: due [state, blocked], given [request]",
      `stop limit: due "timebox 2 h", given none`,
    ])
    const owed: Claim = { verdict: "blocked", writes: ["state", "blocked"], stop: step.stop.values, items: [handBackOf(red), handBackOf(done)] }
    expect(admit(project("implementor"), step, owed)).toEqual([])
  })
  test("a forged stop value (T1): each value changed alone is refused; the recorded one is admitted", () => {
    const owed: Claim = { verdict: "blocked", writes: ["state", "blocked"], stop: step.stop.values, items: [handBackOf(red), handBackOf(done)] }
    expect(admit(project("implementor"), step, owed)).toEqual([])
    expect(admit(project("implementor"), step, { ...owed, stop: [{ id: "limit", value: "timebox 3 h" }] })).toEqual([`stop limit: due "timebox 2 h", given "timebox 3 h"`])
  })
  test("absence told by leaving the value out (B2): the truthful empty stop is admitted, a placeholder is refused", () => {
    const clean: Step = { stop: { stop: "idle", values: [] }, items: [done] }
    const claim: Claim = { verdict: "ready", writes: ["request"], stop: [], items: [handBackOf(done)] }
    expect(admit(project("implementor"), clean, claim)).toEqual([])
    const placeholder: Step = { stop: { stop: "idle", values: [{ id: "held", item: "spec", value: "nothing" }] }, items: [done] }
    expect(admit(project("implementor"), placeholder, { ...claim, stop: placeholder.stop.values })).toEqual([
      "ill-formed stop record: held: spec holds nothing back, so no entry is due for it",
    ])
    expect(admit(project("implementor"), { ...clean, stop: { stop: "idle", values: [{ id: "held", item: "spec", value: "" }] } }, claim).length).toBeGreaterThan(0)
  })
  test("a step no history produces (stopped idle with a runnable item) admits no claim at all", () => {
    const idle: Step = { stop: { stop: "idle", values: [] }, items: [done, red] }
    expect(admit(project("implementor"), idle, { verdict: "ready", writes: ["request"], stop: [], items: [handBackOf(done), handBackOf(red)] })).toEqual([
      "ill-formed step: the step goes on while a runnable item is left",
    ])
  })
})
