import { describe, expect, test } from "bun:test"
import { ago, line, listing, select, type SessionCard } from "./directory.ts"

const NOW = 10 * 86_400_000

const OLD: SessionCard = { id: "ses_old", title: "Dotfiles", directory: "/Users/me/dotfiles", agent: "build", running: false, updated: NOW - 3 * 86_400_000 }
const NEW: SessionCard = { id: "ses_new", title: "Bite PR", directory: "/Users/me/work/bite", agent: "build", running: true, updated: NOW - 2_000 }
const KID: SessionCard = {
  id: "ses_kid",
  title: "Fix money",
  directory: "/Users/me/work/bite",
  agent: "worker",
  running: true,
  parentID: "ses_new",
  updated: NOW - 90_000,
}
const UNTITLED: SessionCard = { id: "ses_untitled", directory: "/tmp", running: false, updated: NOW - 7_200_000 }
const CARDS: ReadonlyArray<SessionCard> = [OLD, NEW, KID, UNTITLED]

describe("the sessions listing", () => {
  test("is newest activity first, at most the limit", () => {
    expect(select(CARDS, {}).map((card) => card.id)).toEqual(["ses_new", "ses_kid", "ses_untitled", "ses_old"])
    expect(select(CARDS, { limit: 2 }).map((card) => card.id)).toEqual(["ses_new", "ses_kid"])
  })

  test("search matches text in the title, the directory or the id, in any case", () => {
    expect(select(CARDS, { search: "MONEY" }).map((card) => card.id)).toEqual(["ses_kid"])
    expect(select(CARDS, { search: "work/bite" }).map((card) => card.id)).toEqual(["ses_new", "ses_kid"])
    expect(select(CARDS, { search: "untitled" }).map((card) => card.id)).toEqual(["ses_untitled"])
    expect(select(CARDS, { search: "  " })).toHaveLength(4)
  })

  test("a line gives id, title, state, agent, directory, last activity and parent, and marks the caller", () => {
    expect(line(NEW, "ses_new", NOW)).toBe('ses_new "Bite PR" · running · build · /Users/me/work/bite · just now (you)')
    expect(line(KID, "ses_new", NOW)).toBe('ses_kid "Fix money" · running · worker · /Users/me/work/bite · 1m ago · child of ses_new')
    expect(line(UNTITLED, "ses_new", NOW)).toBe('ses_untitled (untitled) · idle · /tmp · 2h ago')
    expect(line(OLD, "ses_new", NOW)).toBe('ses_old "Dotfiles" · idle · build · /Users/me/dotfiles · 3d ago')
  })

  test("the answer counts the sessions, or says none match", () => {
    expect(listing([], "ses_new", NOW)).toBe("No sessions match.")
    expect(listing(select(CARDS, { limit: 1 }), "ses_x", NOW)).toBe('Sessions (1):\nses_new "Bite PR" · running · build · /Users/me/work/bite · just now')
  })

  test("last activity reads in its largest whole unit", () => {
    expect([0, 4_999, 5_000, 59_999, 60_000, 3_599_999, 3_600_000, 86_400_000].map((elapsed) => ago(NOW - elapsed, NOW))).toEqual([
      "just now",
      "just now",
      "5s ago",
      "59s ago",
      "1m ago",
      "59m ago",
      "1h ago",
      "1d ago",
    ])
    expect(ago(NOW + 1_000, NOW)).toBe("just now")
  })
})
