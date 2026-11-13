// Run by scripts/accept.test.ts as its own `bun test`, never by the gate: a
// simulated TUI file's runner on its first seed only (`count` 1), and a body
// that fails on any seed past the fixed ones. The gate's seeds pass (seed 1
// runs, 2 to 20 are past the count); a swarm's seeds (past 20) must reach the
// body, so a swarm of this file fails.
import { Effect } from "effect"
import * as App from "../app.ts"

const { seeded } = App.runner("sim-tui/fixtures/swarm-count.fixture.tsx", 1)

seeded("a seed past the fixed ones reaches the body", ({ seed, expect }) => Effect.sync(() => expect(seed).toBeLessThanOrEqual(20)))
