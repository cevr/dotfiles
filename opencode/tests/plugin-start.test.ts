// Our server plugins start without holding a location up: a scratch fork service with
// daily's server plugins (scripts/perf/plugin-start.ts, from its own OTLP spans) opens
// three locations together, as TUIs reconnect after a restart, and each answers a
// plugin RPC on at most LIVE_CPU_MS of the service's CPU. CPU, not wall time: on an idle
// Mac a location goes live in ~1.3 s on ~1.5 s of CPU, but in the batch's acceptance
// (12 test files at once, load 12-58) the same plugins took 39.6 s of wall time, a host
// starved, not a plugin slow. A location that never answers fails `measure`'s 90 s
// deadline. A setup (`Plugin.load`) does its slow work in a fiber of
// its own. Its span is wall time on one JS thread, so in locations opened together it
// spans the others' work (pool's ~20 ms read 180-390 ms on a loaded host): each setup
// is timed in two more locations opened one at a time, and the faster stays under
// SETUP_MS (measured 0-15 ms), so one scheduling stall is no slow setup.
import { describe, expect, test } from "bun:test"
import { forkLaunch } from "../testbeds/gamut/gamut.ts"
import { measure, rows } from "../scripts/perf/plugin-start.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/plugin-start.test.ts: skipped. Set OPENCODE_DEV to the fork.")

const SETUP_MS = 150
/** Measured 1.4-1.7 s of service CPU per location opened together, 0.2 s alone. */
const LIVE_CPU_MS = 10_000

describe.skipIf(!fork)("our server plugins at a service's start", () => {
  test(
    "each plugin's setup is quick in a location of its own, and every location's plugins answer when three open together",
    async () => {
      const result = await measure({ launch: forkLaunch(fork ?? "", process.execPath), locations: 3, alone: 2 })
      const name = (location: (typeof result.locations)[number]) => location.directory.split("/").at(-1)
      // Every location answered (else `measure` throws), each on a bounded amount of the service's CPU.
      expect(result.locations.filter((location) => !(location.cpu < LIVE_CPU_MS)).map((location) => `${name(location)}: ${location.cpu.toFixed(0)} ms of CPU, ${(location.live - location.asked).toFixed(0)} ms`)).toEqual([])
      const table = rows(result)
      expect(table.map((row) => row.plugin)).toContain("memory")
      expect(table.filter((row) => row.setup.length !== 3 || row.alone.length !== 2).map((row) => `${row.plugin}: set up in ${row.setup.length} + ${row.alone.length} locations`)).toEqual([])
      expect(table.filter((row) => Math.min(...row.alone) >= SETUP_MS).map((row) => `${row.plugin}: ${row.alone.map((ms) => ms.toFixed(0)).join(", ")} ms alone (${row.setup.map((ms) => ms.toFixed(0)).join(", ")} ms together)`)).toEqual([])
    },
    120_000,
  )
})
