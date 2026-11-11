// The dotfiles' post-land step (scripts/post-land.ts) over stand-in steps: no fork, no network,
// no push. And the lock it shares with daily's step 0 (scripts/upstream.ts `withUpstreamLock`).
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ForkWork } from "./fork-work.ts"
import { postLand, type Steps } from "./post-land.ts"
import { FORK_OWNER, type Outcome, withUpstreamLock } from "./upstream.ts"

const NONE: ForkWork = { candidates: [], closed: [], unread: 0, droppable: [] }
const REPORT = "/state/upstream-conflict.md"

/** Steps answering `outcome`, recording each call. */
const stand = (outcome: Outcome | undefined, options: { readonly host?: string; readonly work?: ForkWork } = {}) => {
  const calls: Array<string> = []
  const steps: Steps = {
    host: options.host ?? `${FORK_OWNER}.local`,
    head: () => {
      calls.push("head")
      return "before0000"
    },
    sync: () => void calls.push("sync"),
    merge: async () => {
      calls.push("merge")
      return outcome
    },
    refresh: () => {
      calls.push("refresh")
      return "upstream.json: 0 commits past the fork's checkout."
    },
    work: async (before, full) => {
      calls.push(`work ${before} ${full}`)
      return options.work ?? NONE
    },
    report: REPORT,
  }
  return { steps, calls }
}

describe("the post-land step", () => {
  test("on a host that does not own the fork (the workbox) it does nothing and says so", async () => {
    const { steps, calls } = stand({ kind: "up-to-date" }, { host: "bite-cristian" })
    expect(await postLand(steps)).toBe("post-land: nothing to do on bite-cristian; the fork's owner merges upstream.")
    expect(calls).toEqual([])
  })

  test("up to date: syncs, merges once, refreshes upstream.json, checks only the drop markers", async () => {
    const { steps, calls } = stand({ kind: "up-to-date" })
    expect(await postLand(steps)).toBe(
      ["upstream: up to date; prime-look has every commit of upstream/dev.", "upstream.json: 0 commits past the fork's checkout.", "fork work: none."].join("\n"),
    )
    expect(calls).toEqual(["sync", "head", "merge", "refresh", "work before0000 false"])
  })

  test("merged: N commits and the push, then the fork work as a to-do", async () => {
    const work: ForkWork = {
      ...NONE,
      droppable: [{ commit: "80da76e442", pr: 63209, what: "a subagent waiting on its own background work", by: "abcdef1234567", merged: true }],
    }
    const { steps, calls } = stand({ kind: "merged", from: "aaaaaaaaaaaa", merge: "bbbbbbbbbbbb", commits: 12, pushed: true }, { work })
    const text = await postLand(steps)
    expect(text.split("\n").slice(0, 3)).toEqual([
      "upstream: merged 12 commits into prime-look (aaaaaaaaaa -> bbbbbbbbbb) and pushed prime-look; the next install builds it.",
      "upstream.json: 0 commits past the fork's checkout.",
      "fork work (report only; nothing dropped or asked yet):",
    ])
    expect(text).toContain("- drop fork commit 80da76e442 (a subagent waiting on its own background work): upstream PR #63209 is merged into the fork (abcdef1234)")
    expect(calls.at(-1)).toBe("work before0000 true")
  })

  test("a merged but unpushed fork says to push it", async () => {
    const { steps } = stand({ kind: "merged", from: "aaaaaaaaaaaa", merge: "bbbbbbbbbbbb", commits: 2, pushed: false })
    expect((await postLand(steps)).split("\n")[0]).toBe("upstream: merged 2 commits into prime-look (aaaaaaaaaa -> bbbbbbbbbb), but the push to origin failed; push prime-look from the fork.")
  })

  test("a conflict names its files and report, and hands the orchestrator a fork Rift unit", async () => {
    const { steps, calls } = stand({ kind: "conflict", files: ["packages/tui/a.tsx", "bun.lock"], upstream: "u" })
    const lines = (await postLand(steps)).split("\n")
    expect(lines[0]).toBe(`upstream: the merge conflicts in 2 files (packages/tui/a.tsx, bun.lock); prime-look unchanged. Report: ${REPORT}`)
    expect(lines[3]).toStartWith("- resolve the conflicts as a fork unit: a Rift of the fork on a branch off prime-look, `git merge upstream/dev`, resolve packages/tui/a.tsx, bun.lock")
    expect(lines[3]).toContain("the merge joins the next batch and its verifier")
    expect(calls.at(-1)).toBe("work before0000 true")
  })

  test("a red check names the check and the log, and the held merge to start from", async () => {
    const { steps } = stand({ kind: "red", check: "typecheck packages/tui", merge: "cccccccccccc", upstream: "u" })
    const lines = (await postLand(steps)).split("\n")
    expect(lines[0]).toBe(`upstream: the merge is red: typecheck packages/tui; prime-look unchanged, the merge kept on daily/upstream-merge (cccccccccc). Log: ${REPORT}`)
    expect(lines[3]).toStartWith("- make the merge land as a fork unit: start a fork Rift from daily/upstream-merge (cccccccccc)")
  })

  test("a failed fetch says the next land tries again; daily holding the merge skips it, refreshing nothing", async () => {
    expect((await postLand(stand({ kind: "fetch-failed", error: "no network" }).steps)).split("\n")[0]).toBe(
      "upstream: fetching upstream/dev failed (no network); the next land tries again.",
    )
    const held = stand(undefined)
    expect(await postLand(held.steps)).toBe("upstream: skipped; bun run daily is merging upstream now, and the next land runs this again.")
    expect(held.calls).toEqual(["sync", "head", "merge"])
  })
})

describe("the upstream lock", () => {
  const scratch = mkdtempSync(join(tmpdir(), "upstream-lock-"))
  afterAll(() => rmSync(scratch, { recursive: true, force: true }))

  test("runs the merge holding it and lets it go; a live holder skips it; a dead holder's lock is taken over", async () => {
    const lock = join(scratch, "upstream.lock")
    expect(await withUpstreamLock(scratch, async () => existsSync(lock))).toBe(true)
    expect(existsSync(lock)).toBe(false)
    writeFileSync(lock, `${process.pid}\n`)
    let ran = false
    expect(
      await withUpstreamLock(scratch, async () => {
        ran = true
      }),
    ).toBeUndefined()
    expect(ran).toBe(false)
    // A pid no process holds (past the kernel's pid range).
    writeFileSync(lock, "99999999\n")
    expect(await withUpstreamLock(scratch, async () => "merged")).toBe("merged")
    expect(existsSync(lock)).toBe(false)
  })
})
