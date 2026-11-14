import { describe, expect, test } from "bun:test"
import { type JobSpec, jobShownOf } from "@dotfiles/opencode-wake/job"
import { Option } from "effect"
import { decodeJobs, refusalOf } from "./jobs.ts"

const SPEC: JobSpec = { id: "jabc123", sessionID: "ses_a", directory: "/w", command: "make", cwd: "/w", note: "n", heavy: false, timeoutSeconds: 60, setAt: 5 }

describe("the jobs reading", () => {
  test("reads the wake server's board as it shows each job", () => {
    const exited = jobShownOf(SPEC, { state: "ended", exit: { exitCode: 2, startedAt: 6, endedAt: 9, timedOut: false, killed: false } }, "tail\n")
    const starting = jobShownOf(SPEC, { state: "starting" }, "")
    expect(Option.map(decodeJobs({ now: 10, jobs: [exited, starting] }), (read) => read.jobs)).toEqual(
      Option.some([
        { id: "jabc123", note: "n", command: "make", cwd: "/w", setAt: 5, state: "exited", exitCode: Option.some(2), startedAt: Option.some(6), endedAt: Option.some(9), logTail: "tail\n" },
        { id: "jabc123", note: "n", command: "make", cwd: "/w", setAt: 5, state: "starting", exitCode: Option.none(), startedAt: Option.none(), endedAt: Option.none(), logTail: "" },
      ]),
    )
    const killed = jobShownOf(SPEC, { state: "ended", exit: { exitCode: 143, signal: "SIGTERM", startedAt: 6, endedAt: 9, timedOut: false, killed: true } }, "")
    expect(Option.map(decodeJobs({ now: 10, jobs: [killed] }), (read) => read.jobs.map((job) => job.state))).toEqual(Option.some(["killed"]))
    expect(Option.isNone(decodeJobs({ now: 10 }))).toBe(true)
  })
})

describe("the Jobs tab's kill", () => {
  test("a stop is no refusal; a refusal, or an answer that did not read, is its reason", () => {
    expect(refusalOf(Option.some({ outcome: "killed" }))).toEqual(Option.none())
    expect(refusalOf(Option.some({ outcome: "refused", reason: "Job jabc123 is not running: it exited 0." }))).toEqual(Option.some("Job jabc123 is not running: it exited 0."))
    expect(refusalOf(Option.none())).toEqual(Option.some("the wake server's answer did not read"))
  })
})
