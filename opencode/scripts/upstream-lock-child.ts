// One racer for scripts/post-land.test.ts's lock tests: a real process that waits at a barrier, then
// asks `withUpstreamLock` for the merge. LOCK_STATE is the state directory, LOCK_ROLE its name,
// LOCK_RACERS how many race. The winner records `start`, holds the lock until every other racer has
// recorded `tried` (it got nothing), then records `end`; with LOCK_CRASH it exits while holding it,
// never releasing it by hand. Events are JSON lines in `<state>/events`.
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { withUpstreamLock } from "./upstream.ts"

const state = process.env.LOCK_STATE ?? ""
const role = process.env.LOCK_ROLE ?? ""
const racers = Number(process.env.LOCK_RACERS ?? "1")
const events = join(state, "events")
const record = (phase: string) => appendFileSync(events, `${JSON.stringify({ role, phase, at: Date.now() })}\n`)
const count = (phase: string) => (existsSync(events) ? readFileSync(events, "utf8").split("\n").filter((line) => line.includes(`"phase":"${phase}"`)).length : 0)

const deadline = Date.now() + 10_000
while (!existsSync(join(state, "go")) && Date.now() < deadline) await Bun.sleep(2)

const merged = await withUpstreamLock(state, async () => {
  record("start")
  if (process.env.LOCK_CRASH === "1") process.exit(3)
  while (count("tried") < racers - 1 && Date.now() < deadline) await Bun.sleep(5)
  record("end")
  return "merged"
})
if (merged === undefined) record("tried")
