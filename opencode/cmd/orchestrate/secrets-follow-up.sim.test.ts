// @reads all
// @reads-reason computed read at sim/canary.ts: fs.readFile(path).pipe(
// The one output boundary on the plugin's tools (secrets-world.ts): the rest of the `commitments` call kinds (the
// measured defer to import) and every `follow_up` call, each way into them carrying a secret of any kind at any place.
// No answer, log line or record byte holds a fragment of it.
import * as Seed from "../../sim/seed.ts"
import { Effect } from "effect"
import { COMMITMENT_CALLS, FOLLOW_UP_CALLS } from "../../sim/canary.ts"
import { placedWorld } from "./secrets-world.ts"

const { seeded } = Seed.runner("cmd/orchestrate/secrets-follow-up.sim.test.ts")

seeded("a secret of any kind at any place in any key or value of the other calls and follow_up leaves no fragment in an answer, a log line or the record", ({ seed, expect }) =>
  Effect.map(placedWorld(seed, COMMITMENT_CALLS.slice(8), FOLLOW_UP_CALLS), (placed) =>
    expect(placed).toEqual({ calls: 55, unanswered: 0, leaks: [], written: true }),
  ),
)
