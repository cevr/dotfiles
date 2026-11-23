// The round policy's public seams, focused: render then decode is the identity for every role; a delivered block that
// lost an artifact, a stop field or its role is named part by part; evidence enters only as a step's persisted
// envelope (raw JSON here), through `decode`, and every claim is judged against what that envelope's histories owe.
// The export census holds the module to that: no exported function takes a record, a trace, a stop record or an
// evidence value. The whole-domain suites (every host render, every generated history, envelope fuzz, mutation kills)
// are in skills/orchestrate/scripts/round-policy.test.ts.
import { describe, expect, test } from "bun:test"
import { Predicate, Schema } from "effect"
import * as Module from "./round-policy.ts"
import {
  type Absent,
  admit,
  block,
  type Checked,
  type Claim,
  decode,
  decodeBlock,
  differences,
  type Field,
  type HandBack,
  type ItemRecord,
  type Limit,
  owed,
  type Pending,
  policyFaults,
  project,
  type Refusal,
  render,
  ROLES,
  type Run,
  type StepEvent,
  type StopValue,
  type Trace,
  type TraceEvent,
} from "./round-policy.ts"

// ---- raw envelopes: plain JSON, as a store or a file holds it ---------------------------------------------------------

/** JSON text, as a store or a file holds it, and the plain value read back from it (Schema's JSON codec). */
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))
const assigned = { kind: "assigned", required: true }
const begin = (attempt: string, command = `cmd:${attempt}`) => ({ kind: "begin", attempt, command })
const unreadable = () => {
  const value = Proxy.revocable({}, {})
  value.revoke()
  return value.proxy
}
const finish = (attempt: string, result: string, exit: number) => ({ kind: "finish", attempt, result, exit, output: { kind: "log", digest: `sha:${attempt}` }, receipt: `rcpt:${attempt}`, head: "head:a" })
const refusal = (what: string): Refusal => ({ what, scope: "scope:x", report: "report:x", form: { kind: "none" } })
/** A raw envelope: fresh plain objects each call, so no two envelopes share one. */
const envelope = (role: string, items: ReadonlyArray<object>, step: ReadonlyArray<object> = []) => ({ version: 1, role, items, step })

/** A required gate that ran red, and a spec item that passed: their histories, as the step recorded them. */
const red = { id: "gate", assignment: assigned, events: [begin("att-7", "cmd:gate"), finish("att-7", "fail", 1)] }
const done = { id: "spec", assignment: assigned, events: [begin("att-1", "cmd:spec"), finish("att-1", "pass", 0)] }
const timebox = { kind: "limit", limit: { kind: "timebox", length: "2 h" } }

/** A raw envelope as the builder above makes it. */
type RawEnvelope = ReturnType<typeof envelope>
const checkedOf = (input: RawEnvelope): Checked => {
  const got = decode(input)
  if (got.ok) return got.value
  return expect.unreachable(got.error)
}
const owedOf = (input: RawEnvelope): Claim => {
  const checked = checkedOf(input)
  const due = owed(checked)
  if (due.ok) return due.value.claim
  return expect.unreachable(due.error)
}
const admitted = (input: RawEnvelope, claim: Claim) => {
  const checked = checkedOf(input)
  return admit(checked)(claim)
}
const patchRun = (field: Field, patch: Partial<Run>): Field => {
  if (field.field !== "completed") return field
  return { ...field, run: { ...field.run, ...patch } }
}
/** The claim with the completed run of each item `on` picks changed by `patch`: a forgery of one evidence value. */
const withRun = (claim: Claim, patch: Partial<Run>, on: (item: string) => boolean): Claim => ({
  ...claim,
  items: claim.items.map((one) => {
    if (!on(one.item)) return one
    return { ...one, fields: one.fields.map((field) => patchRun(field, patch)) }
  }),
})

describe("the notation", () => {
  test("each role's block decodes to exactly its source policy, and a host's surrounding text changes nothing", () => {
    for (const role of ROLES) {
      expect([role, decodeBlock(block(role))]).toEqual([role, { ok: true, value: project(role) }])
      expect([role, render(project(role)) === block(role), policyFaults(role, `before\n\n${block(role)}\n\nafter`)]).toEqual([role, true, []])
    }
  })
  test("F2 artifact loss (control 1): dropping state.md from the blocked verdict is named by the decoder", () => {
    const shown = block("implementor").replace("`<unit dir>/state.md` current (even with no commit since) and ", "")
    const got = decodeBlock(shown)
    expect(shown).not.toBe(block("implementor"))
    expect(got.ok && differences(project("implementor"), got.value).map((line) => line.split(":")[0])).toEqual(["verdict blocked"])
  })
  test("form loss (control 2): dropping the refusal's exact form field is named by the decoder", () => {
    const shown = block("implementor").replace(/\n\| a refusal named an accepted form \| `refused\.form` \|[^\n]*/, "")
    const got = decodeBlock(shown)
    expect(shown).not.toBe(block("implementor"))
    expect(got.ok && differences(project("implementor"), got.value).map((line) => line.split(":")[0])).toEqual(["stop refusalForm"])
  })
  test("an unknown version, a stray clause, a second block and an old end-of-step block are refused", () => {
    const text = block("planner")
    expect(decodeBlock(text.replace("round-policy v1 planner", "round-policy v2 planner"))).toEqual({ ok: false, error: "unknown round-policy version v2" })
    expect(decodeBlock(text.replace("\n\nTake the first row that is true", "\n\nSkip the acceptance check.\n\nTake the first row that is true")).ok).toBe(false)
    expect(policyFaults("planner", `${text}\n${text}`)).toEqual(["planner: 2 policy blocks open and 2 close: exactly one of each"])
    expect(policyFaults("planner", `${text}\n<!-- end-of-step: old -->`)).toEqual(["planner: an end-of-step block of an unknown version"])
  })
})

// ---- the export law: one way in ----------------------------------------------------------------------------------------

/**
 * Every exported function, by its disposition: `decode` is the one decoder; `owed` and `admit` read only a `Checked`
 * step (and the claim as unknown); the rest read a role, a policy, policy text or item states, never evidence.
 */
const EXPORTED_FUNCTIONS = {
  decoder: ["decode"],
  checked: ["admit", "owed"],
  policy: [
    "atomWords",
    "batchVerdict",
    "block",
    "blockOf",
    "checked",
    "condition",
    "decide",
    "decodeBlock",
    "delivered",
    "differences",
    "hasState",
    "hasStop",
    "header",
    "heldStates",
    "illFormed",
    "outcome",
    "parseCondition",
    "parseVerdictWhen",
    "parseWrites",
    "policyFaults",
    "presenceWords",
    "project",
    "readList",
    "render",
    "truths",
    "verdictWhen",
    "verdictWord",
    "writesText",
  ],
} as const

/** Whether a function's parameter list admits a value of type `X` in any position. */
type Takes<F, X> = F extends (...args: infer P) => unknown ? (true extends { [K in keyof P]: [X] extends [P[K]] ? true : false }[number] ? true : false) : false
/** What no exported function but the decoder may take: a record, a trace or its events, a stop record, an evidence value. */
type Evidence = ItemRecord | Trace | TraceEvent | StepEvent | Limit | Field | Run | Pending | Refusal | Absent | StopValue | HandBack | Claim | ItemRecord["fields"]
type TakesEvidence<F> = Evidence extends infer X ? (X extends unknown ? Takes<F, X> : never) : never
type Functions = { [K in keyof typeof Module]: (typeof Module)[K] extends (...args: never) => unknown ? K : never }[keyof typeof Module]
/** Each exported function but the decoder, and whether it takes evidence: every entry must be `false`. */
type Census = { [K in Exclude<Functions, "decode">]: TakesEvidence<(typeof Module)[K]> }
/** Every key is required and none is extra (`satisfies`), and each is `true` only if that function takes no evidence. */
const census = {
  admit: true,
  owed: true,
  atomWords: true,
  batchVerdict: true,
  block: true,
  blockOf: true,
  checked: true,
  condition: true,
  decide: true,
  decodeBlock: true,
  delivered: true,
  differences: true,
  hasState: true,
  hasStop: true,
  header: true,
  heldStates: true,
  illFormed: true,
  outcome: true,
  parseCondition: true,
  parseVerdictWhen: true,
  parseWrites: true,
  policyFaults: true,
  presenceWords: true,
  project: true,
  readList: true,
  render: true,
  truths: true,
  verdictWhen: true,
  verdictWord: true,
  writesText: true,
} satisfies { [K in keyof Census]: Census[K] extends false ? true : never }

describe("the export law: evidence enters only through decode", () => {
  test("the census: the module's exported functions are exactly the allowlist, each with its disposition", () => {
    const exported = Object.entries(Module)
      .filter(([, value]) => Predicate.isFunction(value))
      .map(([name]) => name)
      .sort()
    const allowed = [...EXPORTED_FUNCTIONS.decoder, ...EXPORTED_FUNCTIONS.checked, ...EXPORTED_FUNCTIONS.policy].sort()
    expect(exported).toEqual(allowed)
    expect(Object.keys(census).sort()).toEqual(allowed.filter((name) => name !== "decode"))
    // An exported table of functions (READS) is a policy reading of an item's facts: none of its members takes evidence.
    const tables = Object.entries(Module).filter(([, value]) => value === Object(value) && Object.values(value).some(Predicate.isFunction))
    expect(tables.map(([name]) => name)).toEqual(["READS"])
  })
  test("the type law: no exported function takes a record, a trace, a stop record or an evidence value", () => {
    const checked = checkedOf(envelope("implementor", [done]))
    const record: ItemRecord = checked.records[0]!
    const trace = { id: "spec", assignment: { kind: "assigned", required: true }, events: [{ kind: "begin", attempt: "att-1", command: "cmd:spec" }] } satisfies Trace
    // @ts-expect-error -- the export law, asserted: a caller-assembled record is no checked step
    owed(record)
    // @ts-expect-error -- the export law, asserted: a trace is no checked step: only decode reads one
    owed(trace)
    // @ts-expect-error -- the export law, asserted: a raw envelope is no checked step until decode checks it
    admit(envelope("implementor", [done]))
    // @ts-expect-error -- the export law, asserted: a stop record is no checked step
    admit({ stop: { stop: "limit", values: [{ id: "limit", value: "nothing" }] }, items: [record] })
    // @ts-expect-error -- the export law, asserted: a structural copy of a checked step is not one (its private member makes the type nominal)
    owed({ role: checked.role, records: checked.records, ending: checked.ending, envelope: checked.envelope })
    // @ts-expect-error -- the resolution policy comes with the checked step, never from a caller
    admit(project("implementor"), checked)
    // At run time too: a copy that an untyped value lets through (Object.create gives `any`) is a typed rejection, never a judged step.
    const copy: Checked = Object.assign(Object.create(Object.prototype), checked)
    expect(owed(copy)).toEqual({ ok: false, error: "a step is checked only by decode, from its envelope" })
  })
  test("a borrowed prototype or constructor is not issuance, and an issued step cannot be rewritten", () => {
    const proof = checkedOf(envelope("implementor", [done]))
    const withoutEvidence = { ...proof, records: [] }
    const proto = Object.getPrototypeOf(proof)
    const copied: Checked = Object.assign(Object.create(proto), withoutEvidence)
    const constructed: Checked = Reflect.construct(proto.constructor, [proof.role, [], proof.ending, proof.envelope])
    const expected = { ok: false, error: "a step is checked only by decode, from its envelope" } as const
    for (const candidate of [copied, constructed]) {
      expect(owed(candidate)).toEqual(expected)
      expect(admit(candidate)(owedOf(envelope("implementor", [done])))).toEqual([`ill-formed: ${expected.error}`])
    }
    expect(Reflect.set(proof, "records", [])).toBe(false)
    expect(owed(proof).ok).toBe(true)
  })
})

describe("decode: the persisted envelope, exact, never a throw", () => {
  test("an unreadable unknown value is a typed rejection, not an exception from the caller's proxy", () => {
    expect(decode(unreadable())).toEqual({ ok: false, error: "envelope: could not read the value" })
    const judge = admit(checkedOf(envelope("implementor", [done])))
    const rejection = judge(unreadable())
    expect(rejection).toEqual(["claim: could not read the value"])
    Reflect.set(rejection, "length", 0)
    expect(judge(unreadable())).toEqual(["claim: could not read the value"])
  })
  test("a timebox is a positive duration, and a failure cap is a positive count", () => {
    for (const length of ["nothing", "0s", "-1h", "2 elephants", "2h\n"]) {
      const got = decode(envelope("implementor", [red], [{ kind: "limit", limit: { kind: "timebox", length } }]))
      expect([length, got.ok]).toEqual([length, false])
    }
    for (const count of [-1, 0, Number.MAX_SAFE_INTEGER + 1]) {
      const got = decode(envelope("implementor", [red], [{ kind: "limit", limit: { kind: "failureCap", count } }]))
      expect([count, got.ok]).toEqual([count, false])
    }
    expect(owedOf(envelope("implementor", [red], [{ kind: "limit", limit: { kind: "failureCap", count: 3 } }])).stop).toEqual([{ id: "limit", value: "failure cap 3" }])
  })
  test("a misspelled tag, a string for a boolean, a missing member, an excess member, null and {} are typed rejections naming the path", () => {
    const cases: ReadonlyArray<readonly [string, unknown, string]> = [
      ["misspelled event", envelope("implementor", [{ ...red, events: [{ ...begin("a"), kind: "begn" }] }]), `at ["items"][0]["events"][0]`],
      ["required as a string", envelope("implementor", [{ ...red, assignment: { kind: "assigned", required: "false" } }]), `at ["items"][0]["assignment"]["required"]`],
      ["missing member", envelope("implementor", [{ ...red, events: [{ kind: "begin", attempt: "a" }] }]), `at ["items"][0]["events"][0]`],
      ["excess member", envelope("implementor", [{ ...red, flag: true }]), `at ["items"][0]["flag"]`],
      ["a null event", decodeJson(encodeJson(envelope("implementor", [{ ...red, events: [] }])).replace(`"events":[]`, `"events":[null]`)), `at ["items"][0]["events"][0]`],
      ["an empty event", envelope("implementor", [{ ...red, events: [{}] }]), `at ["items"][0]["events"][0]`],
      ["a limit of nothing", envelope("implementor", [done, red], [{ kind: "limit", limit: "nothing" }]), `at ["step"][0]["limit"]`],
      ["an unknown role", envelope("tester", [done]), `at ["role"]`],
      ["another version", { version: 2, role: "implementor", items: [], step: [] }, `at ["version"]`],
    ]
    for (const [name, input, path] of cases) {
      const got = decode(input)
      expect([name, got.ok, !got.ok && got.error.startsWith("envelope: ") && got.error.includes(path)]).toEqual([name, false, true])
    }
    // Every JSON root that is no envelope (JSON has no undefined).
    for (const text of ["null", "{}", "[]", `"text"`, "7"]) expect([text, decode(decodeJson(text)).ok]).toEqual([text, false])
  })
  test("a blank value is no value: an empty or white-space id, command, digest, receipt, refusal or limit is a typed rejection", () => {
    const blanks: ReadonlyArray<readonly [string, unknown]> = [
      ["attempt id", envelope("implementor", [{ ...red, events: [begin(" ", "cmd:gate")] }], [timebox])],
      ["command", envelope("implementor", [{ ...red, events: [begin("att-7", "")] }], [timebox])],
      ["digest", envelope("implementor", [{ ...red, events: [begin("att-7"), { ...finish("att-7", "fail", 1), output: { kind: "log", digest: " " } }] }], [timebox])],
      ["receipt", envelope("implementor", [{ ...red, events: [begin("att-7"), { ...finish("att-7", "fail", 1), receipt: "" }] }], [timebox])],
      ["refusal what", envelope("implementor", [{ ...red, events: [{ kind: "deny", attempt: "d", command: "cmd:d", refusal: refusal("") }] }])],
      ["wait ref", envelope("implementor", [{ ...red, events: [{ kind: "waitOpen", ref: "" }] }])],
      ["time box length", envelope("implementor", [done, red], [{ kind: "limit", limit: { kind: "timebox", length: " " } }])],
      ["item id", envelope("implementor", [{ ...done, id: "" }])],
    ]
    for (const [name, input] of blanks) {
      const got = decode(input)
      expect([name, got.ok, !got.ok && /^(item [^:]*: |step: |an item )/.test(got.error)]).toEqual([name, false, true])
    }
  })
  test("an event that cannot happen where the history stands is a typed rejection naming the item and the event", () => {
    const got = decode(envelope("implementor", [{ ...red, events: [finish("att-7", "fail", 1)] }]))
    expect(got).toEqual({ ok: false, error: "item gate: event 1 (finish): only the current attempt, running or interrupted, finishes, once no refusal holds it, with its result, exit, output (a log, or no authenticated evidence), receipt and head" })
  })
})

describe("B4: a refusal never erases what an attempt already printed", () => {
  const observed = [begin("b1"), { kind: "observe", attempt: "b1", digest: "sha:b1-partial" }]
  test("a denial of an attempt that began is a typed rejection: a denied call is one that never began", () => {
    const got = decode(envelope("implementor", [{ id: "b", assignment: assigned, events: [...observed, { kind: "deny", attempt: "b1", command: "cmd:b1", refusal: refusal("read:x") }] }]))
    expect([got.ok, !got.ok && got.error.startsWith("item b: event 3 (deny): a denied call never began")]).toEqual([false, true])
  })
  test("a refusal after an interruption retains the interrupted attempt's known output", () => {
    const interrupted = [...observed, { kind: "interrupt", attempt: "b1", output: { kind: "missing", why: "interrupted" } }]
    const item = (event: TraceEvent) => ({ id: "b", assignment: assigned, events: [...interrupted, event] })
    const replaced = decode(envelope("implementor", [item({ kind: "deny", attempt: "b2", command: "cmd:b2", refusal: refusal("read:x") })]))
    expect(replaced.ok).toBe(false)
    const claim = owedOf(envelope("implementor", [item({ kind: "refuse", attempt: "b1", refusal: refusal("read:x") })]))
    expect(claim.items[0]?.fields).toEqual([
      { field: "current", attempt: { id: "b1", command: "cmd:b1", status: "interrupted", output: { kind: "partial", digest: "sha:b1-partial" } } },
      { field: "refused", refusal: refusal("read:x") },
    ])
  })
  test("a result with no new authenticated output keeps the partial output before the refusal", () => {
    const events = [
      ...observed,
      { kind: "refuse", attempt: "b1", refusal: refusal("read:x") },
      { kind: "lift" },
      { ...finish("b1", "pass", 0), output: { kind: "missing", why: "missing-authenticated-evidence" } },
    ]
    const claim = owedOf(envelope("implementor", [{ id: "b", assignment: assigned, events }]))
    expect(claim.items[0]?.fields).toEqual([{ field: "completed", run: { id: "b1", command: "cmd:b1", exit: 0, receipt: "rcpt:b1", head: "head:a", result: "pass", output: { kind: "partial", digest: "sha:b1-partial" } } }])
  })
  test("a refusal beside the running attempt keeps it started with its partial output, in every later label", () => {
    const refused = [...observed, { kind: "refuse", attempt: "b1", refusal: refusal("read:x") }]
    const current: Field = { field: "current", attempt: { id: "b1", command: "cmd:b1", status: "started", output: { kind: "partial", digest: "sha:b1-partial" } } }
    expect(owedOf(envelope("implementor", [{ id: "b", assignment: assigned, events: refused }])).items[0]?.fields).toEqual([current, { field: "refused", refusal: refusal("read:x") }])
    // Lifted, then interrupted: the partial output is still what the attempt printed.
    const later = [...refused, { kind: "lift" }, { kind: "interrupt", attempt: "b1", output: { kind: "partial", digest: "sha:b1-partial" } }]
    expect(owedOf(envelope("implementor", [{ id: "b", assignment: assigned, events: later }], [timebox])).items[0]?.fields).toEqual([{ field: "current", attempt: { ...current.attempt, status: "interrupted" } }])
    // A denial of a call that never began is told apart: denied, not started.
    const fresh = owedOf(envelope("implementor", [{ id: "b", assignment: assigned, events: [{ kind: "deny", attempt: "b1", command: "cmd:b1", refusal: refusal("read:x") }] }]))
    expect(fresh.items[0]?.fields[0]).toEqual({ field: "current", attempt: { id: "b1", command: "cmd:b1", status: "denied", output: { kind: "missing", why: "not-started" } } })
  })
})

describe("a refused write of the step's own file (item 6)", () => {
  test("a verifier whose checks all passed and whose findings write is refused: stuck, the refusal named, the passed check kept", () => {
    const input = envelope("verifier", [done], [{ kind: "writeDenied", artifact: "findings", refusal: refusal("write:findings") }])
    const claim = owedOf(input)
    expect([claim.verdict, claim.stop, claim.items.map((one) => [one.item, one.rule])]).toEqual(["stuck", [{ id: "refused.what", value: "write:findings" }], [["spec", "done"]]])
    expect(admitted(input, claim)).toEqual([])
    expect(admitted(input, { ...claim, verdict: "accepted" })).toEqual(["verdict: due stuck, given accepted"])
  })
  test("a write the role never makes, or a second stop beside it, is a typed rejection", () => {
    expect(decode(envelope("worker", [done], [{ kind: "writeDenied", artifact: "findings", refusal: refusal("write:findings") }]))).toEqual({ ok: false, error: "step: a worker writes no findings" })
    const twice = decode(envelope("implementor", [done, red], [timebox, { kind: "writeDenied", artifact: "request", refusal: refusal("write:request") }]))
    expect(twice).toEqual({ ok: false, error: "step: the step stopped once: a refusal or the limit, never two" })
  })
})

describe("a claim, judged against what the envelope's histories owe", () => {
  const input = envelope("implementor", [done, red], [timebox])
  test("`ready` with a runnable item left (control 4) is refused; the owed claim is admitted, in any item order", () => {
    const claim = owedOf(input)
    expect(admitted(input, claim)).toEqual([])
    expect(admitted(input, { ...claim, items: [...claim.items].reverse() })).toEqual([])
    expect(admitted(input, { ...claim, verdict: "ready", writes: ["request"], stop: [] })).toEqual(["verdict: due blocked, given ready", "writes: due [state, blocked], given [request]", `stop limit: due "timebox 2 h", given none`])
  })
  test("the limit is compared with the observed one: another length, a placeholder or a missing one is refused", () => {
    const claim = owedOf(input)
    expect(claim.stop).toEqual([{ id: "limit", value: "timebox 2 h" }])
    for (const value of ["timebox 3 h", "nothing", "failure cap 2", ""]) expect([value, admitted(input, { ...claim, stop: [{ id: "limit", value }] }).length]).toEqual([value, 1])
  })
  test("a count is admitted in exactly the recorded spelling, not by parsing equivalent numbers", () => {
    const count = envelope("implementor", [red], [{ kind: "limit", limit: { kind: "failureCap", count: Number.MAX_SAFE_INTEGER } }])
    const claim = owedOf(count)
    expect(claim.stop).toEqual([{ id: "limit", value: "failure cap 9007199254740991" }])
    expect(admitted(count, claim)).toEqual([])
    for (const value of ["failure cap 09007199254740991", "failure cap 9007199254740991\n", "failure cap 9007199254740992"]) {
      expect(admitted(count, { ...claim, stop: [{ id: "limit", value }] })).toHaveLength(1)
    }
  })
  test("a held command can contain separators without making the trailing exit ambiguous", () => {
    const waiting = envelope("verifier", [{
      id: "gate",
      assignment: assigned,
      events: [begin("a", "first (exit 123)\nnext; form: fixture"), finish("a", "unclear", 0), { kind: "waitOpen", ref: "q1" }],
    }])
    const claim = owedOf(waiting)
    const value = "first (exit 123)\nnext; form: fixture (exit 0)"
    expect(claim.stop).toEqual([{ id: "held", item: "gate", value }])
    expect(admitted(waiting, claim)).toEqual([])
    for (const changed of [`${value}\n`, value.replace("(exit 0)", "(exit -0)"), value.replace("(exit 0)", "(exit 00)")]) {
      expect(admitted(waiting, { ...claim, stop: [{ id: "held", item: "gate", value: changed }] })).toHaveLength(1)
    }
  })
  test("each refusal remedy occupies its own exact field, even when its text contains another field's separator", () => {
    const what = "write; form: fixture"
    const forms = [{ kind: "none" }, { kind: "named", form: "! command; form: fixture" }, { kind: "allow", allow: "allow; form: fixture" }] as const
    for (const form of forms) {
      const stopped = envelope("verifier", [done], [{ kind: "writeDenied", artifact: "findings", refusal: { ...refusal(what), form } }])
      const claim = owedOf(stopped)
      expect(admitted(stopped, claim)).toEqual([])
      switch (form.kind) {
        case "none":
          expect(claim.stop).toEqual([{ id: "refused.what", value: what }])
          expect(admitted(stopped, { ...claim, stop: [...claim.stop, { id: "refused.form", value: "none" }] })).toHaveLength(1)
          break
        case "named":
          expect(claim.stop).toEqual([{ id: "refused.what", value: what }, { id: "refused.form", value: form.form }])
          expect(admitted(stopped, { ...claim, stop: [{ id: "refused.what", value: what }, { id: "refused.allow", value: form.form }] })).toHaveLength(2)
          break
        case "allow":
          expect(claim.stop).toEqual([{ id: "refused.what", value: what }, { id: "refused.allow", value: form.allow }])
          expect(admitted(stopped, { ...claim, stop: [{ id: "refused.what", value: what }, { id: "refused.form", value: form.allow }] })).toHaveLength(2)
          break
      }
    }
  })
  test("forged evidence (control 3): a flag beside the evidence, or an unknown claim member, is rejected before any value is read", () => {
    const claim = owedOf(input)
    expect(admitted(input, Object.assign({}, claim, { lastAttempt: true }))).toEqual([`claim: Expected no excess property   at ["lastAttempt"]`])
    const flagged = { ...claim, items: claim.items.map((one) => Object.assign({}, one, { lastAttempt: true })) }
    expect(admitted(input, flagged)[0]?.startsWith("claim: Expected no excess property")).toBe(true)
  })
  test("a same-looking run with another receipt, head or command is refused, naming both values", () => {
    const claim = owedOf(input)
    for (const [key, value] of [["receipt", "rcpt:8"], ["head", "head:b"], ["command", "cmd:other"]] as const) {
      expect([key, admitted(input, withRun(claim, { [key]: value }, (item) => item === "gate")).length]).toEqual([key, 1])
    }
  })
  test("values compared member by member (B1): an id and a command that print alike are still two values", () => {
    const spaced = envelope("implementor", [{ id: "gate", assignment: assigned, events: [begin("att-7", "verify command=fixture"), finish("att-7", "fail", 1)] }], [timebox])
    const claim = owedOf(spaced)
    expect(admitted(spaced, withRun(claim, { id: "att-7 command=verify", command: "fixture" }, () => true)).length).toBe(1)
    expect(admitted(spaced, claim)).toEqual([])
  })
  test("absence told by leaving the value out (B2): the truthful empty stop is admitted, a placeholder is refused", () => {
    const clean = envelope("implementor", [done])
    const claim = owedOf(clean)
    expect([claim.stop, admitted(clean, claim)]).toEqual([[], []])
    expect(admitted(clean, { ...claim, stop: [{ id: "held", item: "spec", value: "nothing" }] })).toEqual([`stop held: due none, given "spec": "nothing"`])
  })
  test("a step no history produces (stopped idle with a runnable item) is no checked step at all", () => {
    expect(decode(envelope("implementor", [done, red]))).toEqual({ ok: false, error: "step: the step goes on while a runnable item is left" })
  })
})

describe("ownership: the checked step owns deep-frozen copies", () => {
  test("every input object mutated after decode, at every depth, changes no later answer", () => {
    // Fresh objects each call: the input mutated below shares nothing with the other tests' fixtures.
    const fresh = () =>
      envelope("implementor", [
        { id: "spec", assignment: { kind: "assigned", required: true }, events: [begin("att-1", "cmd:spec"), finish("att-1", "pass", 0)] },
        { id: "gate", assignment: { kind: "assigned", required: true }, events: [begin("att-7", "cmd:gate"), finish("att-7", "fail", 1), { kind: "waitOpen", ref: "ref:x" }] },
      ])
    const input = fresh()
    const checked = checkedOf(input)
    const before = encodeJson(owed(checked))
    const claim = owedOf(fresh())
    /** Every object reachable from the roots, the roots included. */
    const objectsIn = (roots: ReadonlyArray<object>): Array<object> => roots.flatMap((root) => [root, ...objectsIn(Object.values(root).filter((inner) => inner === Object(inner)))])
    const objects = objectsIn([input])
    // No object the checked step or its answer holds is one the caller handed in.
    const answer = owed(checked)
    const held = [...objectsIn([checked.records]), ...objectsIn([checked.envelope])]
    if (answer.ok) held.push(...objectsIn([answer.value]))
    expect([answer.ok, held.filter((one) => objects.includes(one)).length]).toEqual([true, 0])
    expect(held.every((one) => Object.isFrozen(one))).toBe(true)
    for (const one of objects) {
      for (const [key, value] of Object.entries(one)) {
        if (Predicate.isString(value)) Object.assign(one, { [key]: `${value}:mutated` })
        if (Predicate.isNumber(value)) Object.assign(one, { [key]: value + 1 })
        if (Predicate.isBoolean(value)) Object.assign(one, { [key]: !value })
      }
      if (Array.isArray(one)) one.push({ kind: "settle" })
    }
    expect(encodeJson(owed(checked))).toBe(before)
    expect(admit(checked)(claim)).toEqual([])
  })
})
