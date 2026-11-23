import { expect, test } from "bun:test"
import { Option } from "effect"
import { capacityOf, type Measurements, measureSupply, runnableLimit } from "./host-supply.ts"

const interval: Measurements = {
  id: "sample", platform: "linux", before: { idle: 100, total: 200, at: 0 }, after: { idle: 600, total: 1000, at: 1000 },
  hostCpuMilli: 16_000, effectiveCpuMilli: 16_000, runnable: 6, memoryBytes: 24 * 2 ** 30,
  totalMemoryBytes: 32 * 2 ** 30, controllerAvailable: true,
  pressure: "clear", qualified: true, managed: [], protectedLowerBoundMilli: 0, volumes: {}, keys: [],
}

test("a 16-core Linux host with six outside cores and two protected gives exactly two four-core budgets", () => {
  const sample = Option.getOrThrow(measureSupply(interval))
  expect(sample?.outsideNoncriticalMilli).toBe(6000)
  expect(sample && capacityOf(sample)).toBe(8000)
  expect(sample?.qualification).toBe("enforced")
})

test("subtract only a coherent measured Linux cgroup join, not its idle reservation or an overrun", () => {
  const use = { binding: "bound", measuredCpuMilli: 2000, enforcedCpuMilli: 4000 }
  expect(Option.getOrThrow(measureSupply({ ...interval, managed: [use] })).outsideNoncriticalMilli).toBe(4000)
  for (const managed of [[use, use], [{ ...use, measuredCpuMilli: 5000 }]]) {
    const sample = Option.getOrThrow(measureSupply({ ...interval, managed }))
    expect(sample?.qualification).toBe("unqualified")
    expect(sample?.outsideNoncriticalMilli).toBe(6000)
  }
})

test("Mac ticks and runnable count do not mistake stale load averages for executing cores", () => {
  const sample = Option.getOrThrow(measureSupply({ ...interval, platform: "darwin", runnable: 2, after: { idle: 870, total: 1000, at: 1000 } }))
  expect(sample?.qualification).toBe("advisory")
  expect(sample?.outsideNoncriticalMilli).toBe(600)
  expect(sample && capacityOf(sample)).toBe(13_400)
  expect(sample.envelope.cpuMilli).toBe(14_000)
  const idle = Option.getOrThrow(measureSupply({ ...interval, platform: "darwin", runnable: 0, after: { idle: 900, total: 1000, at: 1000 } }))
  expect(idle.outsideNoncriticalMilli).toBe(0)
  expect(capacityOf(idle)).toBe(14_000)
})

test("unknown/reversed/stale counters do not become idle capacity; runnable pressure is independent", () => {
  expect(measureSupply({ ...interval, after: { ...interval.after, total: 199 } })).toEqual(Option.none())
  expect(measureSupply({ ...interval, after: { ...interval.after, at: 10_000 } })).toEqual(Option.none())
  expect(measureSupply({ ...interval, protectedLowerBoundMilli: Number.NaN })).toEqual(Option.none())
  const wide = Option.getOrThrow(measureSupply({ ...interval, hostCpuMilli: 32_000, effectiveCpuMilli: 32_000, runnable: 25 }))
  expect(wide && runnableLimit(wide)).toBe(24)
})
