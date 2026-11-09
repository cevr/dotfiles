// Our server plugins start without holding a location up. The fork from source
// runs as a scratch service with every server plugin `bun run daily` configures
// (scripts/perf/plugin-start.ts, which reads the host's own spans over OTLP), and
// three locations open together, as TUIs reconnect after a restart. A plugin's
// setup (`Plugin.load`) runs before the location's other plugins and before any
// prompt, so it does its slow work (ledger reads, network, scans, polls) in a
// fiber of its own: each stays under SETUP_MS in every location, measured at
// 0-22 ms on the Mac (pool the largest). Every location answers a plugin RPC
// within LIVE_MS of its first request (measured 0.8-1.3 s).
import { describe, expect, test } from "bun:test"
import { forkLaunch } from "../testbeds/gamut/gamut.ts"
import { measure, rows } from "../scripts/perf/plugin-start.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/plugin-start.test.ts: skipped. Set OPENCODE_DEV to the fork.")

const SETUP_MS = 150
const LIVE_MS = 20_000

describe.skipIf(!fork)("our server plugins at a service's start", () => {
  test(
    "each plugin's setup is quick in every location, and every location's plugins answer",
    async () => {
      const result = await measure({ launch: forkLaunch(fork ?? "", process.execPath), locations: 3 })
      for (const location of result.locations) expect(location.live - location.asked).toBeLessThan(LIVE_MS)
      const table = rows(result)
      expect(table.map((row) => row.plugin)).toContain("memory")
      expect(table.filter((row) => row.setup.length !== 3).map((row) => `${row.plugin}: set up in ${row.setup.length} locations`)).toEqual([])
      expect(table.filter((row) => Math.max(...row.setup) >= SETUP_MS).map((row) => `${row.plugin}: ${row.setup.map((ms) => ms.toFixed(0)).join(", ")} ms`)).toEqual([])
    },
    120_000,
  )
})
