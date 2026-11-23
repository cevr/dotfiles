// What status gathers for lost.ts (lost-now.ts), on the memory layers: a unit's verifier read from its run dir (in
// verify with no verdict, a `changes` verdict, an accepted one hours ago), and each leg that keeps a lane off the
// lane-first list read from where it lives (a session in the lane's directory, a subagent whose description names the
// lane, a unit of it blocked, a queue item waiting that names it). Commit hashes and paths are made up.
import { describe, expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { effectTest } from "../../../sim-tui/effect-test.ts"
import { type Held, NO_CALLS, NOTHING_HELD } from "../ledger.ts"
import { lostAnswer, lostNow } from "../lost-now.ts"
import { type LaneStatus, OnMain } from "../lost.ts"
import * as MemoryMainLine from "./main-line.ts"
import * as MemoryRunFiles from "./run-files.ts"
import * as MemorySessions from "./sessions.ts"
import * as MemoryStepLog from "./step-log.ts"
import * as MemoryWorkGit from "./work-git.ts"
import { NO_HOLDS } from "../idle.ts"
import type { Run } from "../idle.ts"
import { RootHolds } from "../service.ts"
import type { Lane } from "../tools.ts"
import { hangGuard } from "../../../tests/hang-guard.ts"

const NOW = Date.UTC(2026, 10, 21, 12)
const HOUR = 3_600_000
const ROOT = "ses_root"
const CHECKOUT = "/code/app"
const RUN = "/code/app/.orchestrate/run-1"
const ORPHAN = "/code/.work/app/orphan"
const ORPHAN_HEAD = "0fa0fa0fa0"

interface Setup {
  readonly runs?: ReadonlyArray<Run>
  readonly files?: MemoryRunFiles.Files
  readonly sessions?: Readonly<Record<string, MemorySessions.Session>>
  readonly children?: ReadonlyArray<{ readonly child: string; readonly description: string }>
  readonly held?: Held
  readonly lanes?: ReadonlyArray<Lane>
  /** The units the root started steps of: an orchestrator's (the queue check names lanes to it alone). */
  readonly steps?: ReadonlyArray<string>
  /** What `work --json list -status` says of each lane, when the installed `work` says it. */
  readonly statuses?: ReadonlyMap<string, LaneStatus>
}

/** The services for `setup`: a default branch at `main`, the orphan lane two days still with two commits not on it. */
const layerFor = (setup: Setup) => {
  const git = MemoryWorkGit.world()
  git.heads.set(ORPHAN_HEAD, { onMain: OnMain.cases.Absent.make({ missing: [ORPHAN_HEAD, "0fb"], own: [ORPHAN_HEAD, "0fb"], subject: "orphan work" }), at: Option.some(NOW - 48 * HOUR) })
  git.heads.set("a1a1a1a1a1", { onMain: OnMain.cases.Absent.make({ missing: ["a1a1a1a1a1"], own: ["a1a1a1a1a1"], subject: "alpha" }), at: Option.some(NOW - 48 * HOUR) })
  for (const [path, status] of setup.statuses ?? new Map<string, LaneStatus>()) git.statuses.set(path, status)
  const calls = new Map([
    [
      ROOT,
      {
        ...NO_CALLS,
        children: (setup.children ?? []).map((each) => ({ child: each.child, agent: "implementor", description: Option.some(each.description), startedAt: NOW - HOUR, calledAt: NOW - HOUR })),
      },
    ],
  ])
  return Layer.mergeAll(
    MemoryMainLine.layer((checkout) => Option.liftPredicate({ branch: "main", line: [{ sha: "e0e0e0e0e0", subject: "root", merged: [] }] }, () => checkout === CHECKOUT)),
    MemoryRunFiles.layer(setup.files ?? new Map()),
    MemorySessions.layer(setup.sessions ?? {}),
    MemoryStepLog.layer({ [ROOT]: setup.steps ?? [] }, calls),
    MemoryWorkGit.layer(git),
    Layer.succeed(RootHolds, RootHolds.of({ of: () => Effect.succeed(NO_HOLDS), held: () => Effect.succeed(setup.held ?? NOTHING_HELD) })),
  )
}

const listedFor = (setup: Setup) => ({ source: Option.some(CHECKOUT), rifts: setup.lanes ?? [{ path: ORPHAN, branch: "feat/orphan", head: ORPHAN_HEAD, state: "clean" }], workrift: false })

/** The lost lines status gives for `setup`. */
const lostFor = (setup: Setup) => lostNow(ROOT, CHECKOUT, setup.runs ?? [], listedFor(setup), NOW).pipe(Effect.provide(layerFor(setup)))

/** What the queue check gets for `setup` and the commits its queue names. */
const answerFor = (setup: Setup, hashes: ReadonlyArray<string>) => lostAnswer(ROOT, CHECKOUT, setup.runs ?? [], listedFor(setup), NOW, hashes).pipe(Effect.provide(layerFor(setup)))

const ORPHAN_LINE = `- ${ORPHAN} · 2 d · 2 commits · orphan work · no session known`

/** A run whose unit `alpha` is in `state`, its request for round 1 at a1a1a1a1a1 written 8 h ago, and `findings` when given. */
const alphaIn = (state: string, findings: Option.Option<readonly [string, number]>): Setup => {
  const files: MemoryRunFiles.Files = new Map([
    [`${RUN}/alpha/log.md`, { text: "", at: NOW - 8 * HOUR }],
    [`${RUN}/alpha/round-1-request.md`, { text: "ready\nHead: a1a1a1a1a1\n", at: NOW - 8 * HOUR }],
  ])
  Option.map(findings, ([verdict, ago]) => files.set(`${RUN}/alpha/round-1-findings.md`, { text: `${verdict}\n`, at: NOW - ago }))
  return { runs: [{ name: "run-1", dir: RUN, units: [{ unit: "alpha", state }] }], files, lanes: [] }
}

describe("a unit's verifier, read from its run dir", () => {
  effectTest(
    "in verify with no verdict on its round: named with its verifier",
    Effect.map(lostFor(alphaIn("verify", Option.none())), (lines) => expect(lines).toEqual(["orchestrate: ready, not landed (1, oldest first):", "- ready, with its verifier: alpha a1a1a1a1a lane gone"])),
    hangGuard("in-memory"),
  )
  effectTest(
    "a changes verdict on its round: nothing until its next round",
    Effect.map(lostFor(alphaIn("verify", Option.some(["changes", 7 * HOUR]))), (lines) => expect(lines).toEqual([])),
    hangGuard("in-memory"),
  )
  effectTest(
    "a changes verdict on an earlier round: a later ready round supersedes it",
    Effect.map(
      lostFor(
        (() => {
          const setup = alphaIn("ready", Option.some(["changes", 9 * HOUR]))
          setup.files?.set(`${RUN}/alpha/round-2-request.md`, { text: "ready\nHead: a1a1a1a1a1\n", at: NOW - 8 * HOUR })
          setup.files?.delete(`${RUN}/alpha/round-1-request.md`)
          return setup
        })(),
      ),
      (lines) => expect(lines[1]).toBe("- ready, not landed 8 h: alpha a1a1a1a1a lane gone"),
    ),
    hangGuard("in-memory"),
  )
  effectTest(
    "accepted an hour ago: within the threshold from the verdict; seven hours ago: not landed",
    Effect.gen(function* () {
      expect(yield* lostFor(alphaIn("ready", Option.some(["accepted", HOUR])))).toEqual([])
      expect((yield* lostFor(alphaIn("ready", Option.some(["accepted", 7 * HOUR]))))[1]).toBe("- ready, not landed 7 h: alpha a1a1a1a1a lane gone")
    }),
    hangGuard("in-memory"),
  )
})

describe("who is on a lane, read from where it lives", () => {
  effectTest(
    "nobody: the orphan lane is named",
    Effect.map(lostFor({}), (lines) => expect(lines.slice(0, 2)).toEqual(["orchestrate: committed work not on main, nobody on it (1, oldest first):", ORPHAN_LINE])),
    hangGuard("in-memory"),
  )
  effectTest(
    "a session working in the lane's directory keeps it off",
    Effect.map(lostFor({ sessions: { ses_lane: { directory: ORPHAN, started: true } } }), (lines) => expect(lines).toEqual([])),
    hangGuard("in-memory"),
  )
  effectTest(
    "a session idle there for two days does not, and is named",
    Effect.map(lostFor({ sessions: { ses_lane: { directory: ORPHAN, started: true, idleSince: NOW - 48 * HOUR } } }), (lines) =>
      expect(lines[1]).toBe(ORPHAN_LINE.replace("no session known", "session ses_lane")),
    ),
    hangGuard("in-memory"),
  )
  effectTest(
    "a running subagent whose description names the lane keeps it off",
    Effect.map(lostFor({ children: [{ child: "ses_child", description: `implementor orphan r1 (lane: ${ORPHAN})` }], sessions: { ses_child: { directory: CHECKOUT, started: true } } }), (lines) =>
      expect(lines).toEqual([]),
    ),
    hangGuard("in-memory"),
  )
  effectTest(
    "a unit of the lane blocked keeps it off",
    Effect.map(lostFor({ runs: [{ name: "run-1", dir: RUN, units: [{ unit: "orphan", state: "blocked" }] }] }), (lines) => expect(lines).toEqual([])),
    hangGuard("in-memory"),
  )
  effectTest(
    "a queue item waiting that names the lane keeps it off; a done one does not",
    Effect.gen(function* () {
      const item = (state: string) => ({ ...NOTHING_HELD, queue: [{ text: "orphan: owner picks the schema", state, detail: Option.none<string>() }] })
      expect(yield* lostFor({ held: item("needs-you") })).toEqual([])
      expect((yield* lostFor({ held: item("done") }))[1]).toBe(ORPHAN_LINE)
    }),
    hangGuard("in-memory"),
  )
})

const ALPHA_WHY = "not on main: 1 commit not there, committed 2 d ago; land it, or mark it superseded or dropped"

describe("the queue check's answer: status's lists, to an orchestrator only, and the commits its queue names", () => {
  effectTest(
    "a root that started no unit's step hears of no lane, only of the commits its own queue names; main's own commit and an unknown one are not named",
    Effect.map(answerFor({}, ["a1a1a1a1a1", "e0e0e0e0e0", "0ddba11"]), (answer) => expect(answer).toEqual({ lines: [], keys: [], hashes: [{ hash: "a1a1a1a1a1", why: ALPHA_WHY }] })),
    hangGuard("in-memory"),
  )
  effectTest(
    "an orchestrator hears the same lines status prints, keyed by the lane",
    Effect.gen(function* () {
      const answer = yield* answerFor({ steps: ["alpha"] }, [])
      expect(answer).toEqual({ lines: yield* lostFor({}), keys: [ORPHAN], hashes: [] })
      expect(answer.lines[1]).toBe(ORPHAN_LINE)
    }),
    hangGuard("in-memory"),
  )
})

describe("Ergo's list status, read when `work` gives it", () => {
  const status = (more: Partial<LaneStatus>): ReadonlyMap<string, LaneStatus> =>
    new Map([[ORPHAN, { ahead: 2, by: Option.some("patch"), head: Option.some(ORPHAN_HEAD), lastCommit: Option.none(), dirty: Option.none(), error: Option.none(), ...more }]])
  effectTest(
    "ahead of the default branch by none (by patch or ancestry): on main, whatever git would say",
    Effect.gen(function* () {
      expect(yield* lostFor({ statuses: status({ ahead: 0 }) })).toEqual([])
      expect(yield* lostFor({ statuses: status({ ahead: 0, by: Option.some("ancestry") }) })).toEqual([])
    }),
    hangGuard("in-memory"),
  )
  effectTest(
    "its last commit an hour ago keeps the lane off; an error, or a status of another head, is not read and git answers",
    Effect.gen(function* () {
      expect(yield* lostFor({ statuses: status({ lastCommit: Option.some(NOW - HOUR) }) })).toEqual([])
      expect((yield* lostFor({ statuses: status({ ahead: 0, error: Option.some("git failed") }) }))[1]).toBe(ORPHAN_LINE)
      expect((yield* lostFor({ statuses: status({ ahead: 0, head: Option.some("1234567abc") }) }))[1]).toBe(ORPHAN_LINE)
    }),
    hangGuard("in-memory"),
  )
})
