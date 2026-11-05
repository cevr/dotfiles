// How git's machine output reads as a checkout: the branch headers and every
// kind of changed-path record of `git status --porcelain=v2 --branch -z`, the
// line counts of `git diff --numstat -z`, and the words the sidebar and the
// pane build from them.
import { describe, expect, test } from "bun:test"
import {
  aheadBehind,
  baseOf,
  branchName,
  delta,
  EMPTY_TREE,
  lineCount,
  parseNumstat,
  parseStatus,
  plural,
  pullRequestKey,
  rootOfKey,
  totals,
  withLines,
} from "./checkout.ts"

const OID = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d"
const records = (...parts: ReadonlyArray<string>) => `${parts.join("\0")}\0`

describe("parseStatus", () => {
  test("reads the branch, its commit, its upstream and how far apart they are", () => {
    const { head } = parseStatus(records(`# branch.oid ${OID}`, "# branch.head feature", "# branch.upstream origin/main", "# branch.ab +2 -1"))
    expect(head).toEqual({ oid: OID, branch: "feature", upstream: "origin/main", ahead: 2, behind: 1 })
  })

  test("an unborn branch has no commit; a detached head has no branch; no upstream has no counts", () => {
    expect(parseStatus(records("# branch.oid (initial)", "# branch.head main")).head).toEqual({ branch: "main", ahead: 0, behind: 0 })
    expect(parseStatus(records(`# branch.oid ${OID}`, "# branch.head (detached)")).head).toEqual({ oid: OID, ahead: 0, behind: 0 })
  })

  test("reads each kind of record, a path with spaces whole and a rename's source from the next record", () => {
    const { entries } = parseStatus(
      records(
        "1 .M N... 100644 100644 100644 aaa bbb src/a file.ts",
        "1 A. N... 000000 100644 100644 000 ccc added.ts",
        "1 D. N... 100644 000000 000000 ddd 000 gone.ts",
        "1 .T N... 100644 120000 120000 eee fff link",
        "2 R. N... 100644 100644 100644 ggg ggg R100 moved here.ts",
        "old name.ts",
        "u UU N... 100644 100644 100644 100644 h1 h2 h3 conflict.ts",
        "? new file.ts",
        "! ignored.log",
      ),
    )
    expect(entries).toEqual([
      { path: "src/a file.ts", status: "M" },
      { path: "added.ts", status: "A" },
      { path: "gone.ts", status: "D" },
      { path: "link", status: "T" },
      { path: "moved here.ts", from: "old name.ts", status: "R" },
      { path: "conflict.ts", status: "U" },
      { path: "new file.ts", status: "?" },
    ])
  })

  test("empty output is a clean checkout on no branch", () => {
    expect(parseStatus("")).toEqual({ head: { ahead: 0, behind: 0 }, entries: [] })
  })
})

describe("parseNumstat", () => {
  test("counts by path, a rename under where it lands, a binary file with no counts", () => {
    const counts = parseNumstat(records("3\t1\tsrc/a.ts", "0\t0\t", "old.ts", "new.ts", "-\t-\tlogo.png", "2\t0\ta\tb.ts"))
    expect([...counts]).toEqual([
      ["src/a.ts", { added: 3, deleted: 1 }],
      ["new.ts", { added: 0, deleted: 0 }],
      ["logo.png", undefined],
      ["a\tb.ts", { added: 2, deleted: 0 }],
    ])
  })
})

describe("lines", () => {
  test("a last line without a newline counts; an empty file has none", () => {
    expect(lineCount("")).toBe(0)
    expect(lineCount("one\n")).toBe(1)
    expect(lineCount("one\ntwo")).toBe(2)
  })

  test("a file takes its counts when it has some, and adds none to the totals when it has none", () => {
    const files = [withLines({ path: "a", status: "M" }, { added: 3, deleted: 2 }), withLines({ path: "b", status: "?" }, undefined)]
    expect(files).toEqual([{ path: "a", status: "M", added: 3, deleted: 2 }, { path: "b", status: "?" }])
    expect(totals(files)).toEqual({ added: 3, deleted: 2 })
    expect(delta(totals(files))).toBe("+3 −2")
  })
})

describe("words", () => {
  test("the branch, or the detached commit; the counts that are not zero; the plural", () => {
    expect(branchName({ branch: "main", ahead: 0, behind: 0 })).toBe("main")
    expect(branchName({ oid: OID, ahead: 0, behind: 0 })).toBe("detached @1a2b3c4")
    expect(branchName({ ahead: 0, behind: 0 })).toBeUndefined()
    expect(aheadBehind({ ahead: 2, behind: 1 })).toBe("↑2 ↓1")
    expect(aheadBehind({ ahead: 0, behind: 3 })).toBe("↓3")
    expect(aheadBehind({ ahead: 0, behind: 0 })).toBe("")
    expect([plural(1, "file"), plural(3, "file")]).toEqual(["1 file", "3 files"])
  })
})

describe("base and key", () => {
  test("changes count against HEAD, or the empty tree of the repository's format before the first commit", () => {
    expect(baseOf({ oid: OID, ahead: 0, behind: 0 }, "sha1")).toBe("HEAD")
    expect(baseOf({ ahead: 0, behind: 0 }, "sha1")).toBe(EMPTY_TREE.sha1)
    expect(baseOf({ ahead: 0, behind: 0 }, "sha256")).toBe(EMPTY_TREE.sha256)
  })

  test("the pull request key moves with the branch and its counts, not with an edit, and names the root", () => {
    const checkout = { root: "/work/app", base: "HEAD", head: { oid: OID, branch: "feature", upstream: "origin/main", ahead: 1, behind: 0 }, files: [] }
    const key = pullRequestKey(checkout)
    expect(key).toBeDefined()
    expect(pullRequestKey({ ...checkout, files: [{ path: "a", status: "M" }] })).toBe(key)
    expect(pullRequestKey({ ...checkout, head: { ...checkout.head, ahead: 2 } })).not.toBe(key)
    expect(rootOfKey(key ?? "")).toBe("/work/app")
    expect(pullRequestKey({ ...checkout, head: { oid: OID, ahead: 0, behind: 0 } })).toBeUndefined()
    expect(pullRequestKey({ ...checkout, head: { branch: "main", ahead: 0, behind: 0 } })).toBeUndefined()
  })
})
