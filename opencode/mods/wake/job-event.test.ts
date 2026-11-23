// The typed end of a job: each kind of end reads as its own disposition, an
// older runner's exit too; a run that is not over has no end; the log handle
// names a job and a generation and nothing a path could be made of.
import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { JobExit, type Run } from "./job.ts"
import { dispositionOf, dispositionOfExit, generationOf, isJobID, JobEvent, logRef, logRefOf, terminalOf } from "./job-event.ts"

const exit = (fields: Partial<JobExit>): JobExit => ({ exitCode: 0, startedAt: 1, endedAt: 2, timedOut: false, killed: false, ...fields })
/** An exit file as an older runner wrote it for a command no exit code ended: `exitCode` null. */
const signalled = (fields: Partial<JobExit>): JobExit => ({ ...Schema.decodeUnknownSync(Schema.fromJsonString(JobExit))(`{"exitCode":null,"startedAt":1,"endedAt":2,"timedOut":false,"killed":false}`), ...fields })

describe("dispositions", () => {
  test("an older runner's exit reads its kind off its fields; this build's carries its own", () => {
    expect([
      dispositionOfExit(exit({ exitCode: 0 })),
      dispositionOfExit(exit({ exitCode: 2 })),
      dispositionOfExit(signalled({ signal: "SIGKILL" })),
      dispositionOfExit(signalled({ timedOut: true })),
      dispositionOfExit(signalled({ killed: true })),
      dispositionOfExit(exit({ exitCode: 127, disposition: "spawn-failed" })),
    ]).toEqual(["succeeded", "failed", "signalled", "timed-out", "cancelled", "spawn-failed"])
  })

  test("a lost runner and a launch never claimed are distinct; a run still going has none", () => {
    const runs: ReadonlyArray<Run> = [
      { state: "starting" },
      { state: "running", startedAt: 1 },
      { state: "lost", why: "gone", cause: "runner-gone" },
      { state: "lost", why: "never", cause: "never-started" },
      { state: "lost", why: "an older build's loss" },
    ]
    expect(runs.map(dispositionOf)).toEqual([Option.none(), Option.none(), Option.some("lost"), Option.some("never-started"), Option.some("lost")])
  })
})

describe("the end event", () => {
  test("carries the job, its generation, its sequence, its kind, when, its exit code and its log handle; it decodes as JobEvent", () => {
    const event = terminalOf({ id: "j00000a", generation: 1 }, { state: "ended", exit: exit({ exitCode: 3, endedAt: 50, sequence: 6, disposition: "failed" }) }, 99)
    expect(event).toEqual(Option.some({ version: 1, job: "j00000a", generation: 1, sequence: 6, disposition: "failed", at: 50, exitCode: 3, log: "job-log:j00000a/1" }))
    expect(Option.isSome(Option.flatMap(event, Schema.decodeUnknownOption(JobEvent)))).toBe(true)
  })

  test("a loss is dated when it was seen and has no exit code; an older spec reads as generation 1", () => {
    expect(Option.getOrThrow(terminalOf({ id: "j00000b" }, { state: "lost", why: "gone", cause: "runner-gone" }, 99))).toMatchObject({
      generation: 1,
      disposition: "lost",
      at: 99,
      exitCode: signalled({}).exitCode,
    })
    expect(generationOf({})).toBe(1)
    expect(terminalOf({ id: "j00000b" }, { state: "running", startedAt: 1 }, 99)).toEqual(Option.none())
  })
})

describe("the log handle", () => {
  test("round-trips a job and generation, and refuses a path, another scheme or a traversal", () => {
    expect(logRefOf(logRef("j0abc12", 3))).toEqual(Option.some({ id: "j0abc12", generation: 3 }))
    expect(["/state/opencode-job/j0abc12/log", "job-log:../../etc/passwd", "job-log:j0abc12/../1", "file:j0abc12/1", "job-log:j0abc12/0", "job-log:J0ABC12/1"].map((ref) => Option.isSome(logRefOf(ref)))).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ])
    expect([isJobID("j0abc12"), isJobID("j0abc1"), isJobID("w0abc12"), isJobID("j0abc12/..")]).toEqual([true, false, false, false])
  })
})
