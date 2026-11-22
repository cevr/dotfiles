// A reason's shared type and its checks (reasons.ts): the public payload decoded to a closed union and encoded once to
// its canonical pointer, decoded strictly back; the kinds not shipped refused by name. The evidence reader on real files
// is node/evidence.test.ts (the domain fence keeps node:*, bun and the test helpers out of the root).
import { describe, expect, test } from "bun:test"
import { Option, Result } from "effect"
import { EVIDENCE_ROOT, pointerOf, type Referent, type ReferentInput, reasonFrom, referentOf } from "./reasons.ts"

const why = <A>(result: Result.Result<A, string>) => Result.match(result, { onFailure: (reason) => reason, onSuccess: () => "taken" })

describe("the reason payload", () => {
  test("each class takes its kinds; a kind not shipped is refused naming the unit that brings it", () => {
    const cases: ReadonlyArray<readonly ["guarantee" | "dependency" | "measured", ReferentInput, string]> = [
      ["guarantee", { kind: "invariant", id: "one-writer" }, "taken"],
      ["guarantee", { kind: "spec-item", id: "s1" }, "a spec-item referent is not available yet: it ships with spec-items (unit C)"],
      ["guarantee", { kind: "commitment", id: "a" }, "a guarantee reason takes a referent of kind invariant or spec-item; commitment is not one"],
      ["dependency", { kind: "commitment", id: "a" }, "taken"],
      ["dependency", { kind: "unit", id: "u1" }, "a unit referent is not available yet: it ships with hand-back-tools (unit D)"],
      ["dependency", { kind: "owner-question", id: "q1" }, "a owner-question referent is not available yet: it ships with hand-back-tools and question-reasons (units D, E)"],
      ["dependency", { kind: "receipt", path: `${EVIDENCE_ROOT}/r/x.json` }, "a dependency reason takes a referent of kind commitment or unit or owner-question; receipt is not one"],
      ["measured", { kind: "receipt", path: `${EVIDENCE_ROOT}/r/x.json` }, "taken"],
      ["measured", { kind: "invariant", id: "x" }, "a measured reason takes a referent of kind receipt; invariant is not one"],
    ]
    expect(cases.map(([reasonClass, referent]) => why(reasonFrom(reasonClass, referent)))).toEqual(cases.map(([, , expected]) => expected))
  })

  test("an id is a slug and a receipt a normalised path under the evidence root; neither is repeated in a refusal", () => {
    const refusals = [
      reasonFrom("dependency", { kind: "commitment", id: "has space" }),
      reasonFrom("dependency", { kind: "commitment", id: "" }),
      reasonFrom("measured", { kind: "receipt", path: "elsewhere/x.json" }),
      reasonFrom("measured", { kind: "receipt", path: `${EVIDENCE_ROOT}/../x.json` }),
      reasonFrom("measured", { kind: "receipt", path: `${EVIDENCE_ROOT}/./x.json` }),
      reasonFrom("measured", { kind: "receipt", path: `/${EVIDENCE_ROOT}/x.json` }),
      reasonFrom("measured", { kind: "receipt", path: `${EVIDENCE_ROOT}//x.json` }),
      reasonFrom("measured", { kind: "receipt", path: `${EVIDENCE_ROOT}/${"x".repeat(600)}` }),
    ].map(why)
    expect(refusals.filter((each) => each === "taken")).toEqual([])
    expect(refusals.filter((each) => each.includes("has space") || each.includes(`${EVIDENCE_ROOT}/..`) || each.includes("xxxx"))).toEqual([])
  })

  test("the pointer is encoded once and decoded strictly: every taken referent round-trips, anything else decodes to none", () => {
    const referents: ReadonlyArray<Referent> = [
      { kind: "invariant", id: "one-writer" },
      { kind: "commitment", id: "a.b_c-1" },
      { kind: "receipt", path: `${EVIDENCE_ROOT}/run-1/check.json` },
    ]
    expect(referents.map((each) => referentOf(pointerOf(each)))).toEqual(referents.map(Option.some))
    expect(referents.map(pointerOf)).toEqual(["invariant/one-writer", "commitment/a.b_c-1", `receipt/${EVIDENCE_ROOT}/run-1/check.json`])
    const malformed = ["", "invariant/", "invariant/has space", "nothing/x", "ask/q1", " invariant/x", "commitment/a/b", "receipt/elsewhere/x", `receipt/${EVIDENCE_ROOT}/../x`, `invariant/${"x".repeat(600)}`]
    expect(malformed.map(referentOf)).toEqual(malformed.map(() => Option.none()))
  })
})

