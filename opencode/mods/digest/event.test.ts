import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { byteLength, decodeLine, decodeLines, DigestEvent, digestLineOf, encodeLine, MAX_LINE, VERSION } from "./event.ts"

const item = DigestEvent.cases.Item.make({
  answer: Option.none(),
  choices: Option.none(),
  v: VERSION,
  t: 1_000,
  root: "ses_root",
  id: "billing",
  text: "Bill each seat once. Round 2 handed back.",
  state: "running",
  owner: "mine",
  who: Option.none(),
  level: Option.some("red"),
  unit: Option.some("billing"),
})

describe("a digest line", () => {
  test("round-trips, its absent fields left out", () => {
    const line = encodeLine(item)
    expect(line).not.toContain("who")
    expect(decodeLine(line)).toEqual(Option.some(item))
  })

  test("an old line with no field added since decodes, the field absent", () => {
    const old = '{"_tag":"Item","v":1,"t":5,"root":"r","id":"a","text":"x","state":"done","owner":"mine"}'
    const read = decodeLine(old)
    expect(Option.map(read, (event) => event._tag === "Item" && Option.isNone(event.level))).toEqual(Option.some(true))
  })

  test("an answer line from before `via`, and an item from before `answer`, decode with none; new ones keep them", () => {
    const answered = '{"_tag":"Answered","v":1,"t":5,"root":"r","session":"s","id":"q1","answer":"Keep it","matches":true}'
    expect(Option.map(decodeLine(answered), (event) => event._tag === "Answered" && Option.isNone(event.via))).toEqual(Option.some(true))
    expect(Option.map(decodeLine('{"_tag":"Item","v":1,"t":5,"root":"r","id":"a","text":"x","state":"needs-you","owner":"mine"}'), (event) => event._tag === "Item" && Option.isNone(event.answer))).toEqual(Option.some(true))
    const given = encodeLine({ ...item, answer: Option.some("Friday") })
    expect(Option.map(decodeLine(given), (event) => (event._tag === "Item" ? Option.getOrUndefined(event.answer) : undefined))).toEqual(Option.some("Friday"))
  })

  test("a newer line with a field this reader does not know decodes, the field dropped", () => {
    const newer = '{"_tag":"Check","v":2,"t":5,"root":"r","ok":false,"text":"the accept check FAILED","exit":1}'
    expect(Option.map(decodeLine(newer), (event) => event._tag)).toEqual(Option.some("Check"))
  })

  test("a torn, foreign or unknown line is skipped and counted, never stops the read", () => {
    const log = [encodeLine(item), '{"_tag":"Item","v":1,"t":', "not json", '{"_tag":"Comet","v":1,"t":1}', "", encodeLine(item)].join("\n")
    const read = decodeLines(log)
    expect(read.events.length).toBe(2)
    expect(read.bad).toBe(3)
  })

  test("never over MAX_LINE bytes, ids and times whole, however long its texts", () => {
    const long = "é😀x".repeat(3_000)
    const verdict = DigestEvent.cases.Verdict.make({
      v: VERSION,
      t: 7,
      root: "ses_root",
      session: "ses_child",
      batch: "batch-7",
      round: 1,
      verdict: "accepted",
      file: Option.some(long),
      digest: Option.some(long),
      units: Array.from({ length: 400 }, (_, at) => ({ unit: `unit-${at}`, round: 1, verdict: "accepted" })),
    })
    const line = encodeLine(verdict)
    expect(byteLength(line)).toBeLessThanOrEqual(MAX_LINE)
    const read = decodeLine(line)
    expect(Option.map(read, (event) => [event._tag, event.t, event._tag === "Verdict" && event.batch])).toEqual(Option.some(["Verdict", 7, "batch-7"]))
  })
})

describe("the Digest: line", () => {
  test("is read from the first lines, after the hand-back line", () => {
    expect(digestLineOf("implementor billing r2: ready /x/round-2-request.md\nDigest: Each seat is billed once. The test is green.")).toEqual(
      Option.some("Each seat is billed once. The test is green."),
    )
    expect(digestLineOf("ready\n**Digest:** Shipped.")).toEqual(Option.some("Shipped."))
  })

  test("is none when missing or empty", () => {
    expect(digestLineOf("implementor billing r2: ready /x\n\nNo line here")).toEqual(Option.none())
    expect(digestLineOf("ready\nDigest:   ")).toEqual(Option.none())
  })
})
