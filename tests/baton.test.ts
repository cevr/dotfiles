import { Effect, FileSystem, Option } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "effect-bun-test"
import { Baton } from "../src/Baton.js"
import { World, world } from "./helpers/world.js"

const ORCH = "w:p0"
const opening = {
  unit: "src",
  verifier: false,
  maxFailures: 3,
  implModel: "opus",
  implEffort: "medium",
  revModel: "gpt-6.1-sol",
  revEffort: "high",
}

/** A run `hymn` with one open track `src`; returns its unit folder. */
const openTrack = Effect.gen(function* () {
  const baton = yield* Baton
  const w = yield* World
  const fs = yield* FileSystem.FileSystem
  yield* w.at(ORCH)
  const run = yield* baton.start("hymn")
  const unit = `${run.root}/src`
  yield* fs.makeDirectory(unit, { recursive: true })
  yield* fs.writeFileString(`${unit}/spec.md`, "# src\n")
  yield* baton.open({ ...opening, cwd: w.dir })
  return unit
})

const write = Effect.fn("write")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.writeFileString(file, "Verdict\n")
})

describe("a track", () => {
  it.scoped("relays the baton from implementor to reviewer to orchestrator", () =>
    Effect.gen(function* () {
      const baton = yield* Baton
      const w = yield* World
      const unit = yield* openTrack
      const kickoff = yield* w.prompts
      expect(kickoff).toEqual([
        {
          agent: "hymn-src-impl",
          text: `[hymn-src] you hold the baton: build round 1 from ${unit}/spec.md`,
        },
      ])

      yield* w.at("w:t1p0")
      yield* write(`${unit}/round-1-request.md`)
      const reviewing = yield* baton.pass(`${unit}/round-1-request.md`, Option.none())
      expect(reviewing.step).toMatchObject({ kind: "review", holder: "rev" })

      yield* w.at("w:t1p1")
      yield* write(`${unit}/round-1-findings.md`)
      yield* baton.pass(`${unit}/round-1-findings.md`, Option.some("accepted"))

      const sent = yield* w.prompts
      expect(sent.map((prompt) => prompt.agent)).toEqual([
        "hymn-src-impl",
        "hymn-src-rev",
        "hymn-orch",
      ])
      expect(sent[2]?.text).toBe(`[hymn-src] accepted at round 1: ${unit}/round-1-findings.md`)
    }).pipe(Effect.provide(world)),
  )

  it.scoped("refuses a pass out of turn, a missing file, and a stranger", () =>
    Effect.gen(function* () {
      const baton = yield* Baton
      const w = yield* World
      const unit = yield* openTrack
      yield* w.at("w:t1p1")
      yield* write(`${unit}/early.md`)
      const early = yield* Effect.flip(baton.pass(`${unit}/early.md`, Option.some("accepted")))
      expect(early.message).toContain("the baton is with the impl")
      yield* w.at("w:t1p0")
      const missing = yield* Effect.flip(baton.pass(`${unit}/nope.md`, Option.none()))
      expect(missing.message).toContain("does not exist")
      yield* w.at("w:p9")
      const stranger = yield* Effect.flip(baton.pass(`${unit}/early.md`, Option.none()))
      expect(stranger.message).toContain("holds no seat")
    }).pipe(Effect.provide(world)),
  )

  it.scoped(
    "tells the orchestrator when a message cannot land, and sends it again on request",
    () =>
      Effect.gen(function* () {
        const baton = yield* Baton
        const w = yield* World
        yield* w.blocked(["hymn-src-impl"])
        yield* openTrack
        const told = yield* w.prompts
        expect(told).toHaveLength(1)
        expect(told[0]?.agent).toBe("hymn-orch")
        expect(told[0]?.text).toContain("agent_blocked")
        yield* w.blocked([])
        yield* baton.redeliver(Number(/#(\d+)/.exec(told[0]?.text ?? "")?.[1]))
        expect((yield* w.prompts).map((prompt) => prompt.agent)).toEqual([
          "hymn-orch",
          "hymn-src-impl",
        ])
      }).pipe(Effect.provide(world)),
  )

  it.scoped("the watchdog reports a quiet track once, from the log alone", () =>
    Effect.gen(function* () {
      const baton = yield* Baton
      const w = yield* World
      yield* openTrack
      yield* w.statuses({ "hymn-orch": "idle", "hymn-src-impl": "idle", "hymn-src-rev": "idle" })
      yield* baton.tick
      yield* TestClock.adjust("9 minutes")
      yield* baton.tick
      expect((yield* w.prompts).filter((prompt) => prompt.agent === "hymn-orch")).toEqual([])
      yield* TestClock.adjust("2 minutes")
      yield* baton.tick
      yield* TestClock.adjust("20 minutes")
      yield* baton.tick
      const alerts = (yield* w.prompts).filter((prompt) => prompt.agent === "hymn-orch")
      expect(alerts).toHaveLength(1)
      expect(alerts[0]?.text).toContain("[watchdog] hymn-src: every agent has been idle")
    }).pipe(Effect.provide(world)),
  )

  it.scoped("closing a track closes its tab and frees its panes", () =>
    Effect.gen(function* () {
      const baton = yield* Baton
      const w = yield* World
      yield* openTrack
      yield* baton.close("src", Option.some("abc123"))
      expect(yield* w.closedTabs).toEqual(["w:t1"])
      yield* w.at("w:t1p0")
      expect(Option.isNone(yield* baton.whoami)).toBe(true)
    }).pipe(Effect.provide(world)),
  )
})
