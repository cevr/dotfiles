// The page's view over invented data: the project → message shape (pinning, the cut before "earlier", Later, colour
// from data only), the timeline's spans and labels, and a model of read / unread / later against a reference map
// with a manual clock, Later's return at 6:00 AM checked on both sides of it and of a clock change.
import { describe, expect, test } from "bun:test"
import { Option, Result } from "effect"
import { DigestEvent as E, VERSION } from "./event.ts"
import { EMPTY, fold } from "./fold.ts"
import { decodeMarks, encodeMark, foldMarks, type MarkLine, markOf, nameOf, NO_MARKS, sinceOf, Standing, standing } from "./marks.ts"
import { type Message, type Page, pageOf } from "./messages.ts"
import { cutOf, inboxOrder, LIMIT, spansOf, viewOf } from "./view.ts"
import { nextMorning } from "./zone.ts"

const HOUR = 3_600_000
const NY = "America/New_York"
const MONTREAL = "America/Montreal"
/** Friday 2026-11-20, 3:00 PM in New York (20:00 UTC). */
const NOW = 1_795_204_800_000

/** An ISO instant's epoch milliseconds. */
const at = (iso: string): number => Temporal.Instant.from(iso).epochMilliseconds
const iso = (t: number): string => Temporal.Instant.fromEpochMilliseconds(t).toString()

/** A seeded generator (mulberry32). */
const random = (start: number) => {
  let seed = start
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

const message = (id: string, t: number, open = false, level: Message["level"] = "ok"): Message => ({
  id,
  src: `item:${id}`,
  kind: "shipped",
  level,
  subject: `Subject ${id}.`,
  body: "",
  t,
  units: [],
  ask: Option.none(),
  decided: Option.none(),
  open,
  root: "r",
})

const pageWith = (messages: ReadonlyArray<Message>): Page => ({
  projects: [{ id: "harbor", name: "harbor", where: "harbor · Mac", host: "mac", repo: "harbor", roots: ["r"], level: "none", headline: "", messages }],
  evidence: {},
})

const projectOf = (messages: ReadonlyArray<Message>, marks = NO_MARKS, now = NOW) => viewOf(pageWith(messages), marks, now, NY).projects[0]!

describe("the project's messages", () => {
  test("every open needs-you is above every other row, oldest question first; then the rest newest first", () => {
    const next = random(7)
    for (let run = 0; run < 200; run++) {
      const messages = Array.from({ length: Math.floor(next() * 30) }, (_, each) => message(`m${each}`, NOW - Math.floor(next() * 200) * HOUR, next() < 0.2))
      const inbox = projectOf(messages).inbox
      const pinned = inbox.filter((each) => each.pinned)
      expect(inbox.slice(0, pinned.length).every((each) => each.pinned)).toBe(true)
      expect(pinned.map((each) => each.t)).toEqual(pinned.map((each) => each.t).toSorted((a, b) => a - b))
      const rest = inbox.slice(pinned.length).map((each) => each.t)
      expect(rest).toEqual(rest.toSorted((a, b) => b - a))
    }
  })

  test("at most 7 rows before earlier, and a pinned message is never behind it", () => {
    const many = Array.from({ length: 20 }, (_, each) => message(`m${each}`, NOW - each * HOUR))
    expect(projectOf(many).cut).toBe(LIMIT)
    const asks = Array.from({ length: 9 }, (_, each) => message(`q${each}`, NOW - each * HOUR, true))
    const view = projectOf([...many, ...asks])
    expect(view.cut).toBe(9)
    expect(view.inbox.slice(0, view.cut).every((each) => each.pinned)).toBe(true)
    expect(cutOf([{ pinned: false }, { pinned: false }])).toBe(2)
    expect(inboxOrder([])).toEqual([])
  })

  test("a message with no level is never red; red comes from `level: red`, whatever the words", () => {
    const item = (id: string, t: number, text: string, level: Option.Option<"red">) =>
      E.cases.Item.make({ v: VERSION, t, root: "r", id, text, state: "running", owner: "mine", who: Option.none(), level, unit: Option.none() })
    const events = [
      E.cases.Run.make({ v: VERSION, t: 1, root: "r", host: "mac", repo: "harbor", dir: Option.none(), name: Option.some("harbor") }),
      item("a", NOW - HOUR, "Everything FAILED, blocked and urgent.", Option.none()),
      item("b", NOW - 2 * HOUR, "Quiet words.", Option.some("red")),
    ]
    const inbox = viewOf(pageOf(fold(EMPTY, events), { names: new Map() }), NO_MARKS, NOW, NY).projects[0]!.inbox
    expect(inbox.map((each) => [each.subject, each.level])).toEqual([
      ["Everything FAILED, blocked and urgent.", "none"],
      ["Quiet words.", "red"],
    ])
  })

  test("the timeline's marks are in time order whatever the pinning, a pinned message at its own time", () => {
    const project = projectOf([message("old-ask", NOW - 40 * HOUR, true), message("new", NOW - HOUR), message("mid", NOW - 10 * HOUR, false, "red")])
    expect(project.inbox.map((each) => each.id)).toEqual(["old-ask", "new", "mid"])
    expect(project.marks.map((each) => [each.id, each.t, each.red])).toEqual([
      ["old-ask", NOW - 40 * HOUR, false],
      ["mid", NOW - 10 * HOUR, true],
      ["new", NOW - HOUR, false],
    ])
  })

  test("a renamed project shows its name and keeps its default; an empty rename puts the default back", () => {
    const project = projectOf([], foldMarks([nameOf("harbor", "Harbor Lights", 1)]))
    expect([project.name, project.defaultName]).toEqual(["Harbor Lights", "harbor"])
    expect(projectOf([], foldMarks([nameOf("harbor", "Harbor Lights", 1), nameOf("harbor", " ", 2)])).name).toBe("harbor")
  })

  test("times are AM/PM: today by the clock, another day with its name", () => {
    expect(projectOf([message("a", NOW - HOUR), message("b", NOW - 30 * HOUR)]).inbox.map((each) => each.when)).toEqual(["2:00 PM", "Thu 9:00 AM"])
  })
})

describe("the timeline", () => {
  test("6-hour wall-clock spans from the first message's span to now, labelled, the day named at midnight", () => {
    const spans = spansOf(NOW - 30 * HOUR, NOW, NY)
    expect(spans.map((span) => [Option.getOrElse(span.day, () => ""), span.label])).toEqual([
      ["Thu", "6 AM"],
      ["", "12 PM"],
      ["", "6 PM"],
      ["Fri", "12 AM"],
      ["", "6 AM"],
      ["", "12 PM"],
    ])
    expect(spans.at(-1)!.name).toBe("Friday, 12 PM to now (3:00 PM)")
    expect(spans.at(-1)!.end).toBe(NOW)
    expect(spans.slice(1).every((span, each) => span.start === spans[each]!.end)).toBe(true)
  })

  test("a clock change day keeps the spans on the wall clock: one is 7 hours long", () => {
    // 2026-11-01, New York falls back at 2 AM.
    const spans = spansOf(at("2026-11-01T04:30:00Z"), at("2026-11-01T20:00:00Z"), NY)
    expect(spans.map((span) => span.label)).toEqual(["12 AM", "6 AM", "12 PM"])
    expect((spans[0]!.end - spans[0]!.start) / HOUR).toBe(7)
  })

  test("with no messages the timeline is today's spans; the view says when he last read", () => {
    const view = viewOf(pageWith([]), foldMarks([sinceOf(NOW - 2 * HOUR), markOf("x", NOW - HOUR, "read")]), NOW, NY)
    expect(view.spans.map((span) => span.label)).toEqual(["12 AM", "6 AM", "12 PM"])
    expect([view.since, view.lastRead, view.lastReadLabel]).toEqual([Option.some(NOW - 2 * HOUR), Option.some(NOW - HOUR), Option.some("2:00 PM")])
  })
})

describe("Later returns at 6:00 AM in the zone", () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    [MONTREAL, "2026-11-20T07:00:00Z", "2026-11-20T11:00:00Z"], // 2 AM set aside, back 6 AM that day
    [MONTREAL, "2026-11-20T11:00:00Z", "2026-11-21T11:00:00Z"], // exactly 6 AM: the next morning
    [MONTREAL, "2026-11-20T10:59:59.999Z", "2026-11-20T11:00:00Z"], // a millisecond before 6 AM
    [MONTREAL, "2026-11-01T03:00:00Z", "2026-11-01T11:00:00Z"], // fall back: 11 PM EDT the night before, 6 AM EST
    [MONTREAL, "2026-03-08T04:00:00Z", "2026-03-08T10:00:00Z"], // spring forward: 11 PM EST, 6 AM EDT
    ["UTC", "2026-11-20T05:59:00Z", "2026-11-20T06:00:00Z"],
    ["UTC", "2026-11-20T18:00:00Z", "2026-11-21T06:00:00Z"],
  ]
  for (const [zone, aside, back] of cases)
    test(`${zone}: set aside ${aside}, back ${back}`, () => {
      expect(iso(nextMorning(at(aside), zone))).toBe(iso(at(back)))
    })

  test("generated times on both sides of 6 AM and of a clock change: always a 6:00 AM, after, within a day, and the first", () => {
    const next = random(11)
    const around = [at("2026-11-01T10:00:00Z"), at("2026-03-08T10:00:00Z"), at("2026-11-20T11:00:00Z")]
    for (let run = 0; run < 2_000; run++) {
      const zone = [MONTREAL, "UTC"][run % 2]!
      const t = around[run % around.length]! + Math.floor((next() - 0.5) * 72 * HOUR)
      const back = nextMorning(t, zone)
      const wall = Temporal.Instant.fromEpochMilliseconds(back).toZonedDateTimeISO(zone)
      expect([back > t, back - t <= 25 * HOUR, wall.hour, wall.minute, nextMorning(back - 1, zone)]).toEqual([true, true, 6, 0, back])
    }
  })
})

/** The reference's standing of a message born at `t`, with the reference's last change `ref`, at `now`. */
type Ref = { readonly kind: "read" | "unread" | "none"; readonly back: number }
const referenceStanding = (ref: Ref, t: number, since: number, now: number): Standing => {
  if (ref.kind === "none") return Standing.cases.Inbox.make({ unread: t > since })
  if (ref.back > 0 && now < ref.back) return Standing.cases.Later.make({ returnsAt: ref.back })
  return Standing.cases.Inbox.make({ unread: ref.kind === "unread" })
}

describe("read, unread and later against a reference", () => {
  test("a model with a manual clock: each step's standing equals the reference map's, whatever order the lines are read in", () => {
    const next = random(23)
    for (let run = 0; run < 200; run++) {
      const ids = ["a", "b", "c"]
      const born = new Map(ids.map((id) => [id, NOW - Math.floor(next() * 48) * HOUR] as const))
      const since = NOW - 24 * HOUR
      const lines: Array<MarkLine> = [sinceOf(since)]
      const reference = new Map<string, Ref>(ids.map((id) => [id, { kind: "none", back: 0 }] as const))
      let clock = NOW
      for (let step = 0; step < 30; step++) {
        clock += Math.floor(next() * 10 * HOUR)
        const id = ids[Math.floor(next() * ids.length)]!
        const kind = (["read", "unread", "later", "later", "none"] as const)[Math.floor(next() * 5)]!
        if (kind === "later") {
          const back = nextMorning(clock, MONTREAL)
          lines.push(markOf(id, clock, "later", Option.some(back)))
          // A returned Later is unread.
          reference.set(id, { kind: "unread", back })
        }
        if (kind === "read" || kind === "unread") {
          lines.push(markOf(id, clock, kind))
          reference.set(id, { kind, back: 0 })
        }
        const marks = foldMarks(lines.toSorted(() => next() - 0.5))
        for (const each of ids) {
          const ref = reference.get(each)!
          expect(standing(marks, each, born.get(each)!, clock)).toEqual(referenceStanding(ref, born.get(each)!, since, clock))
          // Back at returnsAt and not one millisecond before.
          if (ref.back > clock) expect([standing(marks, each, 0, ref.back - 1)._tag, standing(marks, each, 0, ref.back)]).toEqual(["Later", Standing.cases.Inbox.make({ unread: true })])
        }
      }
    }
  })

  test("a message in Later leaves the inbox for the Later group and is back, unread and pinned again when open", () => {
    const back = nextMorning(NOW, NY)
    const messages = [message("ask", NOW - 5 * HOUR, true), message("x", NOW - HOUR)]
    const marks = foldMarks([markOf("ask", NOW, "later", Option.some(back))])
    const away = projectOf(messages, marks, NOW + HOUR)
    expect([away.inbox.map((each) => each.id), away.later.map((each) => [each.id, each.returnsAt])]).toEqual([["x"], [["ask", Option.some(back)]]])
    expect(projectOf(messages, marks, back).inbox.map((each) => [each.id, each.pinned, each.unread])).toEqual([
      ["ask", true, true],
      ["x", false, true],
    ])
  })

  test("before his first visit everything is unread; after it, only what is newer and unmarked", () => {
    const messages = [message("old", NOW - 10 * HOUR), message("new", NOW - HOUR)]
    expect(projectOf(messages).unread).toBe(2)
    expect(projectOf(messages, foldMarks([sinceOf(NOW - 5 * HOUR)])).inbox.map((each) => [each.id, each.unread])).toEqual([
      ["new", true],
      ["old", false],
    ])
  })
})

describe("the marks' stored format", () => {
  test("a line of an unknown version is a clear error naming the file and line, never skipped", () => {
    const decoded = decodeMarks(`${encodeMark(markOf("a", 1, "read"))}\n{"_tag":"Mark","v":2,"t":2,"id":"a","mark":"read"}\n`, "read.jsonl")
    expect(Result.match(decoded, { onSuccess: () => "", onFailure: (error) => error.message })).toContain("read.jsonl line 2 has version 2; this build reads version 1")
  })

  test("a torn line is skipped and counted", () => {
    const good = encodeMark(markOf("a", 1, "read"))
    expect(Result.map(decodeMarks(`${good}\n${good.slice(0, 12)}`, "read.jsonl"), (read) => [read.lines.length, read.bad])).toEqual(Result.succeed([1, 1]))
  })
})
