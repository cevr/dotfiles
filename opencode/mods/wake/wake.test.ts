import { describe, expect, test } from "bun:test"
import { alarmOf, dueAtOf, fingerprint, matched, MAX_AHEAD_SECONDS, MAX_REPEAT_TIMEOUT_SECONDS, monitorOf, moved, nextDueAt, stepOf, WakeRejected } from "./wake.ts"

const NOW = Date.parse("2026-11-05T14:00:00.250Z")
const place = { id: "w000001", sessionID: "ses_a", directory: "/work/app", now: NOW }
const reason = (value: unknown) => (value instanceof WakeRejected ? value.reason : undefined)

describe("dueAtOf", () => {
  test("afterSeconds counts from now; at names its time", () => {
    expect(dueAtOf({ afterSeconds: 3 }, NOW)).toBe(NOW + 3000)
    expect(dueAtOf({ at: "2026-11-05T14:30:00Z" }, NOW)).toBe(Date.parse("2026-11-05T14:30:00Z"))
  })

  test("an at within the current second is now, one before it is past", () => {
    expect(dueAtOf({ at: "2026-11-05T14:00:00Z" }, NOW)).toBe(NOW)
    expect(reason(dueAtOf({ at: "2026-11-05T13:59:59Z" }, NOW))).toContain("in the past")
  })

  test("refuses both, neither, a bad time, a negative wait, and more than a year ahead", () => {
    expect(reason(dueAtOf({ afterSeconds: 1, at: "2026-11-05T15:00:00Z" }, NOW))).toContain("not both")
    expect(reason(dueAtOf({}, NOW))).toContain("give afterSeconds")
    expect(reason(dueAtOf({ at: "tomorrow" }, NOW))).toContain("not an ISO 8601")
    expect(reason(dueAtOf({ afterSeconds: -1 }, NOW))).toContain("0 or more")
    expect(reason(dueAtOf({ afterSeconds: Number.NaN }, NOW))).toContain("0 or more")
    expect(dueAtOf({ afterSeconds: MAX_AHEAD_SECONDS }, NOW)).toBe(NOW + MAX_AHEAD_SECONDS * 1000)
    expect(reason(dueAtOf({ afterSeconds: MAX_AHEAD_SECONDS + 1 }, NOW))).toContain("365 days")
  })
})

describe("alarmOf", () => {
  test("sets a wake by default, keeping the note verbatim", () => {
    const alarm = alarmOf({ afterSeconds: 60, note: "  Check CI run 42.\nGreen means merge.  " }, place)
    expect(alarm).toEqual({
      kind: "alarm",
      id: "w000001",
      sessionID: "ses_a",
      directory: "/work/app",
      mode: "wake",
      note: "  Check CI run 42.\nGreen means merge.  ",
      setAt: NOW,
      dueAt: NOW + 60_000,
    })
  })

  test("a repeat takes at least a minute; a fresh session starts in this directory unless it names one", () => {
    expect(reason(alarmOf({ afterSeconds: 1, everySeconds: 59, note: "n" }, place))).toContain("at least 60")
    const fresh = alarmOf({ afterSeconds: 1, everySeconds: 3600, note: "n", newSession: { prompt: "Go." } }, place)
    expect(fresh instanceof WakeRejected ? undefined : fresh.newSession).toEqual({ directory: "/work/app", prompt: "Go." })
    expect(fresh instanceof WakeRejected ? undefined : fresh.everySeconds).toBe(3600)
  })

  test("refuses an empty or overlong note, a fresh session with no prompt, in notify mode or at a relative directory", () => {
    expect(reason(alarmOf({ afterSeconds: 1, note: " " }, place))).toContain("note is empty")
    expect(reason(alarmOf({ afterSeconds: 1, note: "x".repeat(2001) }, place))).toContain("at most 2000")
    expect(reason(alarmOf({ afterSeconds: 1, note: "n", newSession: { prompt: "" } }, place))).toContain("prompt is empty")
    expect(reason(alarmOf({ afterSeconds: 1, note: "n", mode: "notify", newSession: { prompt: "Go." } }, place))).toContain("notify mode cannot")
    expect(reason(alarmOf({ afterSeconds: 1, note: "n", newSession: { directory: "app", prompt: "Go." } }, place))).toContain("absolute")
  })
})

describe("monitorOf", () => {
  test("defaults: every 30 s for 30 min in the server's directory, done on exit 0", () => {
    const monitor = monitorOf({ command: "gh pr checks 7", note: "merge when green" }, place)
    expect(monitor).toEqual({
      kind: "monitor",
      id: "w000001",
      sessionID: "ses_a",
      directory: "/work/app",
      mode: "wake",
      note: "merge when green",
      setAt: NOW,
      command: "gh pr checks 7",
      cwd: "/work/app",
      intervalSeconds: 30,
      deadline: NOW + 1_800_000,
    })
  })

  test("refuses an empty command, a bad pattern, a short interval, a timeout out of range, a relative cwd", () => {
    const ask = { command: "true", note: "n" }
    expect(reason(monitorOf({ ...ask, command: " " }, place))).toContain("command is empty")
    expect(reason(monitorOf({ ...ask, until: "(" }, place))).toContain("not a valid regular expression")
    expect(reason(monitorOf({ ...ask, intervalSeconds: 0.5 }, place))).toContain("at least 1")
    expect(reason(monitorOf({ ...ask, timeoutSeconds: 0 }, place))).toContain("at most 86400")
    expect(reason(monitorOf({ ...ask, timeoutSeconds: 86_401 }, place))).toContain("at most 86400")
    expect(reason(monitorOf({ ...ask, cwd: "src" }, place))).toContain("absolute")
  })

  test("a repeat watches a day by default and up to 30 days; a baseline is for a change repeat and is kept as its fingerprint", () => {
    const ask = { command: "gh pr list", note: "n" }
    const day = monitorOf({ ...ask, repeat: "match" }, place)
    expect(day instanceof WakeRejected ? undefined : [day.repeat, day.deadline]).toEqual(["match", NOW + 86_400_000])
    const month = monitorOf({ ...ask, repeat: "change", timeoutSeconds: MAX_REPEAT_TIMEOUT_SECONDS, baseline: "7 OPEN\n" }, place)
    expect(month instanceof WakeRejected ? undefined : [month.deadline, month.seen]).toEqual([NOW + MAX_REPEAT_TIMEOUT_SECONDS * 1000, fingerprint("7 OPEN")])
    expect(reason(monitorOf({ ...ask, repeat: "change", timeoutSeconds: MAX_REPEAT_TIMEOUT_SECONDS + 1 }, place))).toContain(`at most ${MAX_REPEAT_TIMEOUT_SECONDS}`)
    expect(reason(monitorOf({ ...ask, baseline: "x" }, place))).toBe('a baseline is for repeat: "change"')
    expect(reason(monitorOf({ ...ask, repeat: "often" as never }, place))).toContain('repeat is "match" or "change"')
  })
})

describe("stepOf", () => {
  const check = (exitCode: number, stdout: string) => ({ exitCode, stdout, stderr: "", timedOut: false })
  const base = monitorOf({ command: "c", note: "n" }, place)
  if (base instanceof WakeRejected) throw base

  test("a one-shot fires on a match and keeps nothing", () => {
    expect(stepOf(base, check(0, "x"))).toEqual({ fire: true, state: {} })
    expect(stepOf(base, check(1, "x"))).toEqual({ fire: false, state: {} })
  })

  test("a match repeat fires on a match after a miss, or its first, not on a match after a match", () => {
    const repeat = { ...base, repeat: "match" as const }
    expect(stepOf(repeat, check(0, "x"))).toEqual({ fire: true, state: { matching: true } })
    expect(stepOf({ ...repeat, matching: true }, check(0, "x"))).toEqual({ fire: false, state: { matching: true } })
    expect(stepOf({ ...repeat, matching: true }, check(1, "x"))).toEqual({ fire: false, state: { matching: false } })
    expect(stepOf({ ...repeat, matching: false }, check(0, "x"))).toEqual({ fire: true, state: { matching: true } })
  })

  test("a change repeat takes its first match as the baseline, fires when a match's stdout differs, and a miss leaves it", () => {
    const repeat = { ...base, repeat: "change" as const }
    expect(stepOf(repeat, check(0, "a"))).toEqual({ fire: false, state: { seen: fingerprint("a") } })
    const seen = { ...repeat, seen: fingerprint("a") }
    expect(stepOf(seen, check(0, " a\n"))).toEqual({ fire: false, state: { seen: fingerprint("a") } })
    expect(stepOf(seen, check(0, "b"))).toEqual({ fire: true, state: { seen: fingerprint("b") } })
    expect(stepOf(seen, check(1, "b"))).toEqual({ fire: false, state: { seen: fingerprint("a") } })
    expect(moved(seen, { seen: fingerprint("a") })).toBe(false)
    expect(moved(seen, { seen: fingerprint("b") })).toBe(true)
    expect(moved({ ...base, repeat: "match", matching: true }, { matching: false })).toBe(true)
  })
})

describe("fingerprint", () => {
  test("is the same for the same trimmed text and differs for another", () => {
    expect(fingerprint("7 OPEN\n")).toBe(fingerprint("7 OPEN"))
    expect(fingerprint("7 OPEN")).not.toBe(fingerprint("7 MERGED"))
    expect(fingerprint("")).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe("nextDueAt", () => {
  test("the next tick ahead, every missed tick folded into the fire", () => {
    expect(nextDueAt(1000, 60, 1000)).toBe(61_000)
    expect(nextDueAt(1000, 60, 60_999)).toBe(61_000)
    expect(nextDueAt(1000, 60, 61_000)).toBe(121_000)
    expect(nextDueAt(1000, 60, 1000 + 10 * 60_000 + 5)).toBe(1000 + 11 * 60_000)
  })
})

describe("matched", () => {
  const check = (exitCode: number, stdout: string, timedOut = false) => ({ exitCode, stdout, stderr: "", timedOut })

  test("with until: stdout matches, line by line, whatever the exit", () => {
    expect(matched({ until: "^ok$" }, check(1, "booting\nok\n"))).toBe(true)
    expect(matched({ until: "^ok$" }, check(0, "not ok"))).toBe(false)
  })

  test("without until: exit 0; a check that ran out of time never matches", () => {
    expect(matched({}, check(0, ""))).toBe(true)
    expect(matched({}, check(1, ""))).toBe(false)
    expect(matched({}, check(0, "", true))).toBe(false)
    expect(matched({ until: "ok" }, check(0, "ok", true))).toBe(false)
  })
})
