// The units' logs on disk, written by this checkout's orchestrate log.ts, in a
// scratch checkout: the laws, and a `~/` path.
import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect, type Scope } from "effect"
import { unitLogsLaws } from "../laws.ts"
import { UnitLogs } from "../service.ts"
import * as FileUnitLogs from "./unit-logs.ts"

/** The orchestrate skill's log.ts in this checkout. */
const LOG_SCRIPT = join(import.meta.dir, "../../../../skills/orchestrate/scripts/log.ts")

const scratch = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "orchestrate-unit-logs-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
)

/** A log's moves without their times. */
const movesIn = (dir: string) =>
  Effect.sync(() => {
    const file = join(dir, "log.md")
    if (!existsSync(file)) return []
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => line.replace(/^\S+Z /, ""))
  })

unitLogsLaws(
  "the log.ts UnitLogs",
  Effect.map(scratch, (checkout) => ({
    layer: FileUnitLogs.layer(LOG_SCRIPT),
    checkout,
    make: (path: string) =>
      Effect.sync(() => {
        mkdirSync(join(checkout, path), { recursive: true })
        return join(checkout, path)
      }),
    touch: (path: string) =>
      Effect.sync(() => {
        mkdirSync(dirname(join(checkout, path)), { recursive: true })
        writeFileSync(join(checkout, path), "")
      }),
    moves: movesIn,
  })),
)

/** A test's body, run in a scope of its own. */
const scoped = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(body))

test("a path under `~/` is found in the home given", () =>
  scoped(
    Effect.gen(function* () {
      const home = yield* scratch
      mkdirSync(join(home, "work/tmp/orchestrate/web/auth"), { recursive: true })
      writeFileSync(join(home, "work/tmp/orchestrate/web/plan.md"), "")
      const found = yield* Effect.provide(
        UnitLogs.use((logs) => logs.find({ unit: "auth", named: ["~/work/tmp/orchestrate/web/auth"] })),
        FileUnitLogs.layer(LOG_SCRIPT, { home }),
      )
      expect(found).toBe(join(home, "work/tmp/orchestrate/web/auth"))
    }),
  ))

/** A unit dir in `run` whose log.md holds `lines` (each `<from> → <to> r<N>`, timed). */
const unitWith = (run: string, unit: string, lines: ReadonlyArray<string>) => {
  mkdirSync(join(run, unit), { recursive: true })
  writeFileSync(join(run, unit, "log.md"), lines.map((line) => `2026-11-12T10:00Z ${line}\n`).join(""))
  return join(run, unit)
}

// orch-followups r2 M2: only a log's last line says its unit is dropped; the journal only says where to look.
test("a session's drops are the journal's dirs for it, once each, whose log.md's last line moves the unit to dropped, with that move's round", () =>
  scoped(
    Effect.gen(function* () {
      const run = yield* scratch
      const journal = join(run, "drops.jsonl")
      const drops = (session: string) => Effect.provide(UnitLogs.use((logs) => logs.drops(session)), FileUnitLogs.layer(LOG_SCRIPT, { journal }))
      expect(yield* drops("root")).toEqual([])
      const dropped = unitWith(run, "dropped", ["new → decide r1", "decide → dropped r3 superseded"])
      const revived = unitWith(run, "revived", ["new → decide r1", "decide → dropped r1 x", "dropped → implement r2 again"])
      const undone = unitWith(run, "undone", ["new → decide r1", "decide → dropped r1 x", "dropped → decide r1 undo"])
      const others = unitWith(run, "others", ["new → decide r1", "decide → dropped r1 x"])
      // As log.ts writes them; a line that does not read, and a dir with no log, are passed over.
      const entry = (session: string, dir: string) => `{"session":"${session}","dir":"${dir}","at":1}\n`
      writeFileSync(
        journal,
        [entry("root", dropped), "not json\n", entry("root", revived), entry("root", undone), entry("other", others), entry("root", join(run, "gone")), entry("root", `${dropped}/`)].join(""),
      )
      expect(yield* drops("root")).toEqual([{ unit: "dropped", round: 3 }])
      expect(yield* drops("other")).toEqual([{ unit: "others", round: 1 }])
      expect(yield* drops("nobody")).toEqual([])
    }),
  ))
