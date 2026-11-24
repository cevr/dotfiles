// The plugin's tools on a scratch SQLite record (secrets-world.ts), given a token-shaped canary in every key and value
// of the rest of the `commitments` call kinds (the measured defer to import) and of every `follow_up` call. No refusal
// repeats what the caller wrote: the canary is in no tool result, no log line and no byte of the record's file.
import { simulationRunner } from "../../sim/seed.ts"
import { Effect } from "effect"
import { COMMITMENT_CALLS, FOLLOW_UP_CALLS } from "../../sim/canary.ts"
import { canariedWorld } from "./secrets-world.ts"

const { seeded } = simulationRunner("cmd/orchestrate/canary-follow-up.sim.test.ts")

seeded("a token-shaped canary in any key or value of the other calls and follow_up is repeated by no answer, log line or record row", ({ seed, expect }) =>
  Effect.map(canariedWorld(seed, COMMITMENT_CALLS.slice(8), FOLLOW_UP_CALLS), (canaried) =>
    expect(canaried).toEqual({ calls: 55, unanswered: 0, answers: [], logs: [], record: false, written: true }),
  ),
)
