// @reads all
// @reads-reason nonliteral subprocess arguments at cmd/orchestrate/record-cli.test.ts: for (const args of [["add", "docs/record.md"], ["commit", "-q", "-m", "docs"]]) spawnSync(["git
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
import { printable } from "@dotfiles/opencode-orchestrate/printable"
import { platform as ownPlatform } from "@dotfiles/opencode-orchestrate/node/platform"
import { hostServices } from "../../sim/host-services.ts"
import * as SqliteRecord from "@dotfiles/opencode-orchestrate/sqlite/record"
import { simulationTest } from "../../sim/seed.ts"
import { gitInit, withProcessEnv } from "../../tests/git-repo.ts"
import { scratch } from "../../tests/scratch.ts"
import { CANARY, COMMITMENT_CALLS, canariedFields, type Fields, FOLLOW_UP_CALLS, placedCalls, textsOf } from "../../sim/canary.ts"
import { generator } from "../../sim/runtime.ts"
import { leaked, leakedFrom, type Placed, placedAt, windowsOf } from "../../sim/tokens.ts"
import { main as printed } from "./record.ts"

/** The CLI on `args`, its printable output read as the text it prints. */
const main = (args: ReadonlyArray<string>, cwd: string) => Effect.map(printed(args, cwd), (ran): { readonly out: string; readonly err: string; readonly code: number } => ran)

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

const retryInput = (id: string, title: string) => ({
  id, title, run: "one", rank: "A", suggest_owner: "lane-one", key: `key-${id}`,
  reason_class: "dependency", referent: { kind: "commitment", id: "blocker" },
})

simulationTest("a reopened store retries identical original payloads and refuses every changed follow-up field", Effect.gen(function* () {
  using dir = scratch("record-retry-identity-")
  const db = `${dir.path}/record.db`
  const receiptPath = "tmp/orchestrate/retry.json"
  const receipt = (exit: number) => write(`${dir.path}/${receiptPath}`, fieldsJson({
    receipt: 1, command: "synthetic check", exit, output: { value: "fixture result" }, run: "one", checkout: "a".repeat(40),
  }))
  yield* Effect.promise(() => receipt(1))
  gitInit(dir.path, ["-q", "-b", "main"], gitEnv)
  const measuredReceipt = { reason_class: "measured", referent: { kind: "receipt", path: receiptPath } }
  const run = (action: string, fields: Schema.Json, actor = "scratch-worker") =>
    main([action, "--file", db, "--actor", actor, "--json", fieldsJson(fields)], dir.path)
  const parts = [{ id: "blocker", title: "pending" }, { id: "another", title: "another pending" }]
  expect((yield* run("add", { source_kind: "plan-part", source_ref: "plan:1", parts })).code).toBe(0)
  for (const at of Arr.range(0, 7)) {
    const key = ["AK", "IA", "A".repeat(16 + at)].join("")
    const a = `alphafix${key}`
    const b = `betafix${key}`
    expect(printable(a)).toBe(printable(b))
    const base = retryInput(`case-${at}`, a)
    const changes = [
      { title: b },
      { title: ` ${a}` },
      { run: "two" },
      { rank: "B" },
      { suggest_owner: "lane-two" },
      measuredReceipt,
      { referent: { kind: "commitment", id: "another" } },
      { id: `changed-${at}` },
      { key: "other-key" },
    ]
    expect((yield* run("follow_up", base)).code).toBe(0)
    const exact = yield* run("follow_up", base)
    expect(exact.code).toBe(0)
    expect(exact.out).toContain("filed already")
    for (const changed of changes) {
      const result = yield* run("follow_up", { ...base, ...changed })
      expect(result.code).toBe(1)
      expect(result.out).not.toContain("filed already")
    }
    expect((yield* run("follow_up", base, "other-worker")).code).toBe(1)
    const history = yield* run("history", { id: base.id })
    expect(history.out.split("\n").filter((line) => line.includes("promised")).length).toBe(1)
  }
  const checked = { ...retryInput("measurement", "check results"), ...measuredReceipt }
  expect((yield* run("follow_up", checked)).out).toContain("filed measurement")
  // The observation changed, not what the caller filed.
  yield* Effect.promise(() => receipt(0))
  expect((yield* run("follow_up", checked)).out).toContain("filed already")
  const exported = yield* run("export", {})
  expect(exported.out).not.toContain('"filing":')
  const bytes = yield* textsOf([db, `${db}-wal`])
  expect(bytes.join("").includes("alphafix")).toBe(false)
  expect(bytes.join("").includes("betafix")).toBe(false)
}))

simulationTest("two source keys with the same display remain distinct and stores have different authenticators", Effect.gen(function* () {
  using dir = scratch("record-source-identity-")
  const run = (db: string, action: string, fields: Schema.Json) =>
    main([action, "--file", db, "--actor", "scratch-worker", "--json", fieldsJson(fields)], dir.path)
  const tag = (db: string, id: string) => {
    using file = new Database(db, { readonly: true })
    return file.query<{ readonly source: string; readonly payload: string }, [string]>(
      "SELECT json_extract(data, '$.filing.source') AS source, json_extract(data, '$.filing.payload') AS payload FROM event WHERE subject_id = ? AND type = 'promised'",
    ).get(id)
  }
  const a = `${dir.path}/a.db`
  const b = `${dir.path}/b.db`
  const formed = ["AK", "IA", "A".repeat(16)].join("")
  const left = { ...retryInput("left", "one"), key: `left${formed}` }
  const right = { ...retryInput("right", "two"), key: `right${formed}` }
  expect(printable(`scratch-worker:${left.key}`)).toBe(printable(`scratch-worker:${right.key}`))
  for (const file of [a, b]) {
    expect((yield* run(file, "add", { source_kind: "plan-part", source_ref: "p:1", parts: [{ id: "blocker", title: "pending" }] })).code).toBe(0)
    expect((yield* run(file, "follow_up", left)).code).toBe(0)
    expect((yield* run(file, "follow_up", right)).code).toBe(0)
    expect((yield* run(file, "follow_up", right)).out).toContain("filed already")
    expect((yield* run(file, "follow_up", { ...left, id: "third" })).err).toContain("filed another follow-up")
  }
  const first = tag(a, "left")
  const second = tag(b, "left")
  expect(first?.source).toBeString()
  expect(first?.payload).toBeString()
  expect(first?.source).not.toBe(second?.source)
  expect(first?.payload).not.toBe(second?.payload)
}))

simulationTest("a version-one follow-up survives migration but cannot be claimed as a verified retry", Effect.gen(function* () {
  using dir = scratch("record-legacy-identity-")
  const path = `${dir.path}/record.db`
  {
    using db = new Database(path)
    for (const ddl of SqliteRecord.MIGRATIONS[0]) db.run(ddl)
    db.run("PRAGMA user_version = 1")
    db.query("INSERT INTO commitment (id,run,title,source_kind,source_ref,state,created_at,updated_at) VALUES ('old','one','[redacted]','follow-up','legacy-worker:key-old','open',?,?)").run(AT, AT)
    db.query("INSERT INTO event (at,run,subject_kind,subject_id,type,actor,actor_role,to_state,data) VALUES (?,?, 'commitment',?,'promised',?,'worker','open',?)")
      .run(AT, "one", "old", "legacy-worker", '{"_tag":"promised","title":"[redacted]","sourceKind":"follow-up","sourceRef":"legacy-worker:key-old","reason":{"reasonClass":"dependency","referent":"commitment/blocker"}}')
  }
  const run = (action: string, fields: Schema.Json, actor = "legacy-worker") =>
    main([action, "--file", path, "--actor", actor, "--json", fieldsJson(fields)], dir.path)
  const before = yield* run("history", { id: "old" })
  expect(before.code).toBe(0)
  expect(before.out).toContain("promised")
  const retry = yield* run("follow_up", retryInput("old", "[redacted]"))
  expect(retry.code).toBe(1)
  expect(retry.err).toContain("legacy filing")
  expect((yield* run("history", { id: "old" })).out).toBe(before.out)
  expect((yield* run("add", { source_kind: "plan-part", source_ref: "p:1", parts: [{ id: "blocker", title: "pending" }] })).code).toBe(0)
  const fresh = retryInput("new", "new title")
  expect((yield* run("follow_up", fresh)).err).toContain("legacy filing")
  expect((yield* run("follow_up", fresh, "fresh-worker")).code).toBe(0)
  expect((yield* run("follow_up", fresh, "fresh-worker")).out).toContain("filed already")
  using db = new Database(path, { readonly: true })
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 2 })
  expect(db.query("SELECT length(key) AS bytes FROM filing_key").get()).toEqual({ bytes: 32 })
}))

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

simulationTest(
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

simulationTest(
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

simulationTest(
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

// No output repeats what the caller wrote: a token-shaped canary as each key, value, id, path and referent of every
// action's `--json` (tests/canary.ts), as the actor, the file, the checkout, the action and an unknown flag, is in no
// stdout, no stderr, no exported event and no byte of the record's file.
simulationTest(
  "a token-shaped canary in any argument, key or value of a CLI call is in no output, exported event or record byte",
  Effect.acquireUseRelease(
    Effect.sync(() => scratch("record-cli-canary-")),
    (held) =>
      Effect.gen(function* () {
        const checkout = `${held.path}/repo`
        const db = `${held.path}/record.db`
        yield* Effect.promise(() => write(`${checkout}/docs/record.md`, "# One writer\n"))
        const envelope = { receipt: 1, command: "bun test mods/orchestrate", exit: 1, output: { value: "1 fail" }, run: "r1", checkout: "a".repeat(40) }
        yield* Effect.promise(() => write(`${checkout}/tmp/orchestrate/r1/red.json`, fieldsJson(envelope)))
        gitInit(checkout, ["-q", "-b", "main"], gitEnv)
        for (const args of [["add", "docs/record.md"], ["commit", "-q", "-m", "docs"]]) spawnSync(["git", "-C", checkout, ...args], { env: gitEnv, stdout: "ignore", stderr: "ignore" })
        const on = (...args: ReadonlyArray<string>) => main([...args, "--file", db, "--checkout", checkout], checkout)
        expect((yield* on("add", "--json", fieldsJson({ source_kind: "plan-part", source_ref: "plan.md:1", parts: [{ id: "a1", title: "one" }, { id: "a2", title: "two" }] }))).code).toBe(0)
        /** A call's `--json` and its action: the action key's value, else the canary's own action. */
        const argsOf = (call: Fields, actor: ReadonlyArray<string>) => {
          const { action = "follow_up", ...fields } = call
          return [String(action), "--json", fieldsJson(fields), ...actor]
        }
        const calls: ReadonlyArray<ReadonlyArray<string>> = [
          ...COMMITMENT_CALLS.flatMap((call) => canariedFields(call).map((input) => argsOf(input, []))),
          ...FOLLOW_UP_CALLS.flatMap((call) => canariedFields(call).map((input) => argsOf(input, ["--actor", "worker-1"]))),
          argsOf(FOLLOW_UP_CALLS[0], ["--actor", CANARY]),
          argsOf(COMMITMENT_CALLS[4], ["--actor", CANARY]),
          [CANARY],
          ["list", `--${CANARY}`],
          ["list", CANARY],
        ]
        const outputs = yield* Effect.forEach(calls, (args) => on(...args))
        const elsewhere = yield* Effect.forEach(
          [
            ["list", "--file", `${held.path}/${CANARY}/record.db`, "--checkout", checkout],
            ["add", "--file", db, "--checkout", `/nonexistent/loop-probe-x/${CANARY}`, "--json", fieldsJson({ source_kind: "plan-part", source_ref: "plan.md:2", parts: [{ id: "a3", title: "three" }] })],
            ["defer", "--file", db, "--checkout", `/nonexistent/loop-probe-x/${CANARY}`, "--json", fieldsJson({ id: "a2", reason_class: "measured", referent: { kind: "receipt", path: "tmp/orchestrate/r1/red.json" } })],
          ],
          (args) => main(args, checkout),
        )
        const exported = yield* on("export")
        const bytes = yield* textsOf([db, `${db}-wal`])
        const leaked = [...outputs, ...elsewhere, exported].filter((ran) => ran.out.includes(CANARY) || ran.err.includes(CANARY))
        expect({ calls: calls.length + elsewhere.length, silent: [...outputs, ...elsewhere].filter((ran) => ran.out === "" && ran.err === "").length, leaked, record: bytes.some((text) => text.includes(CANARY)) }).toEqual({
          calls: 123,
          silent: 0,
          leaked: [],
          record: false,
        })
        // The canary-free calls wrote: the record's bytes and its export were there to search.
        expect([exported.code, exported.out.includes("plan.md:1")]).toEqual([0, true])
      }),
    (held) => Effect.sync(() => held[Symbol.dispose]()),
  ),
)

// The acceptance of the one output boundary on the CLI: each way into a call the canary above takes, and the actor,
// the file and the checkout, carries a secret of every kind the redactor knows at any place in its value
// (sim/tokens.ts), one placement each. No stdout, stderr, exported event or record byte holds a fragment of LEAK_MIN
// characters of its secret.
simulationTest(
  "a secret of any kind at any place in any argument, key or value leaves no fragment in an output, an export or the record",
  Effect.acquireUseRelease(
    Effect.sync(() => scratch("record-cli-placed-")),
    (held) =>
      Effect.gen(function* () {
        const checkout = `${held.path}/repo`
        const db = `${held.path}/record.db`
        yield* Effect.promise(() => write(`${checkout}/docs/record.md`, "# One writer\n"))
        gitInit(checkout, ["-q", "-b", "main"], gitEnv)
        for (const args of [["add", "docs/record.md"], ["commit", "-q", "-m", "docs"]]) spawnSync(["git", "-C", checkout, ...args], { env: gitEnv, stdout: "ignore", stderr: "ignore" })
        const on = (...args: ReadonlyArray<string>) => main([...args, "--file", db, "--checkout", checkout], checkout)
        expect((yield* on("add", "--json", fieldsJson({ source_kind: "plan-part", source_ref: "plan.md:1", parts: [{ id: "a1", title: "one" }, { id: "a2", title: "two" }] }))).code).toBe(0)
        const argsOf = (call: Fields, actor: ReadonlyArray<string>) => {
          const { action = "follow_up", ...fields } = call
          return [String(action), "--json", fieldsJson(fields), ...actor]
        }
        const random = generator("record-cli-placed")
        const placedIn = (at: number) => placedAt(random, 2000 + at)
        const [actor, file, path] = [placedIn(0), placedIn(1), placedIn(2)]
        const calls: ReadonlyArray<readonly [ReadonlyArray<string>, string, Placed]> = [
          ...placedCalls(COMMITMENT_CALLS, random).map(([input, name, placed]) => [["--file", db, "--checkout", checkout, ...argsOf(input, [])], name, placed] as const),
          ...placedCalls(FOLLOW_UP_CALLS, random, 1000).map(([input, name, placed]) => [["--file", db, "--checkout", checkout, ...argsOf(input, ["--actor", "worker-1"])], name, placed] as const),
          [["--file", db, "--checkout", checkout, ...argsOf(COMMITMENT_CALLS[4], ["--actor", actor[1].value])], `actor ${actor[0]}`, actor[1]],
          [["list", "--file", `${held.path}/${file[1].value}/record.db`, "--checkout", checkout], `file ${file[0]}`, file[1]],
          [["defer", "--file", db, "--checkout", `/nonexistent/loop-probe-x/${path[1].value}`, "--json", fieldsJson({ id: "a2", reason_class: "measured", referent: { kind: "receipt", path: "tmp/orchestrate/r1/red.json" } })], `checkout ${path[0]}`, path[1]],
        ]
        const outputs = yield* Effect.forEach(calls, ([args]) => main(args, checkout))
        const exported = yield* on("export")
        const written = windowsOf(`${exported.out}\n${exported.err}\n${(yield* textsOf([db, `${db}-wal`])).join("")}`)
        const leaks = calls.flatMap(([, name, placed], at) =>
          [...leaked(`${outputs[at].out}\n${outputs[at].err}`, placed).map((fragment) => `output (${name}): ${fragment}`), ...leakedFrom(written, placed).map((fragment) => `export or record (${name}): ${fragment}`)].slice(0, 1),
        )
        expect({ calls: calls.length, silent: outputs.filter((ran) => ran.out === "" && ran.err === "").length, leaks }).toEqual({ calls: 118, silent: 0, leaks: [] })
        expect([exported.code, exported.out.includes("plan.md:1")]).toEqual([0, true])
      }),
    (held) => Effect.sync(() => held[Symbol.dispose]()),
  ),
)

simulationTest(
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

simulationTest(
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

simulationTest(
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
