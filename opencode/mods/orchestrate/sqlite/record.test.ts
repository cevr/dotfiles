// The SQLite record keeps the CommitmentRecord laws (laws.ts) on a scratch file, and what only a file does: two
// processes writing at once lose nothing, a file of a newer version reads and refuses writes, a read-only open reads,
// and the daily backup is written once a day with the newest seven kept.
import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Option } from "effect"
import { commitmentRecordLaws } from "../laws.ts"
import { type Actor, Command, EMPTY, fold } from "../record.ts"
import { BACKUPS_KEPT, connectSync, layer, pathOf, stateDir, VERSION } from "./record.ts"

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
