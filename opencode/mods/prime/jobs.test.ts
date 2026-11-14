import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { jobDetail, jobElapsed, type JobEntry, jobItem, jobsOf, jobState, logLines, runningJobs } from "./jobs.ts"
import { jobLine, layout, widths } from "./panel.ts"

const job = (over: Partial<JobEntry> = {}): JobEntry => ({
  id: "jabc123",
  note: "Read the failures.\nThen fix them.",
  command: "bun test --parallel=4\necho done",
  cwd: "/work/app",
  setAt: 0,
  state: "running",
  exitCode: Option.none(),
  startedAt: Option.some(1000),
  endedAt: Option.none(),
  logTail: "",
  ...over,
})

describe("the dock's job item", () => {
  test("counts the running jobs and is gone while none runs", () => {
    const jobs = jobsOf(Option.some({ now: 0, jobs: [job(), job({ id: "j2", state: "starting" }), job({ id: "j3", state: "exited", exitCode: Option.some(0) })] }))
    expect(runningJobs(jobs)).toBe(2)
    expect(jobItem(runningJobs(jobs))).toEqual(Option.some("2 jobs"))
    expect(jobItem(1)).toEqual(Option.some("1 job"))
    expect(jobItem(runningJobs([job({ state: "killed" })]))).toEqual(Option.none())
    expect(runningJobs(jobsOf(Option.none()))).toBe(0)
  })
})

describe("a Jobs tab row", () => {
  test("says its state as a shell's row does, and how long it ran", () => {
    expect(jobState(job())).toBe("running")
    expect(jobState(job({ state: "exited", exitCode: Option.some(2) }))).toBe("exited 2")
    expect(jobState(job({ state: "timed out" }))).toBe("timed out")
    expect(jobElapsed(job(), 66_000)).toBe("1m 05s")
    expect(jobElapsed(job({ state: "killed", endedAt: Option.some(31_000) }), 999_000)).toBe("30s")
    expect(jobElapsed(job({ state: "starting", startedAt: Option.none() }), 4000)).toBe("4s")
  })

  test("lays out its id, note, command, state and time; a running one's diamond turns, an exit 0 is muted, a failure an error", () => {
    const line = jobLine(job(), 66_000, "⠋")
    expect(line).toMatchObject({ glyph: "⠋", tone: "success", role: "jabc123", name: "Read the failures.", status: "bun test --parallel=4", state: "running", time: "1m 05s" })
    const drawn = layout(line, widths([line]), 120)
      .map((cell) => cell.text)
      .join("")
    expect(drawn).toMatch(/^⠋ jabc123 {2}Read the failures\. {2}bun test --parallel=4 +running {2}1m 05s$/)
    expect([...drawn]).toHaveLength(120)
    const ended = { endedAt: Option.some(5000) }
    expect(jobLine(job({ ...ended, state: "exited", exitCode: Option.some(0) }), 9000, "⠋").tone).toBe("muted")
    expect(jobLine(job({ ...ended, state: "exited", exitCode: Option.some(1) }), 9000, "⠋").tone).toBe("error")
    expect(jobLine(job({ ...ended, state: "killed" }), 9000, "⠋")).toMatchObject({ tone: "error", state: "killed", time: "4s" })
  })

  test("the selected job's log tail is its last lines with text", () => {
    expect(logLines("a\n\nb\nc  \nd\ne\n\n")).toEqual(["b", "c", "d", "e"])
    expect(logLines("")).toEqual([])
  })

  test("Enter shows the whole job", () => {
    const shown = jobDetail(job({ state: "exited", exitCode: Option.some(3), endedAt: Option.some(4000), logTail: "x\ny\n" }), 9000)
    expect(shown.title).toBe("Job jabc123")
    expect(shown.message).toBe(["Command: bun test --parallel=4\necho done", "In: /work/app", "State: exited 3 · 3s", "", "Note: Read the failures.\nThen fix them.", "", "x\ny"].join("\n"))
    expect(jobDetail(job(), 2000).message).toEndWith("(no output yet)")
  })
})
