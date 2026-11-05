// How one changed file is reviewed: hunk at the checkout's top against the
// base when it is on PATH, else git's pager with a note saying so, an
// untracked file diffed against nothing, and no review for a file no longer
// changed.
import { describe, expect, test } from "bun:test"
import type { Checkout } from "./checkout.ts"
import { HUNK_MISSING, reviewOf } from "./review.ts"

const checkout: Checkout = {
  root: "/work/app",
  base: "HEAD",
  head: { branch: "feature", oid: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d", ahead: 0, behind: 0 },
  files: [
    { path: "src/a.ts", status: "M", added: 1, deleted: 1 },
    { path: "new.md", from: "old.md", status: "R", added: 0, deleted: 0 },
    { path: "notes.txt", status: "?", added: 2, deleted: 0 },
  ],
}

describe("reviewOf", () => {
  test("with hunk: hunk diff --watch against the base, a rename naming both paths", () => {
    expect(reviewOf(checkout, "src/a.ts", true)).toEqual({
      command: { program: "hunk", argv: ["hunk", "diff", "--watch", "HEAD", "--", "src/a.ts"], cwd: "/work/app" },
    })
    expect(reviewOf(checkout, "new.md", true).command?.argv).toEqual(["hunk", "diff", "--watch", "HEAD", "--", "old.md", "new.md"])
  })

  test("without hunk: git pages its diff, an untracked file against nothing, and the note says why", () => {
    expect(reviewOf(checkout, "src/a.ts", false)).toEqual({
      command: { program: "pager", argv: ["git", "--paginate", "diff", "HEAD", "--", "src/a.ts"], cwd: "/work/app" },
      note: HUNK_MISSING,
    })
    expect(reviewOf(checkout, "notes.txt", false).command?.argv).toEqual(["git", "--paginate", "diff", "--no-index", "--", "/dev/null", "notes.txt"])
  })

  test("a file that is no longer changed has no review", () => {
    expect(reviewOf(checkout, "gone.ts", true)).toEqual({ note: "gone.ts has no changes now" })
  })
})
