import { expect, test } from "bun:test"
import { heavyJob, jobArgv } from "./job-admission.ts"

test("an explicit true may add a heavy job, and a false cannot exempt a classified command", () => {
  for (const requested of [true, false]) {
    expect(heavyJob(requested, true)).toBe(true)
    expect(heavyJob(requested, false)).toBe(requested === true)
  }
})

test("a managed job's exact payload argv is passed after the launcher boundary", () => {
  const original = "printf '%s' \"two words\""
  expect(jobArgv(["/path/bun", "/path/host-admit.ts"], original, "check")).toEqual([
    "/path/bun", "/path/host-admit.ts", "check", "run", "--class", "check", "--", "/bin/sh", "-c", original,
  ])
  expect(jobArgv(["/path/bun", "/path/host-admit.ts"], original)).toEqual(["/bin/sh", "-c", original])
})
