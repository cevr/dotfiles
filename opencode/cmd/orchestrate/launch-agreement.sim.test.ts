// @reads all
// @reads-reason computed read at mods/guard/filesystem/repo-roots.ts: return yield* Effect.tryPromise({ try: () => stat(join(path, ".git")), catch: (cause) => cause
import { Plugin } from "@opencode/plugin/effect"
import { POOL_STATUS } from "@dotfiles/opencode-pool/status"
import { Effect, Schema } from "effect"
import * as Plugins from "../../sim/plugins.ts"
import * as World from "../../sim/world.ts"
import { simulationRunner } from "../../sim/seed.ts"

const { seeded } = simulationRunner("cmd/orchestrate/launch-agreement.sim.test.ts")
const WORK = "/scratch/launch-agreement"
const PIN = "2026-11-04T15:00:00Z"
const Binding = Schema.Struct({ launchID: Schema.String, sessionID: Schema.String })
const API = { ...POOL_STATUS, methods: {
  pace: POOL_STATUS.methods.pace, started: POOL_STATUS.methods.started,
  reserveLaunch: POOL_STATUS.methods.reserveLaunch, bindLaunch: POOL_STATUS.methods.bindLaunch,
} }

seeded("a stale open quote cannot start a worker without agreement; the latch negotiates again before opening", ({ seed, expect }) => Effect.gen(function* () {
  let room = false
  let reservations = 0
  let legacyStarts = 0
  const bindings: Array<typeof Binding.Type> = []
  const work: Array<string> = []
  const world = World.make({ seed, start: Date.parse(PIN), script: (request) => {
    if (request.kind === "title") return World.say("Launch agreement")
    if (request.text.includes("WORKER BRIEF") && !request.text.includes("OWNER ASK")) { work.push(request.sessionID); return World.say("WORKER ANSWER") }
    if (request.text.includes("WORKER ANSWER")) return World.say("OWNER HEARD")
    if (!request.text.includes("launch-worker")) return World.call("launch-worker", "subagent", { agent: "worker", description: "Check the agreement", prompt: "WORKER BRIEF" })
    return World.say("Waiting for the worker")
  } })
  const pool = Plugin.define({ id: "fixture.launch-pool", effect: (ctx) => ctx.rpc.register(API, {
    pace: () => Effect.succeed({ ok: true, measured: true, reason: "earlier quote had room" }),
    started: () => Effect.sync(() => { legacyStarts++; return {} }),
    reserveLaunch: () => Effect.sync(() => {
      reservations++
      return { ok: room, measured: true, reason: "fleet agreement", retryAt: world.now() + 6_000 }
    }),
    bindLaunch: (input) => Effect.sync(() => { bindings.push(Schema.decodeUnknownSync(Binding)(input)); return {} }),
  }).pipe(Effect.asVoid, Effect.orDie) })
  yield* world.load(Plugins.orchestrate(), { directory: WORK, options: { now: PIN } })
  yield* world.load(Plugins.wake(world), { directory: WORK, options: { backstop: "off" } })
  yield* world.load(pool, { directory: WORK })
  const parent = yield* world.session(WORK)
  yield* world.prompt(parent, "OWNER ASK")
  yield* world.until(() => reservations > 0, 10_000)
  expect(reservations).toBe(1)
  expect(work).toEqual([])
  room = true
  yield* world.until(() => world.messages(parent).some((message) => message.type === "assistant" && message.text === "OWNER HEARD"), 30_000)
  expect(reservations).toBe(2)
  expect(work).toHaveLength(1)
  expect(bindings.map((binding) => binding.sessionID)).toEqual(work)
  expect(legacyStarts).toBe(0)
}))
