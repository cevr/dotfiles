// Our server plugins start without holding a location up. The fork from source
// runs as a scratch service with every server plugin `bun run daily` configures
// (scripts/perf/plugin-start.ts, which reads the host's own spans over OTLP), and
// three locations open together, as TUIs reconnect after a restart: every location
// answers a plugin RPC within LIVE_MS of its first request (measured 0.8-1.3 s).
//
// A plugin's setup (`Plugin.load`) runs before the location's other plugins and
// before any prompt, so it does its slow work (ledger reads, network, scans, polls)
// in a fiber of its own. Its span is wall time on one JS thread: in three locations
// opened together, a setup that awaits once spans whatever the other two locations
// run meanwhile, so on a loaded host the pool's ~20 ms setup read 180-390 ms with
// nothing slow in it. Each setup is timed where it is its own: two more locations,
// opened one at a time once the others are set up. The faster of the two stays
// under SETUP_MS (measured 0-15 ms at load 10-25), so one scheduling stall is not a
// slow setup, while slow work in a setup is slow in both.
import { describe, expect, test } from "bun:test"
import { forkLaunch } from "../testbeds/gamut/gamut.ts"
import { measure, rows } from "../scripts/perf/plugin-start.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/plugin-start.test.ts: skipped. Set OPENCODE_DEV to the fork.")

const SETUP_MS = 150
const LIVE_MS = 20_000

describe.skipIf(!fork)("our server plugins at a service's start", () => {
  test(
    "each plugin's setup is quick in a location of its own, and every location's plugins answer when three open together",
    async () => {
      const result = await measure({ launch: forkLaunch(fork ?? "", process.execPath), locations: 3, alone: 2 })
      for (const location of result.locations) expect(location.live - location.asked).toBeLessThan(LIVE_MS)
      const table = rows(result)
      expect(table.map((row) => row.plugin)).toContain("memory")
      expect(table.filter((row) => row.setup.length !== 3 || row.alone.length !== 2).map((row) => `${row.plugin}: set up in ${row.setup.length} + ${row.alone.length} locations`)).toEqual([])
      expect(table.filter((row) => Math.min(...row.alone) >= SETUP_MS).map((row) => `${row.plugin}: ${row.alone.map((ms) => ms.toFixed(0)).join(", ")} ms alone (${row.setup.map((ms) => ms.toFixed(0)).join(", ")} ms together)`)).toEqual([])
    },
    120_000,
  )
})
