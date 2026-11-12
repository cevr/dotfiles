// The service's CPU time as plugin-start.ts reads it: `ps`'s `time` on macOS, `/proc/<pid>/stat` on Linux.
import { describe, expect, test } from "bun:test"
import { groupCpu, procStat, psTime } from "./plugin-start.ts"

describe("the service's CPU time", () => {
  test("ps's time reads as ms, minutes and hours and days included", () => {
    expect(psTime("0:01.43")).toBeCloseTo(1_430)
    expect(psTime("12:00.50")).toBeCloseTo(720_500)
    expect(psTime("1:02:03.04")).toBeCloseTo(3_723_040)
    expect(psTime("2-00:00:01.00")).toBeCloseTo(172_801_000)
  })

  test("a /proc stat line gives its process group and its user and system ticks, whatever its command name holds", () => {
    // As the workbox's kernel writes it, the command name with a space and a parenthesis.
    const line = "2138369 (bun (x) y) R 2138357 2138300 2138357 0 -1 4194304 135 0 0 0 250 31 0 0 20 0 1 0 34781637 3346432 461"
    expect(procStat(line)).toEqual({ group: 2138300, ticks: 281 })
  })

  test("the init process's group has spent some CPU, and a group with no process none", () => {
    expect(groupCpu(1)).toBeGreaterThan(0)
    expect(groupCpu(999_999_999)).toBe(0)
  })
})
