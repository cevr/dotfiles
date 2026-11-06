import { describe, expect, test } from "bun:test"
import { alarm, monitor, notice } from "./laws.ts"
import {
  alarmLetter,
  alarmReceipt,
  cancelReceipt,
  durationOf,
  excerpt,
  freshPrompt,
  jobLetter,
  jobReceipt,
  type JobView,
  lateBy,
  runPhrase,
  listing,
  monitorLetter,
  monitorReceipt,
  tailOf,
  unguarded,
} from "./message.ts"
import type { Run } from "./job.ts"
import { type Job, specOf } from "./wake.ts"

describe("an alarm's letter", () => {
  test("on time: what fired, when it was set and due, and the note verbatim", () => {
    const letter = alarmLetter(alarm, alarm.dueAt, alarm.dueAt + 200)
    expect(letter.text).toBe(
      [
        "⏰ Wake w000001 fired: the alarm you set at 2023-11-14T22:13:20.000Z, due 2023-11-14T22:14:20.000Z.",
        "Note: Check CI run 42: green means merge.",
      ].join("\n"),
    )
    expect(letter.description).toBe("wake w000001 · Check CI run 42: green means merge.")
    expect(letter.metadata).toMatchObject({ source: "wake", id: "w000001", kind: "alarm", mode: "wake", lateMs: 200 })
  })

  test("late: says how late, and that no server was running at its time", () => {
    const letter = alarmLetter(alarm, alarm.dueAt, alarm.dueAt + 2 * 3600_000 + 5 * 60_000)
    expect(letter.text).toContain("It fired 2h 5m late: no OpenCode server was running at 2023-11-14T22:14:20.000Z, so it went when one started.")
    expect(letter.description).toBe("wake w000001 · 2h 5m late · Check CI run 42: green means merge.")
  })

  test("a notify fire says it started no turn; a repeat says when it is next due and how to stop it", () => {
    expect(alarmLetter({ ...alarm, mode: "notify" }, alarm.dueAt, alarm.dueAt).text).toContain("it started no turn")
    expect(alarmLetter({ ...alarm, mode: "notify" }, alarm.dueAt, alarm.dueAt).description).toStartWith("notice w000001")
    const repeat = alarmLetter({ ...alarm, everySeconds: 300 }, alarm.dueAt, alarm.dueAt, alarm.dueAt + 300_000)
    expect(repeat.text).toContain('It repeats every 5m; the next is due 2023-11-14T22:19:20.000Z. Cancel it with wake_cancel({ id: "w000001" })')
  })

  test("a fresh session's prompt leads with what it was asked, then where it came from", () => {
    const prompt = freshPrompt(alarm, { directory: "/work/other", prompt: "Summarise the builds." }, alarm.dueAt, alarm.dueAt + 3 * 60_000)
    expect(prompt.split("\n")[0]).toBe("Summarise the builds.")
    expect(prompt).toContain("Started by wake w000001")
    expect(prompt).toContain("in session ses_a")
    expect(prompt).toContain("It went 3m late")
    expect(prompt).toContain("Its note: Check CI run 42")
  })
})

describe("a monitor's letter", () => {
  const check = { exitCode: 0, stdout: "booting\nok", stderr: "", timedOut: false }

  test("matched: the command, the checks, the note and the last output", () => {
    const letter = monitorLetter(monitor, "matched", 3, check, monitor.setAt + 90_000)
    expect(letter.text.split("\n")[0]).toBe("⏰ Monitor w000003 matched: `curl -fsS localhost:3000/health` printed a match for /ok/ after 3 checks.")
    expect(letter.text).toContain("Note: The deploy is live: tell the user.")
    expect(letter.text).toContain("Last output (exit 0):\nbooting\nok")
    expect(letter.metadata).toMatchObject({ outcome: "matched", checks: 3 })
  })

  test("timed out late: gave up, and how late", () => {
    const letter = monitorLetter(monitor, "timed-out", 1, { ...check, stdout: "", timedOut: true }, monitor.deadline + 10 * 60_000)
    expect(letter.text).toContain("timed out")
    expect(letter.text).toContain("It gave up 10m late")
    expect(letter.text).toContain("Last output (exit none: the check ran out of time):\n(none)")
  })
})

describe("receipts and the listing", () => {
  const now = alarm.setAt

  test("a wake tells the agent to end its turn; notify and fresh sessions say how to cancel", () => {
    expect(alarmReceipt(alarm, now)).toBe(
      [
        "Alarm w000001 set: it wakes this session at 2023-11-14T22:14:20.000Z (in 1m).",
        "End your turn now unless there is other work: the alarm starts a new turn with your note.",
      ].join("\n"),
    )
    expect(alarmReceipt({ ...alarm, mode: "notify" }, now)).toContain("leaves a notice for this session")
    expect(alarmReceipt({ ...alarm, newSession: { directory: "/x", prompt: "p" } }, now)).toContain("starts a new session in /x")
    expect(alarmReceipt(alarm, now, unguarded("launchctl refused"))).toContain("No OS backstop was set (launchctl refused): it fires only while an OpenCode server runs.")
  })

  test("a monitor names its command, pattern and deadline", () => {
    expect(monitorReceipt(monitor, now)).toContain("runs `curl -fsS localhost:3000/health` in /work/app every 30s until its stdout matches /ok/, and gives up at 2023-11-14T22:43:20.000Z (in 30m)")
  })

  test("cancel and list", () => {
    expect(cancelReceipt([])).toBe("Nothing was pending to cancel.")
    expect(cancelReceipt(["w000001", "w000003"])).toBe("Cancelled w000001, w000003.")
    const text = listing([monitor, alarm], [notice], now)
    expect(text.split("\n")).toEqual([
      "Now: 2023-11-14T22:13:20.000Z.",
      "Pending (2):",
      "- w000001: alarm · wake · due 2023-11-14T22:14:20.000Z (in 1m) · note: Check CI run 42: green means merge.",
      "- w000003: monitor · notify · `curl -fsS localhost:3000/health` every 30s · until /ok/ · gives up 2023-11-14T22:43:20.000Z (in 30m) · note: The deploy is live: tell the user.",
      "Unread notices (1), delivered to your next turn:",
      "- w000003: monitor w000003 matched · The deploy",
    ])
    expect(listing([], [], now)).toBe("Now: 2023-11-14T22:13:20.000Z.\nNo alarms, monitors or latches pending.")
  })
})

describe("spans and cuts", () => {
  test("durationOf", () => {
    expect([45_000, 14 * 60_000, 2 * 3600_000 + 5 * 60_000, 3600_000, 3 * 86_400_000 + 4 * 3600_000, 86_400_000].map(durationOf)).toEqual(["45s", "14m", "2h 5m", "1h", "3d 4h", "1d"])
  })

  test("lateBy is undefined under a minute", () => {
    expect(lateBy(0, 59_999)).toBeUndefined()
    expect(lateBy(0, 60_000)).toBe(60_000)
  })

  test("excerpt flattens and cuts; tailOf keeps the end", () => {
    expect(excerpt("a\n b   c", 10)).toBe("a b c")
    expect(excerpt("abcdefghij", 5)).toBe("abcd…")
    expect(tailOf("abcdefghij", 3)).toBe("…hij")
  })
})

describe("a job's words", () => {
  const SET = Date.UTC(2026, 10, 6, 12)
  const job: Job = {
    kind: "job",
    id: "j000001",
    sessionID: "ses_a",
    directory: "/work/app",
    mode: "wake",
    note: "Read the failures.",
    setAt: SET,
    command: "bun run gate",
    cwd: "/work/app",
    heavy: true,
    timeoutSeconds: 3600,
    dripped: 0,
    drippedAt: SET,
  }
  const view = (run: Run): JobView => ({ spec: specOf(job), run, log: "/s/j000001/log", logTail: "ok\n", progress: "" })
  const exit = { exitCode: 0, startedAt: SET, endedAt: SET + 90_000, timedOut: false, killed: false }

  test("the receipt names the id, log, unit and $JOB_DRIP, and says to end the turn", () => {
    const receipt = jobReceipt(job, { log: "/s/j000001/log", drip: "/s/j000001/drip", how: "systemd", unit: "opencode-job-j000001" })
    expect(receipt.split("\n")[0]).toBe("Job j000001 started. Log: /s/j000001/log")
    expect(receipt).toContain("as the systemd user unit opencode-job-j000001, niced")
    expect(receipt).toContain("$JOB_DRIP (/s/j000001/drip)")
    expect(receipt).toContain("End your turn now")
    const fallback = jobReceipt(job, { log: "l", drip: "d", how: "detached", warning: "systemd-run --user refused (x)" })
    expect(fallback).toContain("in its own process group")
    expect(fallback).toContain("systemd-run --user refused (x)")
  })

  test("an end reads as its exit, a timeout, a kill or a loss", () => {
    expect(runPhrase({ state: "ended", exit }, SET)).toBe("exited 0 after 2m")
    expect(runPhrase({ state: "ended", exit: { ...exit, exitCode: null, signal: "SIGTERM", timedOut: true } }, SET)).toStartWith("was stopped at its timeout")
    expect(runPhrase({ state: "ended", exit: { ...exit, exitCode: null, killed: true } }, SET)).toStartWith("was killed")
    expect(runPhrase({ state: "lost", why: "its runner is gone" }, SET)).toBe("was lost: its runner is gone")
    const letter = jobLetter(job, view({ state: "ended", exit }), SET + 90_500)
    expect(letter.text.split("\n").at(0)).toBe("⏰ Job j000001 exited 0 after 2m: `bun run gate`.")
    expect(letter.text).toContain("Note: Read the failures.")
    expect(letter.metadata).toMatchObject({ kind: "job", state: "ended", exitCode: 0 })
  })
})
