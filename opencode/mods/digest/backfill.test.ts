import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { backfill, rowsOf, type RunStores } from "./backfill.ts"
import { isItem } from "./fold.ts"

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Json))

const run: RunStores = {
  id: "demo",
  host: "mac",
  session: "ses_root",
  repo: Option.none(),
  queue: Option.some(
    json({
      items: [
        { id: "billing", text: "(checked 12:00) Billing is in round 2.", state: "running", owner: "mine" },
        { id: "sign-in", text: "Sign in to the store and send the code.", state: "waiting", owner: "other", who: "you" },
      ],
      touched: { billing: 300, "sign-in": 310 },
    }),
  ),
  inbox: [
    json({ type: "synthetic", t: 100, text: '<subagent description="implementor billing r1">\nimplementor billing r1: ready /t/billing/round-1-request.md', metadata: { source: "subagent", childID: "ses_a" } }),
    json({ type: "synthetic", t: 200, text: '<subagent description="verifier batch-x r1">\nverifier batch-x r1: changes /t/verify-x/batch-x-findings.md', metadata: { source: "subagent", childID: "ses_b" } }),
    json({ type: "synthetic", t: 250, text: "lane land: the accept check for feat/billing FAILED (exit 1).", metadata: { rift: "land" } }),
    json({ type: "synthetic", t: 260, metadata: { source: "questions", answers: [{ id: "q7", question: "Keep it?", assume: "Keep", answer: "Cut", matches: false }] } }),
    "{torn",
  ].join("\n"),
  children: json({ id: "ses_a", title: "implementor billing r1", agent: "implementor", c: 50, u: 100 }),
  units: [{ name: "verify-x", files: [{ name: "batch-x-findings.md", mtime: 201, text: "changes\n\n| Unit | Round | Verdict |\n| --- | --- | --- |\n| billing (abc) | r1 | **changes**: M1 |\n| search | 2 | accepted |" }] }],
}

describe("backfill", () => {
  const events = backfill({ runs: [run], updates: [{ host: "mac", text: "2026-01-02T03:04:05.000Z mac handoff: the build is proven and recorded as the good build" }] })
  const tags: ReadonlyArray<string> = events.map((event) => event._tag)

  test("gives the events the writers write now, from the old stores", () => {
    expect(tags.toSorted()).toEqual(["Answered", "Check", "HandBack", "Install", "Item", "Item", "Run", "Start", "Verdict", "Verdict"].toSorted())
  })

  test("a verifier's hand-back reads its findings' table, one row per unit", () => {
    const verdict = events.find((event) => event._tag === "Verdict" && event.session === "ses_b")
    expect(verdict?._tag === "Verdict" && verdict.units).toEqual([
      { unit: "billing", round: 1, verdict: "changes" },
      { unit: "search", round: 2, verdict: "accepted" },
    ])
  })

  test("an item another must do, and that other is him, needs him; an item named as a unit holds it", () => {
    const items = events.filter(isItem).map((item) => [item.id, item.state, Option.getOrElse(item.unit, () => "-"), item.text])
    expect(items).toEqual([
      ["billing", "running", "billing", "Billing is in round 2."],
      ["sign-in", "needs-you", "-", "Sign in to the store and send the code."],
    ])
  })

  test("a failed accept check, the owner's answer and an install keep their own words", () => {
    const check = events.find((event) => event._tag === "Check")
    expect(check?._tag === "Check" && [check.ok, check.text]).toEqual([false, "the accept check for feat/billing FAILED (exit 1)."])
    const answer = events.find((event) => event._tag === "Answered")
    expect(answer?._tag === "Answered" && [answer.answer, answer.matches, Option.getOrNull(answer.assume)]).toEqual(["Cut", false, "Keep"])
    const install = events.find((event) => event._tag === "Install")
    expect(install?._tag === "Install" && [install.outcome, install.t]).toEqual(["proven", Date.parse("2026-01-02T03:04:05.000Z")])
  })

  test("rowsOf skips the header and reads both round forms", () => {
    expect(rowsOf("| Unit | Round | Verdict |\n| a | r3 | stuck |\n| b | 1 | accepted |").map((row) => row.round)).toEqual([3, 1])
  })
})
