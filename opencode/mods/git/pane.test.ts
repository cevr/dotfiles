// What the /git pane draws: its title, one row per changed file cut to fit,
// the notes about what could not be read, what it shows with no rows, and how
// the selection moves.
import { describe, expect, test } from "bun:test"
import type { Checkout } from "./checkout.ts"
import { cutStart, emptyText, fileRow, moved, notes, paneTitle } from "./pane.ts"

const checkout: Checkout = {
  root: "/work/app",
  base: "HEAD",
  head: { branch: "feature", oid: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d", upstream: "origin/main", ahead: 2, behind: 0 },
  files: [
    { path: "src/a.ts", status: "M", added: 12, deleted: 3 },
    { path: "docs/new.md", from: "docs/old.md", status: "R", added: 0, deleted: 0 },
  ],
}

describe("paneTitle", () => {
  test("branch and counts → upstream · files and totals", () => {
    expect(paneTitle(checkout)).toBe("feature ↑2 → origin/main · 2 files +12 −3")
    expect(paneTitle({ ...checkout, head: { branch: "spike", ahead: 0, behind: 0 }, files: [] })).toBe("spike · no changes")
  })
})

describe("fileRow", () => {
  test("status, path and counts; a rename names both paths; a binary file says so", () => {
    expect(fileRow({ path: "src/a.ts", status: "M", added: 12, deleted: 3 }, 60)).toBe("M  src/a.ts  +12 −3")
    expect(fileRow({ path: "docs/new.md", from: "docs/old.md", status: "R", added: 0, deleted: 0 }, 60)).toBe("R  docs/old.md → docs/new.md  +0 −0")
    expect(fileRow({ path: "logo.png", status: "?" }, 60)).toBe("?  logo.png  binary")
  })

  test("a path too long for the width is cut from its start", () => {
    const row = fileRow({ path: "packages/very/deep/folder/structure/file.ts", status: "M", added: 1, deleted: 1 }, 30)
    expect(row).toBe("M  …r/structure/file.ts  +1 −1")
    expect(row).toHaveLength(30)
    expect(cutStart("abcdef", 3)).toBe("…ef")
    expect(cutStart("abc", 3)).toBe("abc")
  })
})

describe("notes and emptyText", () => {
  test("say what could not be read, gh's note and the last review's", () => {
    expect(notes({ error: "git status timed out" }, { note: "gh is not signed in · gh auth login" }, "hunk not found · using the git pager")).toEqual([
      "git: git status timed out",
      "gh is not signed in · gh auth login",
      "hunk not found · using the git pager",
    ])
    expect(notes(undefined, undefined, undefined)).toEqual([])
  })

  test("reading, no checkout, no changes, or rows", () => {
    expect(emptyText(undefined)).toBe("Reading the checkout…")
    expect(emptyText({})).toBe("Not a git checkout")
    expect(emptyText({ error: "boom" })).toBeUndefined()
    expect(emptyText({ checkout: { ...checkout, files: [] } })).toBe("No changes against HEAD")
    expect(emptyText({ checkout: { ...checkout, base: "4b825dc", files: [] } })).toBe("No changes against the empty tree")
    expect(emptyText({ checkout })).toBeUndefined()
  })
})

describe("moved", () => {
  test("stays within the rows", () => {
    expect(moved(0, -1, 3)).toBe(0)
    expect(moved(1, 1, 3)).toBe(2)
    expect(moved(2, 1, 3)).toBe(2)
    expect(moved(5, 1, 0)).toBe(0)
  })
})
