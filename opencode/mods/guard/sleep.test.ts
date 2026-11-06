import { describe, expect, test } from "bun:test"
import { openingSleep, sleepSeconds, sleepsTooLong } from "./sleep.ts"

describe("a line's opening sleep", () => {
  test("is the first simple command's sleep, through separators and prefixes", () => {
    expect(openingSleep("sleep 60")).toEqual({ sleep: "sleep 60", seconds: 60 })
    expect(openingSleep("sleep 60 && tail -5 log")).toEqual({ sleep: "sleep 60", seconds: 60 })
    expect(openingSleep("sleep 45; gh run view")).toEqual({ sleep: "sleep 45", seconds: 45 })
    expect(openingSleep("sleep 90 || true")).toEqual({ sleep: "sleep 90", seconds: 90 })
    expect(openingSleep("(sleep 40; ls)")).toEqual({ sleep: "sleep 40", seconds: 40 })
    expect(openingSleep("nohup /bin/sleep 120")).toEqual({ sleep: "/bin/sleep 120", seconds: 120 })
    expect(openingSleep("  sleep 30\ntail log")).toEqual({ sleep: "sleep 30", seconds: 30 })
  })

  test("is none when the line opens with anything else, or the sleep is not a duration", () => {
    expect(openingSleep("tail log && sleep 60")).toBeUndefined()
    expect(openingSleep("until test -f done; do sleep 60; done")).toBeUndefined()
    expect(openingSleep("echo sleep 60")).toBeUndefined()
    expect(openingSleep("sleep $DELAY")).toBeUndefined()
    expect(openingSleep("sleep")).toBeUndefined()
    expect(openingSleep("")).toBeUndefined()
  })

  test("reads sleep's units and adds its operands", () => {
    expect(sleepSeconds(["30s"])).toBe(30)
    expect(sleepSeconds(["1.5m"])).toBe(90)
    expect(sleepSeconds(["1h"])).toBe(3600)
    expect(sleepSeconds(["1d"])).toBe(86_400)
    expect(sleepSeconds(["1m", "30s"])).toBe(90)
    expect(sleepSeconds([".5m"])).toBe(30)
    expect(sleepSeconds(["infinity"])).toBe(Number.POSITIVE_INFINITY)
    expect(sleepSeconds(["10", "x"])).toBeUndefined()
  })

  test("is too long from 30 seconds", () => {
    expect(sleepsTooLong("sleep 29")).toBeUndefined()
    expect(sleepsTooLong("sleep 29.9")).toBeUndefined()
    expect(sleepsTooLong("sleep 30")?.seconds).toBe(30)
    expect(sleepsTooLong("sleep 0.5m")?.seconds).toBe(30)
    expect(sleepsTooLong("sleep infinity")?.seconds).toBe(Number.POSITIVE_INFINITY)
  })
})
