// The dotfiles' post-land step (scripts/post-land.ts) over stand-in steps: no fork, no network,
// no push. And the lock it shares with daily's step 0 (scripts/upstream.ts `withUpstreamLock`), raced by
// real processes (scripts/upstream-lock-child.ts).
import { afterAll, describe, expect, test } from "bun:test"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ForkWork } from "./fork-work.ts"
import { Effect, Option } from "effect"
import { it } from "effect-bun-test"
import type { DeepReport } from "./accept-ledger.ts"
import { type Load, loadOf, postLand, type Steps } from "./post-land.ts"
import { FORK_OWNER, type Outcome, withUpstreamLock } from "./upstream.ts"

const NONE: ForkWork = { candidates: [], closed: [], unread: 0, droppable: [] }
const REPORT = "/state/upstream-conflict.md"

const CHECKOUT = "c0ffee000000aaaa"
const MOVED = "a1ter0000000bbbb"

/** A deep run's report at the checkout: two passed (one on its second run), one owed, and `red` failed files. */
const deepReport = (red: number): DeepReport => ({
  head: CHECKOUT,
  host: `${FORK_OWNER}.local`,
  load: { start: 42.2, end: 40 },
  files: [
    { file: "tests/a.test.ts", status: "passed", why: "", seconds: 3, log: "/logs/a.log", second: false },
    { file: "tests/b.test.ts", status: "passed", why: "passed on its second run at load 37.5", seconds: 4, log: "/logs/b.log", second: true },
    { file: "tests/t.test.ts", status: "owed", why: "waits for a settled host", seconds: 0, log: "", second: false },
    ...Array.from({ length: red }, (_, index) => ({ file: `tests/r${index}.test.ts`, status: "failed" as const, why: "bun test exited 1", seconds: 2, log: `/logs/r${index}.log`, second: false })),
  ],
})

/** Steps answering `outcome`, recording each call; the deep run answers `deep` (default green), and a merge moves the fork when `moved`. */
const stand = (
  outcome: Outcome | undefined,
  options: { readonly host?: string; readonly work?: ForkWork; readonly deep?: Option.Option<DeepReport>; readonly moved?: boolean } = {},
) => {
  const calls: Array<string> = []
  const { deep = Option.some(deepReport(0)) } = options
  let merged = false
  const fork = () => (merged && options.moved && MOVED) || "before0000"
  const steps: Steps = {
    host: options.host ?? `${FORK_OWNER}.local`,
    head: () => {
      calls.push("head")
      return fork()
    },
    sync: () => void calls.push("sync"),
    merge: async () => {
      calls.push("merge")
      merged = true
      return outcome
    },
    deep: async (ask) => {
      calls.push(`deep ${(ask.settled && "settled") || "loaded"} ${Option.getOrElse(ask.width, () => "pool")}`)
      return { report: deep, log: "/logs/head" }
    },
    checkout: () => CHECKOUT,
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

/** The deep block of the default green report, word for word. */
const GREEN = [
  `accept deep: green at c0ffee000000 on ${FORK_OWNER}.local: 2 passed, 0 failed, 1 still owed, load 42.2.`,
  "  passed on its second run at load 37.5: tests/b.test.ts",
  "  still owed: tests/t.test.ts (waits for a settled host)",
]

/** The red block of a report with two failed files, word for word. */
const RED = [
  `accept deep: RED at c0ffee000000 (2 failed) on ${FORK_OWNER}.local, load 42.2. Hosts may already have installed this head: the install target does not wait for the deep run. Start a fix unit before other work.`,
  "  failed: tests/r0.test.ts (/logs/r0.log)",
  "  failed: tests/r1.test.ts (/logs/r1.log)",
  "  passed on its second run at load 37.5: tests/b.test.ts",
  "  still owed: tests/t.test.ts (waits for a settled host)",
]

/** The report's lines after the green deep block, which it must open with. */
const afterGreen = (text: string) => {
  const lines = text.split("\n")
  expect(lines.slice(0, GREEN.length)).toEqual(GREEN)
  return lines.slice(GREEN.length)
}

const UP_TO_DATE = ["upstream: up to date; prime-look has every commit of upstream/dev.", "upstream.json: 0 commits past the fork's checkout.", "fork work: none."]
const MERGED: Outcome = { kind: "merged", from: "aaaaaaaaaaaa", merge: "bbbbbbbbbbbb", commits: 12, pushed: true }
const MERGED_LINE = "upstream: merged 12 commits into prime-look (aaaaaaaaaa -> bbbbbbbbbb) and pushed prime-look; the next install builds it."
const HELD = "upstream: held; the deep run is red at c0ffee000000, and a merge would make every file due again. The next land tries again."

interface Case {
  readonly load: Load
  readonly owner: "fork owner" | "workbox"
  readonly colour: "green" | "red"
  readonly merge: "moves the fork" | "leaves the fork"
}

/** What a case must call, in order, and the report it must answer. */
const expectedOf = (each: Case) => {
  const moved = each.merge === "moves the fork"
  const deepCall = { loaded: "deep loaded 2", settled: "deep settled pool", forced: "deep settled 2" }[each.load]
  const merges = each.load !== "loaded" && each.owner === "fork owner" && each.colour === "green"
  const upstreamCalls = ["sync", "head", "merge", "refresh", `work before0000 ${moved}`, "head"]
  const afterMerge = (moved && [MERGED_LINE, "upstream.json: 0 commits past the fork's checkout.", "fork work: none.", `accept deep after the merge, on the fork's new head ${MOVED.slice(0, 12)}:`, ...GREEN]) || UP_TO_DATE
  const tail = (each.load === "loaded" && ["upstream: waits for a settled host"]) ||
    (each.owner === "workbox" && ["post-land: nothing to do on bite-cristian; the fork's owner merges upstream."]) ||
    (each.colour === "red" && [HELD]) ||
    afterMerge
  return {
    calls: [deepCall, ...((merges && upstreamCalls) || []), ...((merges && moved && [deepCall, "head"]) || [])],
    lines: [...{ green: GREEN, red: RED }[each.colour], ...tail],
  }
}

describe("the post-land step", () => {
  /** The step's report at `load` (default settled), answered into an Effect. */
  const report = (steps: Steps, load?: Load) => Effect.promise(() => postLand(steps, load))

  it.effect("on a host that does not own the fork (the workbox) it runs the deep run, merges nothing and says so", () =>
    Effect.gen(function* () {
      const { steps, calls } = stand({ kind: "up-to-date" }, { host: "bite-cristian" })
      expect(afterGreen(yield* report(steps))).toEqual(["post-land: nothing to do on bite-cristian; the fork's owner merges upstream."])
      expect(calls).toEqual(["deep settled pool"])
    }),
  )

  it.effect("up to date: the deep run, then syncs, merges once, refreshes upstream.json, checks only the drop markers", () =>
    Effect.gen(function* () {
      const { steps, calls } = stand({ kind: "up-to-date" })
      expect(afterGreen(yield* report(steps))).toEqual(UP_TO_DATE)
      expect(calls).toEqual(["deep settled pool", "sync", "head", "merge", "refresh", "work before0000 false", "head"])
    }),
  )

  // Each load word, fork owner or not, green or red, a merge that moves the fork or not: which of deep, merge
  // and the second deep run ran, in order, and the report's first lines word for word.
  const cases = (["loaded", "settled", "forced"] as const).flatMap((load) =>
    (["fork owner", "workbox"] as const).flatMap((owner) =>
      (["green", "red"] as const).flatMap((colour) => (["moves the fork", "leaves the fork"] as const).map((merge) => ({ load, owner, colour, merge }))),
    ),
  )
  for (const each of cases)
    it.effect(`${each.load}, ${each.owner}, ${each.colour}, a merge that ${each.merge}`, () =>
      Effect.gen(function* () {
        const moved = each.merge === "moves the fork"
        const host = { "fork owner": `${FORK_OWNER}.local`, workbox: "bite-cristian" }[each.owner]
        const outcome: Outcome = (moved && MERGED) || { kind: "up-to-date" }
        const { steps, calls } = stand(outcome, { host, moved, deep: Option.some(deepReport({ green: 0, red: 2 }[each.colour])) })
        const text = yield* report(steps, each.load)
        expect({ calls, lines: text.split("\n") }).toEqual(expectedOf(each))
      }),
    )

  it.effect("a loaded run that ran no file answers an empty report; one that ran a file does not", () =>
    Effect.gen(function* () {
      const none: DeepReport = { ...deepReport(0), files: deepReport(0).files.filter((file) => file.status === "owed") }
      expect(yield* report(stand({ kind: "up-to-date" }, { deep: Option.some(none) }).steps, "loaded")).toBe("")
      expect(yield* report(stand({ kind: "up-to-date" }).steps, "loaded")).toBe([...GREEN, "upstream: waits for a settled host"].join("\n"))
    }),
  )

  it.effect("a deep run that wrote no outcome is red, names the checkout and its log, and holds the merge", () =>
    Effect.gen(function* () {
      const { steps, calls } = stand({ kind: "up-to-date" }, { deep: Option.none() })
      expect((yield* report(steps)).split("\n")).toEqual([
        "accept deep: RED at c0ffee000000 (the deep run wrote no outcome) on " +
          `${FORK_OWNER}.local. Hosts may already have installed this head: the install target does not wait for the deep run. Start a fix unit before other work.`,
        "  log: /logs/head",
        HELD,
      ])
      expect(calls).toEqual(["deep settled pool"])
    }),
  )

  test("the load word: absent or unknown reads as settled", () => {
    const env: Record<string, string> = {}
    expect([env.RIFT_POST_LAND_LOAD, "", "settled", "loaded", "forced", "busy"].map(loadOf)).toEqual(["settled", "settled", "settled", "loaded", "forced", "settled"])
  })

  test("merged: N commits and the push, then the fork work as a to-do", async () => {
    const work: ForkWork = {
      ...NONE,
      droppable: [{ commit: "80da76e442", pr: 63209, what: "a subagent waiting on its own background work", by: "abcdef1234567", merged: true }],
    }
    const { steps, calls } = stand({ kind: "merged", from: "aaaaaaaaaaaa", merge: "bbbbbbbbbbbb", commits: 12, pushed: true }, { work })
    const text = await postLand(steps)
    expect(afterGreen(text).slice(0, 3)).toEqual([
      "upstream: merged 12 commits into prime-look (aaaaaaaaaa -> bbbbbbbbbb) and pushed prime-look; the next install builds it.",
      "upstream.json: 0 commits past the fork's checkout.",
      "fork work (report only; nothing dropped or asked yet):",
    ])
    expect(text).toContain("- drop fork commit 80da76e442 (a subagent waiting on its own background work): upstream PR #63209 is merged into the fork (abcdef1234)")
    expect(calls.at(-2)).toBe("work before0000 true")
  })

  test("a merged but unpushed fork says to push it", async () => {
    const { steps } = stand({ kind: "merged", from: "aaaaaaaaaaaa", merge: "bbbbbbbbbbbb", commits: 2, pushed: false })
    expect(afterGreen(await postLand(steps))[0]).toBe("upstream: merged 2 commits into prime-look (aaaaaaaaaa -> bbbbbbbbbb), but the push to origin failed; push prime-look from the fork.")
  })

  test("a conflict names its files and report, and hands the orchestrator a fork Rift unit", async () => {
    const { steps, calls } = stand({ kind: "conflict", files: ["packages/tui/a.tsx", "bun.lock"], upstream: "u" })
    const lines = afterGreen(await postLand(steps))
    expect(lines[0]).toBe(`upstream: the merge conflicts in 2 files (packages/tui/a.tsx, bun.lock); prime-look unchanged. Report: ${REPORT}`)
    expect(lines[3]).toStartWith("- resolve the conflicts as a fork unit: a Rift of the fork on a branch off prime-look, `git merge upstream/dev`, resolve packages/tui/a.tsx, bun.lock")
    expect(lines[3]).toContain("the merge joins the next batch and its verifier")
    expect(calls.at(-2)).toBe("work before0000 true")
  })

  test("a red check names the check and the log, and the held merge to start from", async () => {
    const { steps } = stand({ kind: "red", check: "typecheck packages/tui", merge: "cccccccccccc", upstream: "u" })
    const lines = afterGreen(await postLand(steps))
    expect(lines[0]).toBe(`upstream: the merge is red: typecheck packages/tui; prime-look unchanged, the merge kept on daily/upstream-merge (cccccccccc). Log: ${REPORT}`)
    expect(lines[3]).toStartWith("- make the merge land as a fork unit: start a fork Rift from daily/upstream-merge (cccccccccc)")
  })

  test("a failed fetch says the next land tries again; daily holding the merge skips it, refreshing nothing", async () => {
    expect(afterGreen(await postLand(stand({ kind: "fetch-failed", error: "no network" }).steps))[0]).toBe(
      "upstream: fetching upstream/dev failed (no network); the next land tries again.",
    )
    const held = stand(undefined)
    expect(afterGreen(await postLand(held.steps))).toEqual(["upstream: skipped; bun run daily is merging upstream now, and the next land runs this again."])
    expect(held.calls).toEqual(["deep settled pool", "sync", "head", "merge"])
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
