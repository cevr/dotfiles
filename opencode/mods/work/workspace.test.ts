import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { explainRefusal, holds, removal, type RemoveRefused, type Workspace } from "./workspace.ts"

const RIFT: Workspace = {
  path: "/code/.rifts/app/feat-x",
  source: false,
  children: [],
  git: true,
  branch: "feat/x",
  head: "abc1234",
  uncommitted: [],
  unpushed: [],
  stashes: 0,
}

/** The refusal of removing `workspace`, or undefined when it may go. */
const refusal = (workspace: Workspace, force = false, sessionDirectory = "/code/app"): RemoveRefused | undefined => {
  const exit = Effect.runSyncExit(removal(workspace, { force, sessionDirectory }))
  if (Exit.isSuccess(exit)) return undefined
  const reason = exit.cause.reasons.find((item) => item._tag === "Fail")
  return reason?._tag === "Fail" ? reason.error : undefined
}

describe("removing a Rift", () => {
  test("a clean Rift away from the session may go", () => expect(refusal(RIFT)).toBeUndefined())

  test("work found nowhere else is refused and named, unless forced", () => {
    const busy = { ...RIFT, uncommitted: [" M src/a.ts", "?? notes.md"], unpushed: ["d85f04d only here"], stashes: 1 }
    const refused = refusal(busy)
    expect(refused?._tag).toBe("WorkUnsaved")
    expect(explainRefusal(refused!)).toBe(
      [
        "/code/.rifts/app/feat-x holds work found nowhere else:",
        "2 uncommitted change(s):",
        "   M src/a.ts",
        "  ?? notes.md",
        "1 commit(s) on no remote and in no branch of its source:",
        "  d85f04d only here",
        "1 stash entry",
        "Commit and push it, or pass force: true to remove it anyway (it goes to Rift's trash until the next gc).",
      ].join("\n"),
    )
    expect(refusal(busy, true)).toBeUndefined()
  })

  test("a Rift outside Git cannot be checked, so it goes only when forced", () => {
    const plain = { ...RIFT, git: false, branch: undefined }
    expect(explainRefusal(refusal(plain)!)).toContain("is not a Git checkout")
    expect(refusal(plain, true)).toBeUndefined()
  })

  test("a warm source, a Rift holding the session and a Rift with Rifts of its own are refused even when forced", () => {
    expect(refusal({ ...RIFT, source: true }, true)?._tag).toBe("SourceKept")
    expect(refusal(RIFT, true, "/code/.rifts/app/feat-x/src")?._tag).toBe("SessionInside")
    expect(refusal(RIFT, true, "/code/.rifts/app/feat-x")?._tag).toBe("SessionInside")
    expect(refusal(RIFT, true, "/code/.rifts/app/feat-xy")).toBeUndefined()
    const parent = { ...RIFT, children: ["/code/.rifts/feat-x/inner"] }
    expect(explainRefusal(refusal(parent, true)!)).toBe(
      "/code/.rifts/app/feat-x has Rifts of its own, which would go with it. Remove them first:\n  /code/.rifts/feat-x/inner",
    )
  })

  test("a path holds itself and what is under it, not a sibling that shares its prefix", () => {
    expect(holds("/a/b", "/a/b")).toBe(true)
    expect(holds("/a/b/", "/a/b/c")).toBe(true)
    expect(holds("/a/b", "/a/bc")).toBe(false)
  })
})
