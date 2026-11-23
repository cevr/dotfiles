// @reads all
// @reads-reason computed read at mods/guard/filesystem/repo-roots.ts: return yield* Effect.tryPromise({ try: () => stat(join(path, ".git")), catch: (cause) => cause
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
      expect(laned.text.split("\n")).toContain('Commitments of a: a, p1. A land of its lane (orchestrate land, the work tool\'s) claims the head it merges; commitments({ action: "list", owner: "a" }) lists them.')
      const listed = yield* run.probe(root, COMMITMENTS, { action: "list", owner: "a" })
      expect(listed.text.split("\n").map((line) => line.split(" ").slice(0, 2).join(" "))).toEqual(["commitments: 2", "a [held]", "p1 [due]"])
    }),
  ),
)

/** The lane's workspace an `orchestrate lane` answer names. */
const laneIn = (text: string): string => /^orchestrate: lane [^:]+: (\S+) ·/m.exec(text)?.[1] ?? ""

seeded("a land through the work tool and one through orchestrate land each claim the head they merged, and the commitment lands; a status claims nothing", ({ seed, expect }) =>
  onRecord(seed, (run) =>
    Effect.gen(function* () {
      const root = yield* run.world.session(WORK)
      const byWork = laneIn((yield* run.probe(root, ORCHESTRATE, { action: "lane", unit: "land-by-work", purpose: "lands by the work tool" })).text)
      yield* run.probe(root, ORCHESTRATE, { action: "lane", unit: "land-by-orchestrate", purpose: "lands by orchestrate land" })
      yield* run.probe(root, ORCHESTRATE, { action: "status" })
      const read = yield* run.probe(root, COMMITMENTS, { action: "list", all: true })
      expect(read.text.split("\n").map((line) => line.split(" ").slice(0, 2).join(" "))).toEqual(["commitments: 2", "land-by-orchestrate [held]", "land-by-work [held]"])
      const worked = yield* run.probe(root, "rift", { action: "land", rifts: [byWork] })
      expect(worked.text).toStartWith("Landed 1 workspace(s) as one push")
      const orchestrated = yield* run.probe(root, ORCHESTRATE, { action: "land", units: ["land-by-orchestrate"] })
      expect(orchestrated.error).toBe(false)
      const listed = yield* run.probe(root, COMMITMENTS, { action: "list", all: true })
      expect(listed.text.split("\n").map((line) => line.split(" ").slice(0, 2).join(" "))).toEqual(["commitments: 2", "land-by-orchestrate [landed]", "land-by-work [landed]"])
      const histories = yield* Effect.forEach(["land-by-work", "land-by-orchestrate"], (id) => run.probe(root, COMMITMENTS, { action: "history", id }))
      expect(histories.map((history) => history.text.split("\n").flatMap((line) => /^\d+ \S+ (claimed|landed) .*by plugin (\S+)/.exec(line)?.slice(1, 3).join(" by ") ?? []))).toEqual([
        ["claimed by work-land", "landed by work-land"],
        ["claimed by orchestrate-land", "landed by orchestrate-land"],
      ])
      // A status after the lands changes nothing: it claims nothing, and what landed stays landed.
      yield* run.probe(root, ORCHESTRATE, { action: "status" })
      const again = yield* run.probe(root, COMMITMENTS, { action: "list", all: true })
      expect(again.text).toBe(listed.text)
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
      yield* run.probe(root, COMMITMENTS, { action: "add", source_kind: "plan-part", source_ref: "plan.md:1", parts: [{ id: "base", title: "the base part" }] })
      const waits = { reason_class: "dependency", referent: { kind: "commitment", id: "base" } }
      const filed = yield* run.probe(child, FOLLOW_UP, { id: "f1", title: "a missing test", suggest_owner: "a", ...waits })
      expect([filed.error, filed.text]).toEqual([false, "follow_up: filed f1, unowned, waiting on dependency commitment/base; the root owns or decides it."])
      // A retry with the same key files nothing again; its key on another finding is refused.
      const keyed = { title: "a missing test", key: "finding-1", ...waits }
      const once = yield* run.probe(child, FOLLOW_UP, { id: "f2", ...keyed })
      const again = yield* run.probe(child, FOLLOW_UP, { id: "f2", ...keyed })
      const other = yield* run.probe(child, FOLLOW_UP, { id: "f3", ...keyed })
      const changed = yield* run.probe(child, FOLLOW_UP, { id: "f2", ...keyed, title: "another missing test" })
      const otherKey = yield* run.probe(child, FOLLOW_UP, { id: "f2", ...keyed, key: "finding-2" })
      expect([changed.error, changed.text.replace(/^Error: /, ""), otherKey.error, otherKey.text.replace(/^Error: /, "")]).toEqual([
        true,
        "commitments: this idempotency key filed this follow-up already, saying something else: a retry repeats its filing exactly; a new finding takes a new key",
        true,
        "commitments: the id f2 is taken",
      ])
      expect([once.error, again.text, other.error, other.text]).toEqual([false, "follow_up: f2 is filed already by this key; nothing filed again.", true, expect.stringContaining("this idempotency key filed another follow-up already")])
      const status = yield* run.probe(root, ORCHESTRATE, { action: "status" })
      expect(sectionIn(status.text)).toContain("- unowned: base, f1, f2")
    }),
  ),
)

// The reasons at the plugin's tools (moved from the planner's public-red probes): no reason, no filing and no close; a
// reason the plugin cannot check is refused by name. This host's evidence reader reads nothing (the simulated record),
// so a receipt and a declaration are refused here; record-cli.test.ts proves them on real files.
seeded("a worker cannot file a follow-up without a checked reason, nor the root close by prose alone", ({ seed, expect }) =>
  onRecord(seed, (run) =>
    Effect.gen(function* () {
      const root = yield* run.world.session(WORK)
      const child = yield* run.world.session(WORK, { parentID: root })
      const bare = yield* run.probe(child, FOLLOW_UP, { id: "spare", title: "Retain status" })
      expect([bare.error, bare.text.includes("reason")]).toEqual([true, true])
      expect((yield* run.probe(root, COMMITMENTS, { action: "add", source_kind: "plan-part", source_ref: "plan-a", parts: [{ id: "delayed-piece", title: "Retain a result for retry", rank: "D" }] })).error).toBe(false)
      const prose = yield* run.probe(root, COMMITMENTS, { action: "decide", id: "delayed-piece", why: "skip a check" })
      expect([prose.error, prose.text.replace(/^Error: /, "")]).toEqual([true, "commitments: decide needs reason_class."])
      const outcomes = yield* Effect.forEach(
        [
          [child, FOLLOW_UP, { id: "s1", title: "t", reason_class: "dependency", referent: { kind: "unit", id: "u1" } }],
          [child, FOLLOW_UP, { id: "s2", title: "t", reason_class: "dependency", referent: { kind: "commitment", id: "nothing" } }],
          [child, FOLLOW_UP, { id: "s3", title: "t", reason_class: "measured", referent: { kind: "receipt", path: "tmp/orchestrate/r1/x.json" } }],
          [child, FOLLOW_UP, { id: "s4", title: "t", reason_class: "dependency", referent: { kind: "commitment", id: "delayed-piece" }, validated: true }],
          [root, COMMITMENTS, { action: "decide", id: "delayed-piece", why: "x", reason_class: "measured", referent: { kind: "receipt", path: "tmp/orchestrate/r1/x.json" } }],
          [root, COMMITMENTS, { action: "decide", id: "delayed-piece", why: "x", reason_class: "guarantee", referent: { kind: "invariant", id: "never-declared" } }],
          [root, COMMITMENTS, { action: "decide", id: "delayed-piece", why: "x", reason_class: "guarantee", referent: { kind: "spec-item", id: "s1" } }],
          [root, COMMITMENTS, { action: "defer", id: "delayed-piece", reason_class: "dependency", referent: { kind: "commitment", id: "delayed-piece" } }],
          [root, COMMITMENTS, { action: "invariant", id: "one-writer", doc_path: "docs/record.md", anchor: "one-writer" }],
          [child, COMMITMENTS, { action: "decide", id: "delayed-piece", why: "x", reason_class: "guarantee", referent: { kind: "invariant", id: "one-writer" } }],
        ] as const,
        ([session, tool, input]) => Effect.map(run.probe(session, tool, input), (probe) => [probe.error, probe.text.replace(/^Error: /, "")] as const),
      )
      expect(outcomes).toEqual([
        [true, "follow_up: a unit referent is not available yet: it ships with hand-back-tools (unit D)"],
        [true, 'commitments: the dependency "nothing" is no commitment of this repository\'s record'],
        [true, "follow_up: this host reads no receipts"],
        [true, expect.stringContaining("takes no key at position 5 of its 5 (1 refused); a key's text is not repeated")],
        [true, "commitments: a measurement orders work, it never closes it: decide takes a guarantee; defer takes a measurement"],
        [true, expect.stringContaining("the invariant never-declared is not declared")],
        [true, "commitments: a spec-item referent is not available yet: it ships with spec-items (unit C)"],
        [true, "commitments: delayed-piece cannot wait on itself"],
        [true, "commitments: this host reads no documents"],
        [true, expect.stringContaining(PARENT_REFUSAL)],
      ])
      // Nothing of it was written: the row is open with no reason.
      const listed = yield* run.probe(root, COMMITMENTS, { action: "list" })
      expect(listed.text).toContain("delayed-piece [unowned] -: Retain a result for retry (plan-part plan-a; default)")
      expect(listed.text).not.toContain("waits on")
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
