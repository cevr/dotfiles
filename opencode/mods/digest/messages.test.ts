import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { type DigestEvent, DigestEvent as E, VERSION } from "./event.ts"
import { EMPTY, fold } from "./fold.ts"
import { projectsOf } from "./messages.ts"

const v = VERSION
const run = (root: string, name: string, repo = "demo") => E.cases.Run.make({ v, t: 1, root, host: "mac", repo, dir: Option.none(), name: Option.some(name) })
const lane = (unit: string, purpose: string) => E.cases.Lane.make({ v, t: 2, root: "r", unit, purpose: Option.some(purpose), branch: Option.none(), path: Option.none() })
const back = (unit: string, round: number, digest: Option.Option<string>, t = 10) =>
  E.cases.HandBack.make({ v, t, root: "r", session: "s", role: "implementor", unit, round, verdict: "ready", file: Option.none(), digest })
const item = (id: string, text: string, extra: Partial<{ state: string; level: "red" | "green"; unit: string; t: number }> = {}) =>
  E.cases.Item.make({
    answer: Option.none(),
    choices: Option.none(),
    v,
    t: extra.t ?? 20,
    root: "r",
    id,
    text,
    state: extra.state ?? "running",
    owner: "mine",
    who: Option.none(),
    level: Option.fromUndefinedOr(extra.level),
    unit: Option.fromUndefinedOr(extra.unit),
  })

const projects = (events: ReadonlyArray<DigestEvent>) => projectsOf(fold(EMPTY, events), { names: new Map() })
const only = (events: ReadonlyArray<DigestEvent>) => projects(events)[0]!.project

describe("messages", () => {
  test("a hand-back with no Digest: line reads as the lane's purpose, handed back; never invented words", () => {
    const project = only([run("r", "demo"), lane("billing", "Bill each seat once"), back("billing", 1, Option.none())])
    expect(project.messages.map((message) => message.subject)).toEqual(["Bill each seat once: handed back"])
  })

  test("the Digest: line is the subject (its first sentence) and the body (the rest)", () => {
    const project = only([run("r", "demo"), lane("billing", "Bill once"), back("billing", 1, Option.some("Each seat is billed once. The test is green."))])
    expect(project.messages.map((message) => [message.subject, message.body])).toEqual([["Each seat is billed once.", "The test is green."]])
  })

  test("a unit sits under exactly one message: the item that names it, not its own", () => {
    const views = projects([run("r", "demo"), lane("billing", "Bill once"), back("billing", 1, Option.none()), item("billing", "Billing waits on a review.", { unit: "billing" })])
    const messages = views[0]!.project.messages
    expect(messages.length).toBe(1)
    expect(messages[0]!.units.map((unit) => unit.name)).toEqual(["billing"])
    expect(views[0]!.unitMessage.get("billing")).toBe(messages[0]!.id)
  })

  test("red comes from an item's level only, never from its words", () => {
    const words = only([run("r", "demo"), item("a", "FAILED and broken, URGENT.")])
    expect([words.level, words.messages[0]!.level]).toEqual(["none", "none"])
    const red = only([run("r", "demo"), item("a", "All quiet.", { level: "red" })])
    expect([red.level, red.messages[0]!.level]).toEqual(["red", "red"])
  })

  test("an open question needs him; once answered it is a decision, and says when it differed", () => {
    const asked = E.cases.Asked.make({ v, t: 5, root: "r", session: "s", id: "q1", question: "Keep the alias?", header: Option.none(), options: ["Keep", "Cut"], assume: "Keep" })
    const open = only([run("r", "demo"), asked])
    expect([open.level, open.messages[0]!.open, open.messages[0]!.kind]).toEqual(["need", true, "needs"])
    const answered = E.cases.Answered.make({ via: Option.none(), v, t: 6, root: "r", session: "s", id: "q1", answer: "Cut", matches: false, question: Option.none(), assume: Option.none() })
    const done = only([run("r", "demo"), asked, answered])
    expect(done.level).toBe("none")
    expect(done.messages.map((message) => [message.kind, Option.getOrNull(message.decided)])).toEqual([["decided", [{ q: "Keep the alias?", assumed: "Keep", said: "Cut", matches: false }]]])
  })

  test("a failed land check is red until a land follows it", () => {
    const failed = E.cases.Check.make({ v, t: 5, root: "r", ok: false, text: "the accept check for feat/x FAILED." })
    expect(only([run("r", "demo"), failed]).level).toBe("red")
    const landed = E.cases.Land.make({ v, t: 7, root: "r", units: ["x"], pushed: Option.none() })
    expect(only([run("r", "demo"), failed, landed]).level).toBe("none")
  })

  test("two runs of one repository are two projects, each named with its run", () => {
    const names = projects([run("r", "films"), E.cases.Run.make({ v, t: 1, root: "r2", host: "mac", repo: "demo", dir: Option.none(), name: Option.some("hymns") })]).map(
      (each) => each.project.name,
    )
    expect(names.toSorted()).toEqual(["demo · films", "demo · hymns"])
  })
})
