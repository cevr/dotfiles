import { describe, expect, test } from "bun:test"
import { DateTime, Option } from "effect"
import type { Item } from "./item.ts"
import { acknowledgedOf, CAP, due, type Facts, GAP_MS, GRACE_MS, hashesOf, keyOf, type Linked, noteOf, REPEAT_MS, staleOf, UNTOUCHED_MS } from "./stale.ts"

const NOW = Date.parse("2026-11-18T12:00:00Z")
const HOUR = 60 * 60_000
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms))

const item = (id: string, state: Item["state"], extra: Partial<Item> = {}): Item => ({ id, text: `the ${id}`, state, owner: "mine", ...extra })

const facts = (extra: Partial<Facts> = {}): Facts => ({ now: NOW, touched: {}, linked: new Map(), openQuestions: Option.some(1), endedWakes: new Set(), unlanded: new Map(), acknowledged: new Set(), ...extra })

const reasons = (items: ReadonlyArray<Item>, given: Partial<Facts>) => staleOf(items, facts(given)).map((each) => [each.id, each.reason])

describe("staleOf", () => {
  test("an item whose subagent ended or is gone while it still runs or waits is stale; a running one, a fresh end or a done item is not", () => {
    const items = [
      item("ended", "running", { session: "ses_a" }),
      item("gone", "waiting", { session: "ses_b" }),
      item("live", "running", { session: "ses_c" }),
      item("just", "running", { session: "ses_d" }),
      item("over", "done", { session: "ses_a" }),
      item("planned", "next", { session: "ses_a" }),
    ]
    const touched = Object.fromEntries(items.map((each) => [each.id, NOW - HOUR]))
    const linked = new Map<string, Linked>([
      ["ses_a", { state: "idle", since: NOW - GRACE_MS, outcome: Option.some("succeeded") }],
      ["ses_b", { state: "gone" }],
      ["ses_c", { state: "busy" }],
      ["ses_d", { state: "idle", since: NOW - GRACE_MS + 1, outcome: Option.none() }],
    ])
    expect(reasons(items, { touched, linked })).toEqual([
      ["ended", "its session ses_a ended (succeeded) at 2026-11-18 11:30 UTC"],
      ["gone", "its session ses_b no longer exists"],
    ])
  })

  test("an item naming a wake or monitor that ended is stale", () => {
    const items = [item("ci", "waiting", { detail: "monitor w0ab12c on CI" }), item("other", "waiting", { text: "watching w9zz99z" })]
    expect(reasons(items, { touched: { ci: NOW, other: NOW }, endedWakes: new Set(["w0ab12c"]) })).toEqual([
      ["ci", "the wake or monitor w0ab12c it names is no longer pending"],
    ])
  })

  test("a needs-you item is stale when no question is open, past the grace; not when one is open or the questions plugin did not answer", () => {
    const items = [item("login", "needs-you"), item("fresh", "needs-you")]
    const touched = { login: NOW - GRACE_MS, fresh: NOW - GRACE_MS + 1 }
    expect(reasons(items, { touched, openQuestions: Option.some(0) })).toEqual([["login", "no ask_user_async question of yours is open: it was answered or never asked"]])
    expect(reasons(items, { touched, openQuestions: Option.some(1) })).toEqual([])
    expect(reasons(items, { touched, openQuestions: Option.none() })).toEqual([])
  })

  test("an item untouched past the threshold is stale; one with no touch time is; a dated one waits for its date; a busy subagent's never", () => {
    const items = [
      item("old", "next"),
      item("recent", "next"),
      item("legacy", "waiting", { owner: "other", who: "Andrew" }),
      item("later", "scheduled", { at: iso(NOW + HOUR) }),
      item("missed", "scheduled", { at: iso(NOW - UNTOUCHED_MS) }),
      item("working", "running", { session: "ses_c" }),
    ]
    const touched = { old: NOW - UNTOUCHED_MS, recent: NOW - UNTOUCHED_MS + 1, later: NOW - 10 * UNTOUCHED_MS, missed: NOW - 10 * UNTOUCHED_MS, working: 0 }
    expect(reasons(items, { touched, linked: new Map<string, Linked>([["ses_c", { state: "busy" }]]) })).toEqual([
      ["old", "untouched for 6 h"],
      ["legacy", "no check time on record"],
      ["missed", "untouched for 6 h past its time 2026-11-18 06:00 UTC"],
    ])
  })
})

describe("the note's cadence", () => {
  test("nothing to ask is never due", () => {
    expect(due(keyOf([], 3), Option.none(), NOW)).toBe(false)
  })

  test("a first ask is due; none within the gap; a new ask after the gap; the same ask only after the repeat", () => {
    const stale = staleOf([item("old", "next")], facts())
    const key = keyOf(stale, 1)
    expect(due(key, Option.none(), NOW)).toBe(true)
    expect(due("other", Option.some({ at: NOW - GAP_MS + 1, key }), NOW)).toBe(false)
    expect(due("other", Option.some({ at: NOW - GAP_MS, key }), NOW)).toBe(true)
    expect(due(key, Option.some({ at: NOW - GAP_MS, key }), NOW)).toBe(false)
    expect(due(key, Option.some({ at: NOW - REPEAT_MS, key }), NOW)).toBe(true)
  })

  test("passing the cap is an ask of its own", () => {
    expect(keyOf([], CAP)).toBe("")
    expect(keyOf([], CAP + 1)).toBe("+cap")
  })
})

describe("noteOf", () => {
  test("lists each stale item with why, and asks to check, settle or restate them", () => {
    const note = noteOf(staleOf([item("old", "next"), item("login", "needs-you")], facts({ touched: { old: NOW - 7 * HOUR }, openQuestions: Option.some(0) })), 2)
    expect(note).toBe(
      [
        "Queue check: your queue may be out of date. Nothing was changed for you.",
        "These 2 items look stale:",
        "- old [next]: the old (untouched for 7 h)",
        "- login [needs-you]: the login (no ask_user_async question of yours is open: it was answered or never asked)",
        "Check each against reality, then set it done, remove it, or restate it with an upsert if it still holds (that marks it checked). For a needs-you item, re-ask with ask_user_async or withdraw the question and update the item.",
      ].join("\n"),
    )
  })

  test("past the cap it asks to collapse the queue, and it counts the items past the listed ones", () => {
    const many = Array.from({ length: 40 }, (_, index) => item(`i${index}`, "next"))
    const note = noteOf(staleOf(many, facts()), 40)
    expect(note).toContain("- and 25 more")
    expect(note).toContain(`Your queue holds 40 open items, more than ${CAP}: collapse them`)
  })
})

describe("work not on the default branch", () => {
  const WHY = "not on main: 2 commits not there, committed 9 h ago; land it, or mark it superseded or dropped"

  test("the commits an open item names: 7 to 40 hex with a digit and a letter, from its text and detail, once each; a done item's, a word or a number are not", () => {
    const items = [
      item("land", "next", { text: "land c0ffee1 then abc1234def", detail: "from c0ffee1; see PR 1234567" }),
      item("word", "waiting", { text: "deadbeef cafebabe" }),
      item("old", "done", { text: "beef123 landed" }),
      item("full", "running", { detail: "head 0123456789abcdef0123456789abcdef01234567" }),
    ]
    expect(hashesOf(items)).toEqual(["c0ffee1", "abc1234def", "0123456789abcdef0123456789abcdef01234567"])
  })

  test("an item naming a commit that is not on main past the threshold is stale, with why and what to do; once restated after a note it is not again", () => {
    const items = [item("land", "next", { text: "land c0ffee1" }), item("other", "next", { text: "unrelated" })]
    const touched = { land: NOW - HOUR, other: NOW - HOUR }
    expect(reasons(items, { touched, unlanded: new Map([["c0ffee1", WHY]]) })).toEqual([["land", `it names commit c0ffee1, ${WHY}`]])
    expect(reasons(items, { touched, unlanded: new Map([["c0ffee1", WHY]]), acknowledged: new Set(["land"]) })).toEqual([])
  })

  test("an item is acknowledged when the last note named it and it was restated after that note", () => {
    const sent = Option.some({ at: NOW - 2 * HOUR, key: "land other /code/.work/app/orphan" })
    expect([...acknowledgedOf(sent, { land: NOW - HOUR, other: NOW - 3 * HOUR, fresh: NOW })]).toEqual(["land"])
    expect([...acknowledgedOf(Option.none(), { land: NOW })]).toEqual([])
  })

  test("the lanes and units status lists are part of the ask and of the note, after the stale items", () => {
    const lost = { lines: ["orchestrate: committed work not on main, nobody on it (1, oldest first):", "- /code/.work/app/orphan · 2 d · 2 commits · orphan work · no session known", "Land each …"], keys: ["/code/.work/app/orphan"] }
    expect(keyOf([], 1, lost.keys)).toBe("/code/.work/app/orphan")
    const stale = staleOf([item("old", "next")], facts({ touched: { old: NOW - 7 * HOUR } }))
    expect(keyOf(stale, 1, lost.keys)).toBe("old /code/.work/app/orphan")
    const note = noteOf(stale, 1, lost.lines).split("\n")
    expect(note.slice(1, 3)).toEqual(["This item looks stale:", "- old [next]: the old (untouched for 7 h)"])
    expect(note.slice(3, 6)).toEqual(lost.lines)
    expect(noteOf([], 1, lost.lines).split("\n").slice(0, 2)).toEqual(["Queue check: your queue may be out of date. Nothing was changed for you.", lost.lines[0]])
  })
})
