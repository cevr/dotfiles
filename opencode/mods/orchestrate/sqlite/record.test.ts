// The SQLite record keeps the CommitmentRecord laws (laws.ts) on a scratch file, and what only a file does: two
// processes writing at once lose nothing, a file of a newer version reads and refuses writes, a read-only open reads,
// and the daily backup is written once a day with the newest seven kept.
import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Array as Arr, Effect, Layer, Option } from "effect"
import { gitInit } from "../../../tests/git-repo.ts"
import { commitmentRecordLaws } from "../laws.ts"
import { type Actor, Command, EMPTY, FREE_TEXT_COLUMNS, fold } from "../record.ts"
import { BACKUPS_KEPT, connectSync, keyOfCheckout, layer, MIGRATIONS, pathOf, stateDir, VERSION } from "./record.ts"

const T0 = 1_800_000_000_000
const DAY = 86_400_000

const scratch = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "record-store-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
)

commitmentRecordLaws(
  "the SQLite record",
  Effect.map(scratch, (dir) => Layer.orDie(layer(join(dir, "state", "repo.db"), { readonly: false, now: T0 }))),
)

/** A body over a scratch directory, removed after. */
const inScratch = <A, E>(body: (dir: string) => Effect.Effect<A, E>) => Effect.runPromise(Effect.scoped(Effect.flatMap(scratch, body)))

const add = (id: string) => Command.cases.add.make({ run: "r1", sourceKind: "plan-part", sourceRef: "plan.md:1", parts: [{ id, title: `part ${id}` }] })
const ROOT: Actor = { id: "ses_root", role: "root" }
/** This folder's store module, as a writer process imports it. */
const STORE = Bun.fileURLToPath(import.meta.resolve("./record.ts"))

test("the file is under XDG_STATE_HOME, else ~/.local/state", () => {
  expect(pathOf(Option.some("/state"), "github.com-cevr-dotfiles")).toBe("/state/opencode-orchestrate/github.com-cevr-dotfiles.db")
  expect(stateDir(Option.some(""))).toEndWith("/.local/state/opencode-orchestrate")
  expect(stateDir(Option.none())).toEndWith("/.local/state/opencode-orchestrate")
})

/** A writer process: opens its own connection and adds `count` commitments named `<name>-<i>`, one transaction each. */
const writer = `import { connectSync } from "${STORE}"
import { Command } from "${STORE.replace(/sqlite\/record\.ts$/, "record.ts")}"
import { Effect, Exit } from "${Bun.resolveSync("effect", STORE)}"
const [path, name, count] = process.argv.slice(2)
const opened = connectSync(path, { readonly: false, now: ${T0} })
for (let at = 0; at < Number(count); at++) {
  const command = Command.cases.add.make({ run: "r1", sourceKind: "plan-part", sourceRef: "plan.md:1", parts: [{ id: name + "-" + at, title: "part" }] })
  const exit = Effect.runSyncExit(opened.store.run(command, { actor: { id: name, role: "root" }, now: ${T0} + at }))
  if (Exit.isFailure(exit)) { console.error(String(exit.cause)); process.exit(1) }
}
opened.close()
`

/** A process's exit code and what it wrote to stderr. */
const ended = (run: Bun.Subprocess<"ignore", "pipe", "pipe">) =>
  Effect.all({ code: Effect.promise(() => run.exited), errors: Effect.promise(() => new Response(run.stderr).text()) }, { concurrency: 2 })

test("two processes writing 200 interleaved commands to one file lose none, and the replay law holds after", () =>
  inScratch((dir) =>
    Effect.gen(function* () {
      const path = join(dir, "repo.db")
      const script = join(dir, "writer.ts")
      writeFileSync(script, writer)
      const runs = ["one", "two"].map((name) => Bun.spawn([process.execPath, script, path, name, "100"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" }))
      const outcomes = yield* Effect.forEach(runs, ended, { concurrency: 2 })
      expect(outcomes).toEqual([
        { code: 0, errors: "" },
        { code: 0, errors: "" },
      ])
      const opened = connectSync(path, { readonly: true, now: T0 })
      const snapshot = yield* opened.store.read
      const events = yield* opened.store.events
      opened.close()
      expect(snapshot.commitments.size).toBe(200)
      expect(events.length).toBe(200)
      expect(fold(EMPTY, events)).toEqual(snapshot)
    }),
  ))

test("a file of a newer version than this code reads, and refuses every write with the version it needs", () =>
  inScratch((dir) =>
    Effect.gen(function* () {
      const path = join(dir, "repo.db")
      const first = connectSync(path, { readonly: false, now: T0 })
      yield* first.store.run(add("kept-1"), { actor: ROOT, now: T0 })
      first.close()
      const raw = new Database(path)
      raw.run(`PRAGMA user_version = ${VERSION + 1}`)
      raw.close()
      const newer = connectSync(path, { readonly: false, now: T0 })
      const refused = yield* Effect.flip(newer.store.run(add("kept-2"), { actor: ROOT, now: T0 }))
      expect(refused._tag).toBe("RecordFailed")
      expect(refused.message).toContain(`version ${VERSION + 1}; this code writes version ${VERSION}`)
      expect([...(yield* newer.store.read).commitments.keys()]).toEqual(["kept-1"])
      newer.close()
    }),
  ))

for (const from of [1, 2])
  test(`a version ${from} file migrates to this version on open: its rows kept, a lane made before has no lane path or start, a lane made after keeps both`, () =>
  inScratch((dir) =>
    Effect.gen(function* () {
      const path = join(dir, "repo.db")
      // A file as version `from` code left it: its statements alone, one lane's commitment, its user_version.
      const raw = new Database(path, { create: true, strict: true })
      for (const statement of MIGRATIONS.slice(0, from).flat()) raw.run(statement)
      raw.run(`PRAGMA user_version = ${from}`)
      raw.run(
        "INSERT INTO commitment (id, run, title, source_kind, source_ref, owner_lane, state, started_at, review_by, created_at, updated_at) VALUES ('old-unit', 'r1', 'land unit old-unit', 'assignment', 'orchestrate lane old-unit', 'old-unit', 'open', '2027-01-15T08:00:00.000Z', '2027-01-22T08:00:00.000Z', '2027-01-15T08:00:00.000Z', '2027-01-15T08:00:00.000Z')",
      )
      raw.close()
      const opened = connectSync(path, { readonly: false, now: T0 })
      yield* opened.store.run(Command.cases.lane.make({ run: "r1", unit: "new-unit", startHead: Option.some("a".repeat(40)), path: Option.some("/w/new-unit") }), { actor: ROOT, now: T0 })
      opened.close()
      const check = new Database(path, { readonly: true })
      const version = check.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version
      check.close()
      expect([VERSION, version]).toEqual([MIGRATIONS.length, MIGRATIONS.length])
      const again = connectSync(path, { readonly: false, now: T0 })
      const rows = (yield* again.store.read).commitments
      expect([rows.get("old-unit")?.state, rows.get("old-unit")?.startHead, rows.get("old-unit")?.lanePath, rows.get("new-unit")?.startHead, rows.get("new-unit")?.lanePath]).toEqual([
        "open",
        Option.none(),
        Option.none(),
        Option.some("a".repeat(40)),
        Option.some("/w/new-unit"),
      ])
      again.close()
    }),
  ))

test("a read-only open reads what a writer wrote and refuses writes; a reopened store sees the same rows", () =>
  inScratch((dir) =>
    Effect.gen(function* () {
      const path = join(dir, "repo.db")
      const writing = connectSync(path, { readonly: false, now: T0 })
      yield* writing.store.run(add("ro-1"), { actor: ROOT, now: T0 })
      const reading = connectSync(path, { readonly: true, now: T0 })
      expect([...(yield* reading.store.read).commitments.keys()]).toEqual(["ro-1"])
      const refused = yield* Effect.flip(reading.store.run(add("ro-2"), { actor: ROOT, now: T0 }))
      expect(refused._tag).toBe("RecordFailed")
      reading.close()
      writing.close()
      const again = connectSync(path, { readonly: false, now: T0 })
      expect([...(yield* again.store.read).commitments.keys()]).toEqual(["ro-1"])
      again.close()
    }),
  ))

test("the daily backup is written at a day's first open only, and the eighth day's prunes the oldest", () =>
  inScratch((dir) =>
    Effect.gen(function* () {
      const path = join(dir, "repo.db")
      const days = Array.from({ length: BACKUPS_KEPT + 1 }, (_, at) => T0 + at * DAY)
      for (const now of days) {
        const opened = connectSync(path, { readonly: false, now })
        yield* opened.store.run(add(`day-${now}`), { actor: ROOT, now })
        opened.close()
        connectSync(path, { readonly: false, now: now + 1_000 }).close()
      }
      const kept = readdirSync(join(dir, "backup")).toSorted()
      expect(kept).toHaveLength(BACKUPS_KEPT)
      expect([kept.at(0), kept.at(-1)]).toEqual(["repo-2027-01-16.db", "repo-2027-01-22.db"])
      // Each backup is a whole database: the last holds every row written before its day's first open.
      const last = new Database(join(dir, "backup", "repo-2027-01-22.db"), { readonly: true })
      expect(last.query("SELECT count(*) AS n FROM commitment").get()).toEqual({ n: BACKUPS_KEPT })
      last.close()
    }),
  ))

test("a repository with no origin: its workspace, a subfolder and the base share one key; another repository has its own", () =>
  inScratch((dir) =>
    Effect.sync(() => {
      const env = { PATH: Bun.env["PATH"] ?? "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" }
      const init = (path: string) => {
        mkdirSync(join(path, "sub"), { recursive: true })
        writeFileSync(join(path, "sub", "f"), path)
        gitInit(path, ["-q", "-b", "main"], env)
        for (const args of [["add", "-A"], ["commit", "-q", "-m", "root"]]) Bun.spawnSync(["git", "-C", path, ...args], { env, stdout: "ignore", stderr: "ignore" })
      }
      const base = join(dir, "repo")
      init(base)
      // A workspace as `work` makes one: a copy of the base, laid out beside it.
      const workspace = join(dir, ".work", "repo", "lane-1")
      cpSync(base, workspace, { recursive: true })
      const other = join(dir, "other")
      init(other)
      const keys = [base, join(base, "sub"), workspace, join(workspace, "sub")].map(keyOfCheckout)
      expect(new Set(keys).size).toBe(1)
      expect(keys[0]).toStartWith("local-")
      expect(keyOfCheckout(other)).not.toBe(keys[0])
    }),
  ))

/**
 * The TEXT columns that hold no free text: ids and tokens (checked as one token where they are written), times, and
 * literals a CHECK holds. Every other TEXT column must be in FREE_TEXT_COLUMNS, which the one boundary bounds and
 * redacts; a new column fails the first test below until it is named in one of the two, and, when free, filled by
 * the second test's commands.
 */
const NOT_FREE = [
  "commitment.id", "commitment.run", "commitment.source_kind", "commitment.rank", "commitment.owner_lane", "commitment.owner_session", "commitment.state",
  "commitment.started_at", "commitment.review_by", "commitment.woke_at", "commitment.head", "commitment.landed_commit", "commitment.notice_until",
  "commitment.created_at", "commitment.updated_at", "commitment.start_head", "commitment.notice_by", "commitment.lane_path",
  "prerequisite.commitment_id", "prerequisite.kind", "prerequisite.ref", "prerequisite.met_at",
  "event.at", "event.run", "event.subject_kind", "event.subject_id", "event.type", "event.actor", "event.actor_role", "event.from_state", "event.to_state",
  "hand_back.run", "hand_back.owner_lane", "hand_back.session", "hand_back.verdict", "hand_back.head", "hand_back.at", "hand_back.routing", "hand_back.routed_at", "hand_back.routed_by",
  "lane_session.lane", "lane_session.session",
  "word.run", "word.word", "word.given_at", "word.given_by",
]

/** Every TEXT column of the file's tables, as `<table>.<column>`. */
const textColumnsOf = (db: Database): ReadonlyArray<string> =>
  db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .flatMap((table) => db.query<{ name: string; type: string }, []>(`PRAGMA table_info(${table.name})`).all().flatMap((column) => Arr.filter([`${table.name}.${column.name}`], () => column.type === "TEXT")))

const SECRET = "ghp_0123456789abcdefghijABCDEFGHIJ0123"

test("every TEXT column is free text the boundary holds, or named as no free text", () =>
  inScratch((dir) =>
    Effect.sync(() => {
      const opened = connectSync(join(dir, "repo.db"), { readonly: false, now: T0 })
      opened.close()
      const db = new Database(join(dir, "repo.db"), { readonly: true })
      const columns = textColumnsOf(db)
      db.close()
      expect(columns.filter((column) => !NOT_FREE.includes(column)).toSorted()).toEqual([...FREE_TEXT_COLUMNS].toSorted())
    }),
  ))

test("a secret given in any free-text field is stored in no column, and a field past its bound is refused whole", () =>
  inScratch((dir) =>
    Effect.gen(function* () {
      const path = join(dir, "repo.db")
      const opened = connectSync(path, { readonly: false, now: T0 })
      const worker: Actor = { id: "ses_worker", role: "worker" }
      const importer: Actor = { id: "ergo-register", role: "import" }
      const secret = (what: string) => `${what} ${SECRET}`
      yield* opened.store.run(
        Command.cases.add.make({
          run: "r1",
          sourceKind: "owner-answer",
          sourceRef: secret("ref"),
          quote: Option.some(secret("quote")),
          plan: Option.some(secret("plan")),
          suggestOwner: Option.some(secret("owner")),
          parts: [{ id: "s1", title: secret("title"), part: Option.some(secret("part")) }],
        }),
        { actor: ROOT, now: T0 },
      )
      yield* opened.store.run(Command.cases.decide.make({ id: "s1", why: secret("why") }), { actor: ROOT, now: T0 })
      yield* opened.store.run(
        Command.cases.hand_back.make({ run: "r1", ownerLane: "u1", role: secret("role"), session: "ses_worker", verdict: "done", file: Option.some(secret("file")), claims: [] }),
        { actor: worker, now: T0 },
      )
      const row = {
        title: secret("imported title"),
        sourceKind: "plan-part" as const,
        sourceRef: secret("imported ref"),
        state: "decided" as const,
        requestPath: Option.some(secret("request")),
        decidedWhy: Option.some(secret("imported why")),
        createdAt: "2027-01-15T08:00:00.000Z",
        updatedAt: "2027-01-15T08:00:00.000Z",
        after: [],
      }
      yield* opened.store.run(Command.cases.import.make({ run: "r1", rows: [{ id: "s2", row, history: [{ at: "2027-01-15T08:00:00.000Z", actor: "ORCH", note: secret("history note") }] }] }), {
        actor: importer,
        now: T0,
      })
      const long = yield* Effect.flip(opened.store.run(Command.cases.add.make({ run: "r1", sourceKind: "follow-up", sourceRef: "x", plan: Option.some("p".repeat(2_000_000)), parts: [{ id: "s3", title: "t" }] }), { actor: ROOT, now: T0 }))
      expect(long).toMatchObject({ reason: "the plan is 2000000 characters, more than 200" })
      opened.close()
      const db = new Database(path, { readonly: true })
      const stored = textColumnsOf(db).flatMap((column) => {
        const [table, name] = column.split(".")
        return db.query<{ value: string }, []>(`SELECT coalesce(${name}, '') AS value FROM ${table}`).all().map((each) => [column, each.value] as const)
      })
      db.close()
      expect(stored.filter(([, value]) => value.includes(SECRET))).toEqual([])
      // Each free column was filled, its secret replaced.
      expect(FREE_TEXT_COLUMNS.filter((column) => !stored.some(([held, value]) => held === column && value.includes("[redacted]")))).toEqual([])
    }),
  ))
