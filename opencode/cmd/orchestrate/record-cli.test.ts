// The record's CLI on scratch files: a structured call per action with the tool's refusals, `list` on a file it may
// not write, and `import --map ergo-register` from a register built with Ergo's DDL (`register.sql`, below) and
// invented rows: the mapping row by row, counts in equal counts out by state, a row that does not map refused by its
// id and column with nothing written, a second import that changes nothing, and the section of a 295-row import
// under 40 lines.
import { Database } from "bun:sqlite"
import { expect } from "bun:test"
import { spawnSync, write } from "bun"
import { Array as Arr, Effect, Layer, Option, Schema } from "effect"
import { listedOf, sectionOf } from "@dotfiles/opencode-orchestrate/commitments-tool"
import { platform as ownPlatform } from "@dotfiles/opencode-orchestrate/node/platform"
import { hostServices } from "../../sim/host-services.ts"
import * as SqliteRecord from "@dotfiles/opencode-orchestrate/sqlite/record"
import * as Seed from "../../sim/seed.ts"
import { gitInit, withProcessEnv } from "../../tests/git-repo.ts"
import { scratch } from "../../tests/scratch.ts"
import { main } from "./record.ts"

/** Ergo's register DDL, as its `register.sql` creates the tables the import reads. */
const REGISTER_SQL = [
  `CREATE TABLE commitment (
    id TEXT PRIMARY KEY, title TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK(source_kind IN ('owner-answer','owner-ask','assignment','follow-up','bug','plan-part')),
    source_ref TEXT NOT NULL, plan TEXT, part TEXT, rank TEXT NOT NULL CHECK(rank IN ('A','B','C','D')),
    owner_lane TEXT, owner_session TEXT,
    state TEXT NOT NULL CHECK(state IN ('open','started','ready','queued','landed','closed','dropped-by-decision')),
    trigger_kind TEXT NOT NULL DEFAULT 'none' CHECK(trigger_kind IN ('none','commit-on-main','unit-landed','date','manual')),
    trigger_ref TEXT, head TEXT, request_path TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CHECK ((trigger_kind='none') = (trigger_ref IS NULL)),
    CHECK (owner_session IS NULL OR owner_lane IS NOT NULL)
  ) STRICT`,
  `CREATE TABLE event (
    seq INTEGER PRIMARY KEY, commitment_id TEXT NOT NULL REFERENCES commitment(id),
    at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    actor TEXT NOT NULL, from_state TEXT, to_state TEXT NOT NULL, note TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE prerequisite (
    commitment_id TEXT NOT NULL REFERENCES commitment(id),
    kind TEXT NOT NULL CHECK(kind IN ('commit-on-main','unit-landed','date','manual')),
    ref TEXT NOT NULL, PRIMARY KEY (commitment_id,kind,ref)
  ) STRICT`,
  // What Ergo adds before an import (q3): the commit a landed row landed as.
  "ALTER TABLE commitment ADD COLUMN landed_commit TEXT",
]

interface Row {
  readonly id: string
  readonly state: string
  readonly owner?: string
  readonly trigger?: readonly [string, string]
  readonly landed?: string
  readonly kind?: string
}
interface Event {
  readonly id: string
  readonly to: string
  readonly from?: string
  readonly note: string
}

/** A call's fields as `--json` takes them. */
const fieldsJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json))

const AT = "2026-11-01T09:00:00.000Z"

/** A register at `path` with `rows`, their `events` and `prerequisites`, all invented. */
const register = (path: string, rows: ReadonlyArray<Row>, events: ReadonlyArray<Event>, prerequisites: ReadonlyArray<readonly [string, string, string]> = []) => {
  const db = new Database(path, { create: true, strict: true })
  for (const statement of REGISTER_SQL) db.run(statement)
  const insert = db.query(
    "INSERT INTO commitment (id, title, source_kind, source_ref, rank, owner_lane, state, trigger_kind, trigger_ref, landed_commit, created_at, updated_at) VALUES (?, ?, ?, ?, 'B', ?, ?, ?, ?, ?, ?, ?)",
  )
  for (const row of rows)
    insert.run(row.id, `the ${row.id} work`, row.kind ?? "plan-part", "plan.md:3", Option.getOrNull(Option.fromUndefinedOr(row.owner)), row.state, row.trigger?.[0] ?? "none", Option.getOrNull(Option.map(Option.fromUndefinedOr(row.trigger), (trigger) => trigger[1])), Option.getOrNull(Option.fromUndefinedOr(row.landed)), AT, AT)
  const event = db.query("INSERT INTO event (commitment_id, at, actor, from_state, to_state, note) VALUES (?, ?, 'ORCH', ?, ?, ?)")
  for (const each of events) event.run(each.id, AT, Option.getOrNull(Option.fromUndefinedOr(each.from)), each.to, each.note)
  for (const [id, kind, ref] of prerequisites) db.query("INSERT INTO prerequisite (commitment_id, kind, ref) VALUES (?, ?, ?)").run(id, kind, ref)
  db.close()
}

const ROWS: ReadonlyArray<Row> = [
  { id: "c-open", state: "open", owner: "ORCH" },
  { id: "c-started", state: "started", owner: "u1" },
  { id: "c-ready", state: "ready", owner: "u2" },
  { id: "c-queued", state: "queued", trigger: ["commit-on-main", "abc1234"] },
  { id: "c-landed", state: "landed", owner: "u3", landed: "def5678" },
  { id: "c-closed", state: "closed" },
  { id: "c-dropped", state: "dropped-by-decision", kind: "owner-answer" },
]
const EVENTS: ReadonlyArray<Event> = [
  { id: "c-started", to: "open", note: "filed" },
  { id: "c-started", from: "open", to: "started", note: "lane made" },
  { id: "c-closed", from: "open", to: "closed", note: "superseded by c-open" },
  { id: "c-dropped", from: "open", to: "dropped-by-decision", note: "the owner chose the other way" },
]

const cli = (dir: string, ...args: ReadonlyArray<string>) => main([...args, "--file", `${dir}/record.db`], dir)
const imported = (dir: string) => cli(dir, "import", "--json", fieldsJson({ from: `${dir}/register.db`, map: "ergo-register" }))

Seed.effect(
  "import --map ergo-register maps each row, counts in equal counts out by state, and a second import changes nothing",
  Effect.acquireUseRelease(
    Effect.sync(() => scratch("record-cli-")),
    (held) =>
      Effect.gen(function* () {
        register(`${held.path}/register.db`, ROWS, EVENTS, [["c-queued", "manual", "go"]])
        const first = yield* imported(held.path)
        expect(first).toEqual({ out: "commitments: imported 7 rows into default; the rest were held already. Counts out from in: open 4, landed 1, decided 2 from open 1, started 1, ready 1, queued 1, landed 1, closed 1, dropped-by-decision 1.", err: "", code: 0 })
        const listed = yield* cli(held.path, "list", "--json", fieldsJson({ all: true }), "--checkout", "/nonexistent/loop-probe-x")
        expect(listed.out.split("\n").map((line) => line.split(" ").slice(0, 3).join(" "))).toEqual([
          "commitments: 7",
          "c-closed [decided] -:",
          "c-dropped [decided] -:",
          "c-landed [landed] u3:",
          "c-open [due] root:",
          "c-queued [unowned] -:",
          "c-ready [due] u2:",
          "c-started [held] u1:",
        ])
        // An imported close has no reason this code checked: it reads historical, unclassified (round 4's incompatibility
        // with the older record, which listed it bare).
        expect(listed.out.split("\n").filter((line) => line.includes("[decided]")).map((line) => line.includes("historical, unclassified"))).toEqual([true, true])
        const history = yield* cli(held.path, "history", "--json", fieldsJson({ id: "c-started" }))
        expect(history.out.split("\n").slice(1).map((line) => line.split(" ").slice(2).join(" "))).toEqual([
          "imported_history by import ORCH (filed)",
          "imported_history open → started by import ORCH (lane made)",
          "imported by import ergo-register",
        ])
        const before = (yield* cli(held.path, "export")).out
        const again = yield* imported(held.path)
        expect(again.out).toStartWith("commitments: imported 0 rows into default")
        expect((yield* cli(held.path, "export")).out).toBe(before)
      }),
    (held) => Effect.sync(() => held[Symbol.dispose]()),
  ),
)

Seed.effect(
  "a row that does not map is refused by its id and column, and nothing is imported",
  Effect.acquireUseRelease(
    Effect.sync(() => scratch("record-cli-")),
    (held) =>
      Effect.gen(function* () {
        register(`${held.path}/register.db`, [...ROWS, { id: "c-bad", state: "landed", owner: "u4" }], EVENTS)
        expect(yield* imported(held.path)).toEqual({ out: "", err: "commitments: ergo-register: row c-bad, column landed_commit: a landed row needs the commit on the default branch", code: 1 })
        expect((yield* cli(held.path, "list")).out).toBe("commitments: none match.")
      }),
    (held) => Effect.sync(() => held[Symbol.dispose]()),
  ),
)

const gitEnv = withProcessEnv({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" })

Seed.effect(
  "the CLI takes reasons as the tools do: an invariant from a committed document, a guarantee closes, a receipt orders, no reason refused",
  Effect.acquireUseRelease(
    Effect.sync(() => scratch("record-cli-")),
    (held) =>
      Effect.gen(function* () {
        // A checkout with a committed document and one receipt envelope in its evidence root.
        const checkout = `${held.path}/repo`
        yield* Effect.promise(() => write(`${checkout}/docs/record.md`, "# One writer\n"))
        const envelope = { receipt: 1, command: "bun test mods/orchestrate", exit: 1, output: { value: "1 fail" }, run: "r1", checkout: "a".repeat(40) }
        yield* Effect.promise(() => write(`${checkout}/tmp/orchestrate/r1/red.json`, fieldsJson(envelope)))
        gitInit(checkout, ["-q", "-b", "main"], gitEnv)
        for (const args of [["add", "docs/record.md"], ["commit", "-q", "-m", "docs"]]) spawnSync(["git", "-C", checkout, ...args], { env: gitEnv, stdout: "ignore", stderr: "ignore" })
        const run = (action: string, fields: Parameters<typeof fieldsJson>[0], ...rest: ReadonlyArray<string>) =>
          Effect.map(main([action, "--json", fieldsJson(fields), "--file", `${held.path}/record.db`, "--checkout", checkout, ...rest], checkout), (ran) => [ran.code, ran.out + ran.err] as const)
        const receipt = { reason_class: "measured", referent: { kind: "receipt", path: "tmp/orchestrate/r1/red.json" } }
        const outcomes = [
          yield* run("add", { source_kind: "plan-part", source_ref: "plan.md:1", parts: [{ id: "a1", title: "one" }, { id: "a2", title: "two" }] }),
          yield* run("decide", { id: "a1", why: "the record has one writer" }),
          yield* run("follow_up", { id: "f1", title: "a flake" }),
          yield* run("invariant", { id: "one-writer", doc_path: "docs/record.md", anchor: "one-writer" }),
          yield* run("decide", { id: "a1", why: "the record has one writer", reason_class: "guarantee", referent: { kind: "invariant", id: "one-writer" } }),
          yield* run("decide", { id: "a2", why: "red", ...receipt }),
          yield* run("defer", { id: "a2", ...receipt }),
          yield* run("follow_up", { id: "f1", title: "a flake", ...receipt }, "--actor", "worker-1"),
          yield* run("follow_up", { id: "f2", title: "a flake", reason_class: "measured", referent: { kind: "receipt", path: "tmp/orchestrate/r1/none.json" } }),
        ]
        expect(outcomes).toEqual([
          [0, "commitments: added a1, a2. Unowned until assigned: a1, a2."],
          [1, "commitments: decide needs reason_class."],
          [1, expect.stringContaining("reason_class")],
          [0, expect.stringMatching(/^commitments: invariant one-writer declared: docs\/record\.md#one-writer at [0-9a-f]{12}; /)],
          [0, "commitments: a1 closed by decision, guarantee invariant/one-writer."],
          [1, "commitments: a measurement orders work, it never closes it: decide takes a guarantee; defer takes a measurement"],
          [0, "commitments: a2 stays open, waiting on measured receipt/tmp/orchestrate/r1/red.json."],
          [0, "follow_up: filed f1, unowned, waiting on measured receipt/tmp/orchestrate/r1/red.json; the root owns or decides it."],
          [1, "follow_up: the receipt does not exist"],
        ])
        expect((yield* run("history", { id: "a1" }))[1]).toContain("guarantee invariant/one-writer")
        expect((yield* run("list", { all: true }))[1]).toContain("a2")
        // tmp/orchestrate made a link out of the checkout, to the same valid envelope: no approved root, nothing read through it.
        yield* Effect.promise(() => write(`${held.path}/outside/r1/red.json`, fieldsJson(envelope)))
        expect(spawnSync(["mv", `${checkout}/tmp/orchestrate`, `${held.path}/moved`]).exitCode).toBe(0)
        expect(spawnSync(["ln", "-s", `${held.path}/outside`, `${checkout}/tmp/orchestrate`]).exitCode).toBe(0)
        expect(yield* run("defer", { id: "a2", ...receipt })).toEqual([1, "commitments: the checkout's tmp/orchestrate/ is reached through a link: it is not an approved root"])
      }),
    (held) => Effect.sync(() => held[Symbol.dispose]()),
  ),
)

Seed.effect(
  "list reads a file it may not write; a write to it is refused, and a bad call is refused as the tool refuses it",
  Effect.acquireUseRelease(
    Effect.sync(() => scratch("record-cli-")),
    (held) =>
      Effect.gen(function* () {
        const add = fieldsJson({ source_kind: "plan-part", source_ref: "plan.md:1", parts: [{ id: "a1", title: "one" }] })
        expect((yield* cli(held.path, "add", "--json", add)).code).toBe(0)
        expect(yield* cli(held.path, "decide", "--json", fieldsJson({ id: "a1" }))).toEqual({ out: "", err: "commitments: decide needs why.", code: 1 })
        // The file made read-only as a host that may not write it sees it (no Effect platform layer types against the mods' effect).
        expect(spawnSync(["chmod", "444", `${held.path}/record.db`]).exitCode).toBe(0)
        expect((yield* cli(held.path, "list", "--checkout", "/nonexistent/loop-probe-x")).out).toBe("commitments: 1\na1 [unowned] -: one (plan-part plan.md:1; default)")
        const refused = yield* cli(held.path, "release", "--json", fieldsJson({ id: "a1" }))
        expect(refused.code).toBe(1)
        expect(yield* main([], held.path)).toEqual({ out: "", err: expect.stringContaining("usage: bun cmd/orchestrate/record.ts"), code: 1 })
      }),
    (held) => Effect.sync(() => held[Symbol.dispose]()),
  ),
)

Seed.effect(
  "an import with a token in one row's owner is refused whole in one transaction, naming the row and column, the token in no output and no row",
  Effect.acquireUseRelease(
    Effect.sync(() => scratch("record-cli-")),
    (held) =>
      Effect.gen(function* () {
        // A GitHub token's shape, from parts, its body invented: a slug by its characters, refused only as a secret.
        const token = ["gh", "p_", "Zq8xW2mN4vB7cR1tY6uI9oP3aS5dF0gH2jK4"].join("")
        register(`${held.path}/register.db`, [...ROWS, { id: "c-leaky", state: "started", owner: token }], EVENTS)
        const refused = yield* imported(held.path)
        expect([refused.code, refused.out.includes(token) || refused.err.includes(token), refused.err.includes("row c-leaky, column commitment.owner_lane holds a secret's shape")]).toEqual([1, false, true])
        const listed = yield* cli(held.path, "list", "--json", fieldsJson({ all: true }))
        expect(listed.out).toBe("commitments: none match.")
      }),
    (held) => Effect.sync(() => held[Symbol.dispose]()),
  ),
)

/** 295 invented rows in Ergo's mix: most closed or landed, the rest open across a few dozen lanes, some unowned. */
const ERGO_LIKE: ReadonlyArray<Row> = Arr.makeBy(295, (at) => {
  const id = `r${String(at).padStart(3, "0")}`
  const pick = at % 10
  if (pick < 4) return { id, state: "landed", owner: `u${at % 40}`, landed: `c${String(at).padStart(6, "0")}` }
  if (pick < 6) return { id, state: "closed" }
  if (pick < 7) return { id, state: "queued" }
  if (pick < 8) return { id, state: "started", owner: `u${at % 40}` }
  if (pick < 9) return { id, state: "open", owner: "ORCH", kind: "owner-answer" }
  return { id, state: "ready", owner: `u${at % 40}`, trigger: ["manual", `w${at}`] }
})

Seed.effect(
  "the section of a 295-row import stays under 40 lines",
  Effect.acquireUseRelease(
    Effect.sync(() => scratch("record-cli-")),
    (held) =>
      Effect.gen(function* () {
        register(
          `${held.path}/register.db`,
          ERGO_LIKE,
          ERGO_LIKE.flatMap((row) => Arr.filter([{ id: row.id, from: "open", to: "closed", note: "done another way" }], () => row.state === "closed")),
        )
        expect((yield* imported(held.path)).code).toBe(0)
        const reading = yield* SqliteRecord.connected(`${held.path}/record.db`, { readonly: true, now: Date.parse(AT) })
        const snapshot = yield* Effect.orDie(reading.store.read)
        reading.close()
        const lines = sectionOf(listedOf(snapshot, { now: Date.parse(AT), onMain: new Set(), gone: new Set() }))
        expect(lines.length).toBeLessThan(40)
        // Measured: the counts line, then unowned and due (ten ids each and the list call); held is quiet.
        expect(lines.length).toBe(3)
        expect(Option.fromUndefinedOr(lines[0])).toEqual(Option.some(expect.stringContaining("Commitments: 116 open")))
      }),
    (held) => Effect.sync(() => held[Symbol.dispose]()),
  ).pipe(Effect.provide(Layer.mergeAll(hostServices, ownPlatform))),
)
