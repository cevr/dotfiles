// One racer for scripts/post-land.test.ts's lock tests: a real process that waits at a barrier, then
// asks the upstream lock for the merge. The request names the state, racer and count.
// The winner records `start`, holds the lock until every other racer has
// recorded `tried` (it got nothing), then records `end`; a crashing racer exits while holding it,
// never releasing it by hand. Events are JSON lines in `<state>/events`.
import { appendFileSync, openSync } from "node:fs"
import { join } from "node:path"
import { Schema } from "effect"
import { readScratchFileSync as readFileSync, scratchExistsSync as existsSync, scratchInput } from "../tests/read-path.ts"
import { upstreamLockFile, withOpenedUpstreamLock } from "./upstream.ts"

const request = Schema.fromJsonString(Schema.Struct({ state: Schema.String, role: Schema.String, racers: Schema.Number, crash: Schema.Boolean }))
const { state, role, racers, crash } = Schema.decodeUnknownSync(request)(readFileSync(process.argv[2] || "", "utf8"))
const events = join(state, "events")
const record = (phase: string) => appendFileSync(events, `${JSON.stringify({ role, phase, at: Date.now() })}\n`)
const count = (phase: string) => (existsSync(events) ? readFileSync(events, "utf8").split("\n").filter((line) => line.includes(`"phase":"${phase}"`)).length : 0)

const deadline = Date.now() + 10_000
while (!existsSync(join(state, "go")) && Date.now() < deadline) await Bun.sleep(2)

const merged = await withOpenedUpstreamLock(() => openSync(scratchInput(upstreamLockFile(state)), "a+"), async () => {
  record("start")
  if (crash) process.exit(3)
  while (count("tried") < racers - 1 && Date.now() < deadline) await Bun.sleep(5)
  record("end")
  return "merged"
})
if (merged === undefined) record("tried")
