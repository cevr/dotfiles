// A land's structured answer (../model.ts `Answer.metadata`) over Rifts in memory: a pushed land names the commit it
// pushed and each workspace with the head it merged (what the orchestrate plugin records as a land event, never
// parsing the text); a land that did not push names neither, and its other fields stay as they were.
import { expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import * as Seed from "../../../sim/seed.ts"
import * as Model from "../model.ts"
import * as MemoryDebts from "./debts.ts"
import * as MemoryLanding from "./landing.ts"
import * as MemoryNotices from "./notices.ts"
import * as MemoryRifts from "./rifts.ts"
import * as MemorySessionDirectories from "./session-directories.ts"
import * as MemoryWorkbox from "./workbox.ts"

const SOURCE = "/code/app"
const FEAT = "/code/.work/app/feat-x"
const OTHER = "/code/.work/app/feat-y"
const INTEGRATE = "/code/.work/app/integrate"

/** The land of feat-x and feat-y (feat-y at its own head) by the tool, in a world whose land pushes or does not; its metadata. */
const landed = (push: boolean) => {
  const rifts = MemoryRifts.world([SOURCE], [MemoryRifts.clean(FEAT, "feat/x"), { ...MemoryRifts.clean(OTHER, "feat/y"), head: "def5678" }])
  const landing = MemoryLanding.world({ [SOURCE]: MemoryLanding.config("main", "bun run gate", void 0, { push }) })
  const layer = Model.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        MemoryRifts.layer(rifts),
        MemorySessionDirectories.layer({ ses_1: "/code/app/src" }),
        MemoryLanding.layer(landing),
        MemoryNotices.layer([]),
        MemoryWorkbox.layer(false, []),
        MemoryDebts.layer(MemoryDebts.world()),
      ),
    ),
  )
  return Effect.scoped(
    Effect.gen(function* () {
      const tool = yield* Model.RiftTool
      const answer = yield* tool.run("ses_1", { action: "land", rifts: ["feat-x", "feat-y"] })
      return answer.metadata
    }).pipe(Effect.provide(layer)),
  )
}

Seed.effect("a pushed land's metadata names the pushed commit and each workspace's merged head, beside the fields it had",
  Effect.gen(function* () {
    const metadata = yield* landed(true)
    expect(metadata).toEqual({
      action: "land",
      source: SOURCE,
      path: INTEGRATE,
      rifts: [FEAT, OTHER],
      pushed: "abc1234",
      landed: [
        { path: FEAT, head: "abc1234" },
        { path: OTHER, head: "def5678" },
      ],
    })
  }),
)

Seed.effect("a land that did not push names no pushed commit and no landed workspace",
  Effect.gen(function* () {
    const metadata = yield* landed(false)
    expect([metadata.action, metadata.path, Option.isNone(Option.fromUndefinedOr(metadata.pushed)), Option.isNone(Option.fromUndefinedOr(metadata.landed))]).toEqual(["land", INTEGRATE, true, true])
  }),
)
