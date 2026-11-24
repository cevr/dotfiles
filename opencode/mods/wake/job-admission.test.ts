import { expect, test } from "bun:test"
import { heavyJob, jobArgv } from "./job-admission.ts"

test("an explicit true may add a heavy job, and a false cannot exempt a classified command", () => {
  for (const requested of [true, false]) {
    expect(heavyJob(requested, true)).toBe(true)
    expect(heavyJob(requested, false)).toBe(requested === true)
  }
})

test("a job's shell payload remains one exact argument", () => {
  const original = "GOMAXPROCS=4 go test -p 4 -parallel 4 './a path'"
  expect(jobArgv(original)).toEqual(["/bin/sh", "-c", original])
})
