// The pr tool's handlers and the watcher, over memory GitHub, store and
// courier: status answers a read now; watch records a watch whose notice comes
// on the tick that sees what it waits for; a used repository's default branch
// tells its recent users when it turns red; create asks the configured
// reviewers; a tick reads a repository only on a probed change, a poke or a
// due refresh.
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import type { BranchRead, RepoRecord } from "./branch.ts"
import { layer, Pulls, refusalText, type Settings } from "./pulls.ts"
import type { PrInput } from "./pr.ts"
import type { Check, Report } from "./report.ts"
import { Courier, GitHub, type Notice, type Opening, SessionDirectories, SessionUnreadable, WatchStore } from "./service.ts"
import type { PrRef, Watch } from "./watch.ts"

const REPO = "biteinc/maitred"
const T = 1_800_000_000_000
const check = (name: string, state: Check["state"], jobId?: number): Check => ({
  name,
  state,
  word: state === "fail" ? "FAILURE" : state === "pass" ? "SUCCESS" : "IN_PROGRESS",
  url: `https://github.com/${REPO}/actions/runs/1/job/${jobId ?? 0}`,
  ...(jobId === undefined ? {} : { jobId }),
})
const report = (checks: ReadonlyArray<Check>, fields: Partial<Report> = {}): Report => ({
  repo: REPO,
  number: 412,
  title: "Pay with points",
  url: `https://github.com/${REPO}/pull/412`,
  state: "OPEN",
  isDraft: false,
  author: "cevr",
  head: "aaaaaaaa11",
  headRef: "points",
  baseRef: "master",
  checks,
  reviews: [],
  threads: [],
  requested: [],
  mergeable: "MERGEABLE",
  mergeState: "CLEAN",
  ...fields,
})

const SETTINGS: Settings = { follow: [], reviewers: { biteinc: ["andrewgoupil", "antwandaher", "narminmolina"] }, refreshMs: 300_000 }

/** One machine's world: sessions by directory, GitHub's answers, the store and what the courier delivered. */
const world = () => {
  const state = {
    sessions: { ses_root: "/work/maitred", ses_child: "/work/maitred", ses_away: "/work/none" } as Record<string, string>,
    parents: { ses_child: "ses_root" } as Record<string, string>,
    here: { "/work/maitred": { repo: REPO, number: 412 } } as Record<string, { repo?: string; number?: number }>,
    reports: [report([check("test", "pending")])] as Array<Report>,
    branch: { name: "master", head: "bbbbbbbb22", checks: [check("build", "pass")] } as BranchRead,
    logs: { 9: "FAIL src/points.test.ts > redeems\nError: expected 3, got 4" } as Record<number, string>,
    changed: false,
    reads: 0,
    probes: [] as Array<ReadonlyArray<string>>,
    opened: [] as Array<Opening>,
    watches: [] as Array<Watch>,
    repos: [] as Array<RepoRecord>,
    delivered: [] as Array<{ sessionID: string; notice: Notice }>,
  }
  const key = (ref: PrRef) => `${ref.repo}#${ref.number}`
  const doubles = Layer.mergeAll(
    Layer.succeed(SessionDirectories, {
      directoryOf: (sessionID: string) => {
        const directory = state.sessions[sessionID]
        return directory === undefined ? Effect.fail(new SessionUnreadable({ sessionID, message: `Session not found: ${sessionID}` })) : Effect.succeed(directory)
      },
    }),
    Layer.succeed(GitHub, {
      here: (directory: string) => Effect.sync(() => state.here[directory] ?? {}),
      read: (repo: string, numbers: ReadonlyArray<number>) =>
        Effect.sync(() => {
          state.reads += 1
          const reports = state.reports.filter((each) => each.repo === repo && numbers.includes(each.number))
          return { reports, missing: numbers.filter((number) => !reports.some((each) => each.number === number)), branch: state.branch }
        }),
      changed: (paths: ReadonlyArray<string>) =>
        Effect.sync(() => {
          state.probes.push(paths)
          return state.changed
        }),
      jobLog: (_repo: string, jobId: number) => Effect.sync(() => state.logs[jobId] ?? ""),
      create: (_directory: string, opening: Opening) =>
        Effect.sync(() => {
          state.opened.push(opening)
          return `https://github.com/${REPO}/pull/413`
        }),
    }),
    Layer.succeed(WatchStore, {
      watches: Effect.sync(() => [...state.watches]),
      put: (watch: Watch) =>
        Effect.sync(() => {
          state.watches = [...state.watches.filter((each) => !(each.sessionID === watch.sessionID && key(each) === key(watch))), watch]
        }),
      remove: (sessionID: string, ref: PrRef) =>
        Effect.sync(() => {
          state.watches = state.watches.filter((each) => !(each.sessionID === sessionID && key(each) === key(ref)))
        }),
      repos: Effect.sync(() => [...state.repos]),
      putRepo: (record: RepoRecord) =>
        Effect.sync(() => {
          state.repos = [...state.repos.filter((each) => each.repo !== record.repo), record]
        }),
    }),
    Layer.succeed(Courier, {
      rootOf: (sessionID: string) => Effect.succeed(state.parents[sessionID] ?? sessionID),
      deliver: (sessionID: string, notice: Notice) => Effect.sync(() => void state.delivered.push({ sessionID, notice })),
    }),
  )
  const live = layer(SETTINGS).pipe(Layer.provide(doubles))
  const run = <A, E>(body: (pulls: Pulls["Service"]) => Effect.Effect<A, E>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(T)
        return yield* Pulls.use(body)
      }).pipe(Effect.provide(live), Effect.provide(TestClock.layer())),
    )
  return { state, run }
}

const ask = (input: PrInput, sessionID = "ses_root") => (pulls: Pulls["Service"]) => pulls.run(sessionID, input)
const at = (ms: number) => TestClock.setTime(ms)
const refused = (input: PrInput, sessionID = "ses_root") => (pulls: Pulls["Service"]) => pulls.run(sessionID, input).pipe(Effect.flip, Effect.map(refusalText))

describe("status", () => {
  test("answers the session's branch's request with each failing job's tests and log", async () => {
    const { state, run } = world()
    state.reports = [report([check("test", "fail", 9), check("lint", "pass"), check("deploy", "cancelled")])]
    const text = await run(ask({ action: "status" }))
    expect(text).toContain("✗ test")
    expect(text).toContain("failing tests: src/points.test.ts > redeems")
    expect(text).toContain("1 cancelled")
    expect(state.repos.map((each) => [each.repo, Object.keys(each.users)])).toEqual([[REPO, ["ses_root"]]])
  })

  test("names a request that does not exist, and refuses a session outside a checkout", async () => {
    const { run } = world()
    expect(await run(ask({ action: "status", prs: [999] }))).toBe(`${REPO}#999: no such pull request`)
    expect(await run(refused({ action: "status" }, "ses_away"))).toBe("the session is in no GitHub checkout: name the requests in prs")
  })
})

describe("watch", () => {
  test("a green watch tells of a failure with its log, goes on, and ends when the checks pass", async () => {
    const { state, run } = world()
    const answer = await run(ask({ action: "watch", note: "merge it" }))
    expect(answer).toContain(`Watching ${REPO}#412 Pay with points until green: checks pending.`)
    expect(answer).toContain("do not poll")

    state.reports = [report([check("test", "fail", 9)])]
    await run((pulls) => pulls.tick)
    expect(state.delivered.map((each) => [each.sessionID, each.notice.title])).toEqual([["ses_root", `PR ${REPO}#412: checks pending → fail: test`]])
    expect(state.delivered[0]?.notice.text).toContain("failing tests: src/points.test.ts > redeems")
    expect(state.delivered[0]?.notice.text).toContain("note: merge it")
    expect(state.watches).toHaveLength(1)

    state.reports = [report([check("test", "pass")])]
    state.delivered = []
    await run((pulls) => pulls.tick)
    expect(state.delivered[0]?.notice.text).toContain("The watch ended.")
    expect(state.watches).toEqual([])
  })

  test("refuses green on passing checks; list and unwatch name this session's watches", async () => {
    const { state, run } = world()
    state.reports = [report([check("test", "pass")])]
    expect(await run(ask({ action: "watch" }))).toBe(`${REPO}#412: not watched: its checks pass.`)
    expect(await run(ask({ action: "watch", until: "reviewed" }))).toContain("until reviewed")
    expect(await run(ask({ action: "list" }))).toBe(`${REPO}#412 Pay with points · until reviewed · checks pass`)
    expect(await run(ask({ action: "list" }, "ses_child"))).toBe("No watches.")
    expect(await run(ask({ action: "unwatch" }))).toBe(`Stopped watching ${REPO}#412.`)
    expect(await run(ask({ action: "unwatch" }))).toBe("No watch to stop.")
  })
})

describe("the default branch", () => {
  test("turning red tells the root of the family that used the tool, once per red spell", async () => {
    const { state, run } = world()
    await run(ask({ action: "status" }, "ses_child"))
    await run((pulls) => pulls.tick)
    expect(state.delivered).toEqual([])

    state.branch = { name: "master", head: "cccccccc33", checks: [check("build", "fail", 9)] }
    await run((pulls) => pulls.poke(REPO).pipe(Effect.andThen(pulls.tick)))
    expect(state.delivered.map((each) => [each.sessionID, each.notice.title])).toEqual([["ses_root", `${REPO} master turned red`]])
    expect(state.delivered[0]?.notice.text).toContain("failing tests: src/points.test.ts > redeems")

    state.branch = { name: "master", head: "dddddddd44", checks: [check("build", "fail", 9)] }
    await run((pulls) => pulls.poke(REPO).pipe(Effect.andThen(pulls.tick)))
    expect(state.delivered).toHaveLength(1)
  })
})

describe("the watcher's reads", () => {
  test("probes between refreshes and reads only on a change, a poke or a due refresh", () => {
    const { state, run } = world()
    return run((pulls) =>
      Effect.gen(function* () {
        yield* pulls.run("ses_root", { action: "watch" })
        state.reads = 0
        yield* pulls.tick
        expect(state.reads).toBe(1)
        yield* at(T + 60_000)
        yield* pulls.tick
        expect(state.reads).toBe(1)
        expect(state.probes.at(-1)).toContain(`repos/${REPO}/pulls/412`)
        state.changed = true
        yield* pulls.tick
        expect(state.reads).toBe(2)
        state.changed = false
        yield* pulls.poke(REPO)
        yield* pulls.tick
        expect(state.reads).toBe(3)
        yield* at(T + 60_000 + SETTINGS.refreshMs)
        yield* pulls.tick
        expect(state.reads).toBe(4)
      }),
    )
  })
})

describe("create", () => {
  test("opens the branch's request asking the owner's configured reviewers", async () => {
    const { state, run } = world()
    state.here["/work/maitred"] = { repo: REPO }
    const answer = await run(ask({ action: "create", title: "Pay with points", body: "Closes BITE-1" }))
    expect(answer).toBe(`Opened https://github.com/${REPO}/pull/413\nreview requested from: andrewgoupil, antwandaher, narminmolina`)
    expect(state.opened).toEqual([{ title: "Pay with points", body: "Closes BITE-1", draft: false, reviewers: ["andrewgoupil", "antwandaher", "narminmolina"] }])
  })

  test("refuses a branch that has a request already", async () => {
    const { run } = world()
    expect(await run(refused({ action: "create", title: "Again" }))).toBe(`the branch already has ${REPO}#412`)
  })
})
