// The SQLite record keeps the CommitmentRecord laws (laws.ts) on a scratch file, and what only a file does: two
// processes writing at once lose nothing, a file of a newer version reads and refuses writes, a read-only open reads,
// and the daily backup is written once a day with the newest seven kept.
import { Database } from "bun:sqlite"
import { expect } from "bun:test"
import { fileURLToPath, Glob, resolveSync, spawn, spawnSync, write } from "bun"
import { Context, Effect, Layer, Option, type Scope } from "effect"
import { Digest } from "effect/crypto"
import * as Seed from "../../../sim/seed.ts"
import { platform } from "../node/platform.ts"
import { gitInit, withProcessEnv } from "../../../tests/git-repo.ts"
import { scratch as scratchDir } from "../../../tests/scratch.ts"
import { commitmentRecordLaws } from "../laws.ts"
import { type Actor, COLUMNS, Command, EMPTY, fold } from "../record.ts"
import { CommitmentRecord } from "../service.ts"
import type * as SqliteRecord from "./record.ts"
import { BACKUPS_KEPT, connected, keyOfCheckout, layer, layerOrFailed, MIGRATIONS, pathOf, stateDir, textColumnsOf, VERSION } from "./record.ts"

const T0 = 1_800_000_000_000
const DAY = 86_400_000

const scratch = Effect.map(
  Effect.acquireRelease(
    Effect.sync(() => scratchDir("record-store-")),
    (dir) => Effect.sync(() => dir[Symbol.dispose]()),
  ),
  (dir) => dir.path,
)

commitmentRecordLaws(
  "the SQLite record",
  Effect.map(scratch, (dir) => Layer.orDie(layer(`${dir}/state/repo.db`, { readonly: false, now: T0 })).pipe(Layer.provide(platform))),
)

/** A body over a scratch directory, removed after. */
const inScratch = <A, E>(body: (dir: string) => Effect.Effect<A, E, SqliteRecord.Platform | Scope.Scope>) => Effect.scoped(Effect.flatMap(scratch, body)).pipe(Effect.provide(platform))

const add = (id: string) => Command.cases.add.make({ run: "r1", sourceKind: "plan-part", sourceRef: "plan.md:1", parts: [{ id, title: `part ${id}` }] })
const ROOT: Actor = { id: "ses_root", role: "root" }
/** This folder's store module, as a writer process imports it. */
const STORE = fileURLToPath(import.meta.resolve("./record.ts"))
/** The platform the writer provides its open. */
const PLATFORM = fileURLToPath(import.meta.resolve("../node/platform.ts"))

Seed.effect(
  "the file is under XDG_STATE_HOME, else ~/.local/state",
  Effect.gen(function* () {
    expect(yield* pathOf(Option.some("/state"), "github.com-cevr-dotfiles")).toBe("/state/opencode-orchestrate/github.com-cevr-dotfiles.db")
    expect(yield* stateDir(Option.some(""))).toEndWith("/.local/state/opencode-orchestrate")
    expect(yield* stateDir(Option.none())).toEndWith("/.local/state/opencode-orchestrate")
  }).pipe(Effect.provide(platform)),
)

/** A writer process: opens its own connection and adds `count` commitments named `<name>-<i>`, one transaction each. */
const writer = `import { connected } from "${STORE}"
import { platform } from "${PLATFORM}"
import { Command } from "${STORE.replace(/sqlite\/record\.ts$/, "record.ts")}"
import { Effect, Exit } from "${resolveSync("effect", STORE)}"
const [path, name, count] = process.argv.slice(2)
const opened = await Effect.runPromise(connected(path, { readonly: false, now: ${T0} }).pipe(Effect.provide(platform)))
for (let at = 0; at < Number(count); at++) {
  const command = Command.cases.add.make({ run: "r1", sourceKind: "plan-part", sourceRef: "plan.md:1", parts: [{ id: name + "-" + at, title: "part" }] })
  const exit = Effect.runSyncExit(opened.store.run(command, { actor: { id: name, role: "root" }, now: ${T0} + at }))
  if (Exit.isFailure(exit)) { console.error(String(exit.cause)); process.exit(1) }
}
opened.close()
`

/** A writer process on the file at `path`, adding 100 commitments as `name`. */
const started = (script: string, path: string, name: string) => spawn(["bun", script, path, name, "100"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })

/** A process's exit code and what it wrote to stderr. */
const ended = (run: ReturnType<typeof started>) =>
  Effect.all({ code: Effect.promise(() => run.exited), errors: Effect.promise(() => new Response(run.stderr).text()) }, { concurrency: 2 })

Seed.effect("two processes writing 200 interleaved commands to one file lose none, and the replay law holds after",
  inScratch((dir) =>
    Effect.gen(function* () {
      const path = `${dir}/repo.db`
      const script = `${dir}/writer.ts`
      yield* Effect.promise(() => write(script, writer))
      const runs = ["one", "two"].map((name) => started(script, path, name))
      const outcomes = yield* Effect.forEach(runs, ended, { concurrency: 2 })
      expect(outcomes).toEqual([
        { code: 0, errors: "" },
        { code: 0, errors: "" },
      ])
      const opened = yield* connected(path, { readonly: true, now: T0 })
      const snapshot = yield* opened.store.read
      const events = yield* opened.store.events
      opened.close()
      expect(snapshot.commitments.size).toBe(200)
      expect(events.length).toBe(200)
      expect(fold(EMPTY, events)).toEqual(snapshot)
    }),
  ))

Seed.effect("a file of a newer version than this code reads, and refuses every write with the version it needs",
  inScratch((dir) =>
    Effect.gen(function* () {
      const path = `${dir}/repo.db`
      const first = yield* connected(path, { readonly: false, now: T0 })
      yield* first.store.run(add("kept-1"), { actor: ROOT, now: T0 })
      first.close()
      const raw = new Database(path)
      raw.run(`PRAGMA user_version = ${VERSION + 1}`)
      raw.close()
      const newer = yield* connected(path, { readonly: false, now: T0 })
      const refused = yield* Effect.flip(newer.store.run(add("kept-2"), { actor: ROOT, now: T0 }))
      expect(refused._tag).toBe("RecordFailed")
      expect(refused.message).toContain(`version ${VERSION + 1}; this code writes version ${VERSION}`)
      expect([...(yield* newer.store.read).commitments.keys()]).toEqual(["kept-1"])
      newer.close()
    }),
  ))

for (const from of [1, 2])
  Seed.effect(`a version ${from} file migrates to this version on open: its rows kept, a lane made before has no lane path or start, a lane made after keeps both`,
  inScratch((dir) =>
    Effect.gen(function* () {
      const path = `${dir}/repo.db`
      // A file as version `from` code left it: its statements alone, one lane's commitment, its user_version.
      const raw = new Database(path, { create: true, strict: true })
      for (const statement of MIGRATIONS.slice(0, from).flat()) raw.run(statement)
      raw.run(`PRAGMA user_version = ${from}`)
      raw.run(
        "INSERT INTO commitment (id, run, title, source_kind, source_ref, owner_lane, state, started_at, review_by, created_at, updated_at) VALUES ('old-unit', 'r1', 'land unit old-unit', 'assignment', 'orchestrate lane old-unit', 'old-unit', 'open', '2027-01-15T08:00:00.000Z', '2027-01-22T08:00:00.000Z', '2027-01-15T08:00:00.000Z', '2027-01-15T08:00:00.000Z')",
      )
      raw.close()
      const opened = yield* connected(path, { readonly: false, now: T0 })
      yield* opened.store.run(Command.cases.lane.make({ run: "r1", unit: "new-unit", startHead: Option.some("a".repeat(40)), path: Option.some("/w/new-unit") }), { actor: ROOT, now: T0 })
      opened.close()
      const check = new Database(path, { readonly: true })
      const version = check.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version
      check.close()
      expect([VERSION, version]).toEqual([MIGRATIONS.length, MIGRATIONS.length])
      const again = yield* connected(path, { readonly: false, now: T0 })
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

Seed.effect("a read-only open reads what a writer wrote and refuses writes; a reopened store sees the same rows",
  inScratch((dir) =>
    Effect.gen(function* () {
      const path = `${dir}/repo.db`
      const writing = yield* connected(path, { readonly: false, now: T0 })
      yield* writing.store.run(add("ro-1"), { actor: ROOT, now: T0 })
      const reading = yield* connected(path, { readonly: true, now: T0 })
      expect([...(yield* reading.store.read).commitments.keys()]).toEqual(["ro-1"])
      const refused = yield* Effect.flip(reading.store.run(add("ro-2"), { actor: ROOT, now: T0 }))
      expect(refused._tag).toBe("RecordFailed")
      reading.close()
      writing.close()
      const again = yield* connected(path, { readonly: false, now: T0 })
      expect([...(yield* again.store.read).commitments.keys()]).toEqual(["ro-1"])
      again.close()
    }),
  ))

Seed.effect("the daily backup is written at a day's first open only, and the eighth day's prunes the oldest",
  inScratch((dir) =>
    Effect.gen(function* () {
      const path = `${dir}/repo.db`
      const days = Array.from({ length: BACKUPS_KEPT + 1 }, (_, at) => T0 + at * DAY)
      for (const now of days) {
        const opened = yield* connected(path, { readonly: false, now })
        yield* opened.store.run(add(`day-${now}`), { actor: ROOT, now })
        opened.close()
        const later = yield* connected(path, { readonly: false, now: now + 1_000 })
        later.close()
      }
      const kept = Array.from(new Glob("*").scanSync(`${dir}/backup`)).toSorted()
      expect(kept).toHaveLength(BACKUPS_KEPT)
      expect([kept.at(0), kept.at(-1)]).toEqual(["repo-2027-01-16.db", "repo-2027-01-22.db"])
      // Each backup is a whole database: the last holds every row written before its day's first open.
      const last = new Database(`${dir}/backup/repo-2027-01-22.db`, { readonly: true })
      expect(last.query("SELECT count(*) AS n FROM commitment").get()).toEqual({ n: BACKUPS_KEPT })
      last.close()
    }),
  ))

Seed.effect("a repository with no origin: its workspace, a subfolder and the base share one key; another repository has its own",
  inScratch((dir) =>
    Effect.gen(function* () {
      const env = withProcessEnv({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" })
      const init = (path: string) =>
        Effect.map(Effect.promise(() => write(`${path}/sub/f`, path)), () => {
          gitInit(path, ["-q", "-b", "main"], env)
          for (const args of [["add", "-A"], ["commit", "-q", "-m", "root"]]) spawnSync(["git", "-C", path, ...args], { env, stdout: "ignore", stderr: "ignore" })
        })
      const base = `${dir}/repo`
      yield* init(base)
      // A workspace as `work` makes one: a copy of the base, laid out beside it.
      const workspace = `${dir}/.work/repo/lane-1`
      expect([spawnSync(["mkdir", "-p", `${dir}/.work/repo`]).exitCode, spawnSync(["cp", "-R", base, workspace]).exitCode]).toEqual([0, 0])
      const other = `${dir}/other`
      yield* init(other)
      const keys = yield* Effect.forEach([base, `${base}/sub`, workspace, `${workspace}/sub`], keyOfCheckout)
      expect(new Set(keys).size).toBe(1)
      expect(keys[0]).toStartWith("local-")
      expect(yield* keyOfCheckout(other)).not.toBe(keys[0])
    }),
  ))

Seed.effect("the boundary's column map names exactly the file's TEXT columns: a new column fails here until it is given a kind",
  inScratch((dir) =>
    Effect.gen(function* () {
      const made = yield* connected(`${dir}/repo.db`, { readonly: false, now: T0 })
      made.close()
      const db = new Database(`${dir}/repo.db`, { readonly: true })
      const columns = textColumnsOf(db)
      db.close()
      expect(columns.toSorted()).toEqual(Object.keys(COLUMNS).toSorted())
    }),
  ))

Seed.effect("a free-text field past its bound is refused whole, naming the column",
  inScratch((dir) =>
    Effect.gen(function* () {
      const opened = yield* connected(`${dir}/repo.db`, { readonly: false, now: T0 })
      const long = yield* Effect.flip(opened.store.run(Command.cases.add.make({ run: "r1", sourceKind: "follow-up", sourceRef: "x", plan: Option.some("p".repeat(2_000_000)), parts: [{ id: "s3", title: "t" }] }), { actor: ROOT, now: T0 }))
      const events = yield* opened.store.events
      opened.close()
      expect([long, events.length]).toMatchObject([{ reason: "column commitment.plan is 2000000 characters, more than 200" }, 0])
    }),
  ))

Seed.effect(
  "the repository key's digest is SHA-256 (a known vector), so a file named before this code keeps its name",
  Effect.gen(function* () {
    const digest = yield* Digest.Digest
    expect(yield* digest.digestHex(Digest.sha256, new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  }).pipe(Effect.provide(platform)),
)

Seed.effect(
  "the plugin's record (layerOrFailed on the platform) makes its folder, opens, writes and keeps the day's backup; a file it cannot open refuses every call",
  inScratch((dir) =>
    Effect.gen(function* () {
      const path = `${dir}/state/deep/repo.db`
      const live = Context.get(yield* Layer.build(layerOrFailed(Effect.succeed(path))), CommitmentRecord)
      const done = yield* live.run(add("live-1"), { actor: ROOT, now: T0 })
      expect([...done.snapshot.commitments.keys()]).toEqual(["live-1"])
      expect(Array.from(new Glob("*").scanSync(`${dir}/state/deep/backup`))).toHaveLength(1)
      // Under a file, no folder can be made: the record refuses every call, naming why, and the plugin still starts.
      const dead = Context.get(yield* Layer.build(layerOrFailed(Effect.succeed("/dev/null/loop-probe-x/repo.db"))), CommitmentRecord)
      const failed = yield* Effect.flip(dead.read)
      expect(failed._tag).toBe("RecordFailed")
    }),
  ))
