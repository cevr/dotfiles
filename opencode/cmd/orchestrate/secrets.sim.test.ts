// The one output boundary on the plugin's `commitments` tool (secrets-world.ts): the first eight call kinds (add to the
// dependency defer), each way into them carrying a secret of any kind at any place. No answer, log line or record byte
// holds a fragment of it.
import { simulationRunner } from "../../sim/seed.ts"
import { Effect } from "effect"
import { COMMITMENT_CALLS } from "../../sim/canary.ts"
import { placedWorld } from "./secrets-world.ts"

const { seeded } = simulationRunner("cmd/orchestrate/secrets.sim.test.ts")

seeded("a secret of any kind at any place in any key or value of add to defer leaves no fragment in an answer, a log line or the record", ({ seed, expect }) =>
  Effect.map(placedWorld(seed, COMMITMENT_CALLS.slice(0, 8), []), (placed) =>
    expect(placed).toEqual({ calls: 60, unanswered: 0, leaks: [], written: true }),
  ),
)
