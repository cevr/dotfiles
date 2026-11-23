// @reads all
// @reads-reason subprocess reads at mods/guard/process/reservations.test.ts: const dir = spawnSync(["realpath", held.path]).stdout.toString().trim()
// Reservations over a stand-in `work` in a scratch directory this test makes
// and removes: it prints the records `work --json list` would, one of each
// state, two creating (one whose folder exists, one whose does not); then
// work's NoBase, a failure, an answer that does not read, and no `work` at all.
import { spawnSync, write } from "bun"
import { Effect } from "effect"
import { scratch } from "../../../tests/scratch.ts"
import { type ReservationBench, reservationsLaws } from "../laws.ts"
import * as WorkReservations from "./reservations.ts"

/** What the stand-in `work` prints and exits with, given the scratch directory; none: no `work` on PATH. */
interface StandIn {
  readonly out: (dir: string) => string
  readonly code: number
  readonly present: boolean
}

/** One record as `work --json list` prints it. */
const record = (dir: string, name: string, state: string) => `{"name":"${name}","path":"${dir}/ws/${name}","state":{"_tag":"${state}"}}`

const bench = (standIn: StandIn, expected: (dir: string) => ReservationBench["expected"]) => () =>
  Effect.gen(function* () {
    const held = yield* Effect.acquireRelease(
      Effect.sync(() => scratch("guard-reservations-")),
      (dir) => Effect.sync(() => dir[Symbol.dispose]()),
    )
    const dir = spawnSync(["realpath", held.path]).stdout.toString().trim()
    yield* Effect.promise(() => write(`${dir}/ws/made/.keep`, "", { createPath: true }))
    yield* Effect.promise(() => write(`${dir}/stand-in/out.json`, standIn.out(dir), { createPath: true }))
    const work = `${dir}/bin/work`
    yield* Effect.promise(() => write(work, `#!/bin/sh\n[ "$1 $2" = "--json list" ] || exit 2\n/bin/cat '${dir}/stand-in/out.json'\nexit ${standIn.code}\n`, { createPath: true }))
    spawnSync(["chmod", "755", work])
    const named = [work, "work-on-no-path"][Number(!standIn.present)] ?? work
    return { layer: WorkReservations.layer({ work: named, env: { PATH: `${dir}/none` } }), directory: `${dir}/ws`, expected: expected(dir) }
  })

const records = (dir: string) => `[${[record(dir, "made", "Creating"), record(dir, "gone", "Creating"), record(dir, "active", "Active"), record(dir, "trashed", "Trashed")].join(",")}]`

reservationsLaws(
  "the work Reservations over a registry with one of each state",
  bench({ out: records, code: 0, present: true }, (dir) => [{ name: "made", path: `${dir}/ws/made` }]),
)
reservationsLaws(
  "the work Reservations in no base",
  bench({ out: () => '{"_tag":"NoBase","path":"/x"}', code: 1, present: true }, () => []),
)
reservationsLaws(
  "the work Reservations with no work to run",
  bench({ out: records, code: 0, present: false }, () => []),
)
reservationsLaws(
  "the work Reservations when work fails",
  bench({ out: () => '{"_tag":"Locked"}', code: 1, present: true }, () => "unreadable"),
)
reservationsLaws(
  "the work Reservations when its answer does not read",
  bench({ out: () => "not json", code: 0, present: true }, () => "unreadable"),
)
