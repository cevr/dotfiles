// @reads all
// @reads-reason computed read at sim/canary.ts: fs.readFile(path).pipe(
// The plugin's `commitments` tool on a scratch SQLite record (secrets-world.ts), given a token-shaped canary in every
// key and value of the first eight call kinds (add to the dependency defer). No refusal repeats what the caller wrote:
// the canary is in no tool result, no log line and no byte of the record's file.
import { simulationRunner } from "../../sim/seed.ts"
import { Effect } from "effect"
import { COMMITMENT_CALLS } from "../../sim/canary.ts"
import { canariedWorld } from "./secrets-world.ts"

const { seeded } = simulationRunner("cmd/orchestrate/canary.sim.test.ts")

seeded("a token-shaped canary in any key or value of add to defer is repeated by no answer, log line or record row", ({ seed, expect }) =>
  Effect.map(canariedWorld(seed, COMMITMENT_CALLS.slice(0, 8), []), (canaried) =>
    expect(canaried).toEqual({ calls: 60, unanswered: 0, answers: [], logs: [], record: false, written: true }),
  ),
)
