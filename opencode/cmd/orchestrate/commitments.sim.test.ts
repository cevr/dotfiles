// The commitment record through the plugin on the simulated host (orch-tools-world.ts): the real orchestrate plugin
// with its `commitments` and `follow_up` tools, on the SQLite record in a scratch file (`options.record`), so a restart
// reopens the same file. Every answer is read from the record at the call; the plugin keeps nothing of a run.
import { Effect } from "effect"
import { FOLLOW_UP, PARENT_REFUSAL } from "@dotfiles/opencode-orchestrate/commitments-tool"
import * as Seed from "../../sim/seed.ts"
import { scratch } from "../../tests/scratch.ts"
import { boot, ORCHESTRATE, type Run, WORK } from "./orch-tools-world.ts"

const { seeded } = Seed.runner("cmd/orchestrate/commitments.sim.test.ts")

const COMMITMENTS = "commitments"

/** `body` on a world whose record is a fresh scratch file, removed after. */
const onRecord = <A, E, R>(seed: number, body: (run: Run) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => scratch("commitments-sim-")),
    (dir) => Effect.flatMap(boot(seed, true, { record: `${dir.path}/record.db` }), body),
    (dir) => Effect.sync(() => dir[Symbol.dispose]()),
  )

/** The record's section of a status or land answer: its lines from `Commitments:` on. */
const sectionIn = (text: string): ReadonlyArray<string> => {
  const lines = text.split("\n")
  return lines.slice(Math.max(0, lines.findIndex((line) => line.startsWith("Commitments:"))))
}

const three = { action: "add", source_kind: "owner-answer", source_ref: "ses_owner:q1", parts: ["p1", "p2", "p3"].map((id) => ({ id, title: `part ${id}` })) }

seeded("commitments add with three parts, then orchestrate status lists the three unowned", ({ seed, expect }) =>
  onRecord(seed, (run) =>
    Effect.gen(function* () {
      const root = yield* run.world.session(WORK)
      const added = yield* run.probe(root, COMMITMENTS, three)
      expect([added.error, added.text]).toEqual([false, "commitments: added p1, p2, p3. Unowned until assigned: p1, p2, p3."])
      const status = yield* run.probe(root, ORCHESTRATE, { action: "status" })
      expect(sectionIn(status.text)).toEqual([
        'Commitments: 3 open (3 unowned, 0 orphaned, 0 overdue, 0 due, 0 held). Only held is quiet: own (commitments({ action: "assign" })), order or decide each listed one.',
        "- unowned: p1, p2, p3",
      ])
    }),
  ),
)

seeded("orchestrate lane makes the unit's commitment, and its answer lists the owner's open ones", ({ seed, expect }) =>
  onRecord(seed, (run) =>
    Effect.gen(function* () {
      const root = yield* run.world.session(WORK)
      yield* run.probe(root, COMMITMENTS, three)
      yield* run.probe(root, COMMITMENTS, { action: "assign", id: "p1", owner_lane: "a" })
      const laned = yield* run.probe(root, ORCHESTRATE, { action: "lane", unit: "a" })
      expect(laned.text.split("\n")).toContain('Commitments of a: a, p1. Its hand-back claims what it lands; commitments({ action: "list", owner: "a" }) lists them.')
      const listed = yield* run.probe(root, COMMITMENTS, { action: "list", owner: "a" })
      expect(listed.text.split("\n").map((line) => line.split(" ").slice(0, 2).join(" "))).toEqual(["commitments: 2", "a [held]", "p1 [due]"])
    }),
  ),
)

seeded("a subagent's commitments call is refused, and its follow_up makes one unowned commitment", ({ seed, expect }) =>
  onRecord(seed, (run) =>
    Effect.gen(function* () {
      const root = yield* run.world.session(WORK)
      const child = yield* run.world.session(WORK, { parentID: root })
      const refused = yield* run.probe(child, COMMITMENTS, three)
      expect([refused.error, refused.text]).toEqual([true, expect.stringContaining(PARENT_REFUSAL)])
      const filed = yield* run.probe(child, FOLLOW_UP, { id: "f1", title: "a missing test", suggest_owner: "a" })
      expect([filed.error, filed.text]).toEqual([false, "follow_up: filed f1, unowned; the root owns or decides it."])
      const status = yield* run.probe(root, ORCHESTRATE, { action: "status" })
      expect(sectionIn(status.text)).toContain("- unowned: f1")
      expect(sectionIn(status.text)).not.toContain("- unowned: p1, p2, p3")
    }),
  ),
)

seeded("after a restart, status answers the same: the record is the file, not the plugin's memory", ({ seed, expect }) =>
  onRecord(seed, (run) =>
    Effect.gen(function* () {
      const root = yield* run.world.session(WORK)
      yield* run.probe(root, COMMITMENTS, three)
      yield* run.probe(root, COMMITMENTS, { action: "assign", id: "p2", owner_lane: "root", review_by: "2026-11-30T00:00:00.000Z" })
      const before = sectionIn((yield* run.probe(root, ORCHESTRATE, { action: "status" })).text)
      yield* run.world.restart
      const next = yield* run.world.session(WORK)
      const after = sectionIn((yield* run.probe(next, ORCHESTRATE, { action: "status" })).text)
      expect(after).toEqual(before)
      expect(before).toContain("- unowned: p1, p3")
    }),
  ),
)
