// The dotfiles' post-land step (scripts/post-land.ts) over stand-in steps: no fork, no network,
// no push. And the lock it shares with daily's step 0 (scripts/upstream.ts `withUpstreamLock`), raced by
// real processes (scripts/upstream-lock-child.ts).
import { afterAll, describe, expect, test } from "bun:test"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
  const CHILD = join(import.meta.dir, "upstream-lock-child.ts")

  interface Event {
    readonly role: string
    readonly phase: "start" | "end" | "tried"
  }

  /** Starts `roles` as real racing processes on `state` (each in its own process group), opens the barrier, and answers their events. */
  const race = async (state: string, roles: ReadonlyArray<string>, extra: Record<string, string> = {}) => {
    const children = roles.map((role) =>
      Bun.spawn([process.execPath, CHILD], {
        detached: true,
        env: { ...process.env, LOCK_STATE: state, LOCK_ROLE: role, LOCK_RACERS: String(roles.length), ...extra },
        stdout: "pipe",
        stderr: "pipe",
      }),
    )
    try {
      writeFileSync(join(state, "go"), "")
      const codes = await Promise.all(children.map((child) => child.exited))
      const events = readFileSync(join(state, "events"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Event)
      return { codes, events }
    } finally {
      for (const child of children) if (child.exitCode === null) process.kill(-child.pid, "SIGKILL")
    }
  }

  /** The most merges running at once, from the events in the order they were written. */
  const overlap = (events: ReadonlyArray<Event>) => {
    let running = 0
    let most = 0
    for (const event of events) {
      if (event.phase === "start") running++
      if (event.phase === "end") running--
      most = Math.max(most, running)
    }
    return most
  }

  const fresh = (name: string) => {
    const state = join(scratch, name)
    mkdirSync(state, { recursive: true })
    return state
  }

  test("in one process: runs the merge holding it and answers it; the lock file stays, saying who held it", async () => {
    const state = fresh("one")
    expect(await withUpstreamLock(state, async () => readFileSync(join(state, "upstream.lock"), "utf8"))).toBe(`${process.pid}\n`)
    expect(existsSync(join(state, "upstream.lock"))).toBe(true)
    expect(await withUpstreamLock(state, async () => "again")).toBe("again")
  })

  test("two real processes racing a stale lock left by a crash (a dead pid in it): exactly one merges, the other runs nothing", async () => {
    for (let round = 0; round < 5; round++) {
      const state = fresh(`stale-${round}`)
      writeFileSync(join(state, "upstream.lock"), "99999999\n")
      const { codes, events } = await race(state, ["daily", "post-land"])
      expect(codes).toEqual([0, 0])
      expect(events.filter((event) => event.phase === "start")).toHaveLength(1)
      expect(events.filter((event) => event.phase === "tried")).toHaveLength(1)
      expect(overlap(events)).toBe(1)
    }
  }, 60_000)

  test("four racers, each round: never two merges at once, exactly one merges", async () => {
    for (let round = 0; round < 3; round++) {
      const state = fresh(`four-${round}`)
      const { codes, events } = await race(state, ["a", "b", "c", "d"])
      expect(codes).toEqual([0, 0, 0, 0])
      expect(events.filter((event) => event.phase === "start")).toHaveLength(1)
      expect(events.filter((event) => event.phase === "tried")).toHaveLength(3)
      expect(overlap(events)).toBe(1)
    }
  }, 60_000)

  test("a holder cut while it holds the lock (it exits without releasing) leaves no lock behind: the next merge runs", async () => {
    const state = fresh("crash")
    const cut = await race(state, ["cut"], { LOCK_CRASH: "1" })
    expect(cut.codes).toEqual([3])
    expect(cut.events.map((event) => event.phase)).toEqual(["start"])
    expect(await withUpstreamLock(state, async () => "merged")).toBe("merged")
  }, 60_000)

  test("while a real process holds it, this one runs nothing", async () => {
    const state = fresh("held")
    // The child holds until one other racer (this process) has said it tried.
    const child = Bun.spawn([process.execPath, CHILD], {
      detached: true,
      env: { ...process.env, LOCK_STATE: state, LOCK_ROLE: "holder", LOCK_RACERS: "2" },
      stdout: "pipe",
      stderr: "pipe",
    })
    try {
      writeFileSync(join(state, "go"), "")
      const deadline = Date.now() + 10_000
      while (!(existsSync(join(state, "events")) && readFileSync(join(state, "events"), "utf8").includes('"start"')) && Date.now() < deadline) await Bun.sleep(5)
      let ran = false
      expect(
        await withUpstreamLock(state, async () => {
          ran = true
        }),
      ).toBeUndefined()
      expect(ran).toBe(false)
      appendFileSync(join(state, "events"), `${JSON.stringify({ role: "test", phase: "tried", at: Date.now() })}\n`)
      expect(await child.exited).toBe(0)
    } finally {
      if (child.exitCode === null) process.kill(-child.pid, "SIGKILL")
    }
  }, 60_000)
})
