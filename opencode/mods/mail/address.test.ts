import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { byTitle, isSessionID, notSelf } from "./address.ts"
import type { SessionCard } from "./directory.ts"

const card = (id: string, title?: string): SessionCard => ({ id, title, directory: "/work", running: false, updated: 0 })

const CARDS = [card("ses_a", "Money parsing"), card("ses_b", "Money parsing review"), card("ses_c", "Docs"), card("ses_d"), card("ses_e", "  ")]

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSync(Effect.result(effect))

describe("an address", () => {
  test("is a session id when it looks like one, else a title", () => {
    expect(isSessionID("ses_2f9aB")).toBe(true)
    expect(isSessionID("  ses_2f9aB ")).toBe(true)
    expect(isSessionID("ses_")).toBe(false)
    expect(isSessionID("Money parsing")).toBe(false)
    expect(isSessionID("ses_a b")).toBe(false)
  })

  test("an exact title wins over titles that contain it, in any case", () => {
    expect(run(byTitle("money PARSING", CARDS))).toMatchObject({ _tag: "Success", success: { id: "ses_a" } })
  })

  test("text only one title contains names that session", () => {
    expect(run(byTitle("review", CARDS))).toMatchObject({ _tag: "Success", success: { id: "ses_b" } })
    expect(run(byTitle(" docs ", CARDS))).toMatchObject({ _tag: "Success", success: { id: "ses_c" } })
  })

  test("text several titles contain is ambiguous, and the refusal names them", () => {
    const result = run(byTitle("money", CARDS))
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "AmbiguousTitle",
        to: "money",
        matches: [
          { id: "ses_a", title: "Money parsing" },
          { id: "ses_b", title: "Money parsing review" },
        ],
      },
    })
  })

  test("no title matching, or an empty address, is no such session; an untitled session matches no title", () => {
    expect(run(byTitle("billing", CARDS))).toMatchObject({ _tag: "Failure", failure: { _tag: "NoSuchSession", to: "billing" } })
    expect(run(byTitle("  ", CARDS))).toMatchObject({ _tag: "Failure", failure: { _tag: "NoSuchSession" } })
    expect(run(byTitle("ses_d", CARDS))).toMatchObject({ _tag: "Failure", failure: { _tag: "NoSuchSession" } })
  })

  test("the sender's own session is refused", () => {
    expect(run(notSelf(card("ses_a"), "ses_a"))).toMatchObject({ _tag: "Failure", failure: { _tag: "SelfAddressed", sessionID: "ses_a" } })
    expect(run(notSelf(card("ses_b"), "ses_a"))).toMatchObject({ _tag: "Success", success: { id: "ses_b" } })
  })
})
