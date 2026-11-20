import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { byteLength, decodeLine, type DigestEvent, encodeLine, MAX_LINE } from "@dotfiles/opencode-digest/event"
import { checkFact, findingsPathOf, findingsRowsOf, handBackFact, landFact, laneFacts, startFact } from "./digest.ts"

const T = 1_000

/** An event as its line read back: each fact the run writes is one valid line. */
const line = (event: DigestEvent) => {
  const text = encodeLine(event)
  expect(byteLength(text)).toBeLessThanOrEqual(MAX_LINE)
  return Option.getOrThrow(decodeLine(text))
}

const FINDINGS = "accepted\n\n| Unit | Round | Verdict |\n| --- | --- | --- |\n| billing (abc1234) | r2 | accepted |\n| search | 1 | **changes**: M1 |"

describe("the run's digest lines", () => {
  test("a lane writes the run's record and the unit's lane with its purpose", () => {
    const facts = laneFacts("ses_root", "billing", { path: "/w/billing", branch: "feat/billing", head: "abc", state: "clean", purpose: "Bill each seat once" }, { host: "mac", repo: "demo", runDir: Option.some("/t/run-7") }, T).map(line)
    expect(facts.map((each) => each._tag)).toEqual(["Run", "Lane"])
    const [run, lane] = facts
    expect(run?._tag === "Run" && [run.repo, Option.getOrNull(run.name)]).toEqual(["demo", "run-7"])
    expect(lane?._tag === "Lane" && Option.getOrNull(lane.purpose)).toBe("Bill each seat once")
  })

  test("a step's start names its role, unit and round; another agent's call writes none", () => {
    const started = Option.map(startFact("ses_root", "ses_c", "implementor", "implementor billing r2", T), line)
    expect(Option.map(started, (event) => event._tag === "Start" && [event.unit, event.round])).toEqual(Option.some(["billing", 2]))
    expect(startFact("ses_root", "ses_c", "general", "look around", T)).toEqual(Option.none())
    expect(startFact("ses_root", "ses_c", "verifier", "implementor billing r2", T)).toEqual(Option.none())
  })

  test("an implementor's hand-back carries its Digest: line; with none, it says none", () => {
    const words = "implementor billing r2: ready /t/billing/round-2-request.md\nDigest: Each seat is billed once. The test is green.\n\nmore"
    const said = Option.map(handBackFact("ses_root", "ses_c", "implementor", words, Option.none(), T), line)
    expect(Option.map(said, (event) => event._tag === "HandBack" && [event.unit, event.round, event.verdict, Option.getOrNull(event.digest)])).toEqual(
      Option.some(["billing", 2, "ready", "Each seat is billed once. The test is green."]),
    )
    const bare = Option.map(handBackFact("ses_root", "ses_c", "implementor", "implementor billing r1: blocked /t/billing/blocked.md", Option.none(), T), line)
    expect(Option.map(bare, (event) => event._tag === "HandBack" && [event.verdict, Option.isNone(event.digest)])).toEqual(Option.some(["blocked", true]))
    expect(handBackFact("ses_root", "ses_c", "implementor", "Still working on it.", Option.none(), T)).toEqual(Option.none())
  })

  test("a verifier's verdict carries its findings' rows, one per unit", () => {
    const words = "verifier batch-7 r1: accepted /t/verify-7/batch-7-findings.md\nDigest: Both units hold."
    expect(findingsPathOf("verifier", words)).toEqual(Option.some("/t/verify-7/batch-7-findings.md"))
    const verdict = Option.map(handBackFact("ses_root", "ses_v", "verifier", words, Option.some(FINDINGS), T), line)
    expect(Option.map(verdict, (event) => event._tag === "Verdict" && [event.batch, event.verdict, event.units])).toEqual(
      Option.some(["batch-7", "accepted", [{ unit: "billing", round: 2, verdict: "accepted" }, { unit: "search", round: 1, verdict: "changes" }]]),
    )
    expect(findingsRowsOf("| Unit | Round | Verdict |")).toEqual([])
  })

  test("a land is one line; a land notice's failed accept check is a red check, its pass a green one, any other notice none", () => {
    const land = line(landFact("ses_root", ["billing", "search"], "abc1234", T))
    expect(land._tag === "Land" && land.units).toEqual(["billing", "search"])
    const checked = (text: string) => Option.map(Option.map(checkFact("ses_root", text, T), line), (event) => event._tag === "Check" && [event.ok, event.text])
    expect(checked("lane land: the accept check for feat/billing FAILED (exit 1) in 50s.\nlog: /x")).toEqual(Option.some([false, "the accept check for feat/billing FAILED (exit 1) in 50s."]))
    expect(checked("rift land: the accept check for feat/billing passed in 9s.")).toEqual(Option.some([true, "the accept check for feat/billing passed in 9s."]))
    expect(checkFact("ses_root", "lane land: landed 2 lanes.", T)).toEqual(Option.none())
  })
})
