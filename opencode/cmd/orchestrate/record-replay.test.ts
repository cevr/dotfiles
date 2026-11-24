// The actual CLI and registered tool share the durable retry rule. Scratch artifact changes cannot turn
// "filed already" into an evidence error or create another promise.
import { Database } from "bun:sqlite"
import { expect } from "bun:test"
import { file, spawnSync, write } from "bun"
import { Array as Arr, Effect, FileSystem, Layer, Match, Option, Ref, Schema } from "effect"
import { evidenceOf, noEvidence, type ReceiptSeen } from "@dotfiles/opencode-orchestrate/reasons"
import { ACTIONS } from "@dotfiles/opencode-orchestrate/commitments-tool"
import { Command, isoOf } from "@dotfiles/opencode-orchestrate/record"
import { CommitmentRecord, Evidence } from "@dotfiles/opencode-orchestrate/service"
import * as Sqlite from "@dotfiles/opencode-orchestrate/sqlite/record"
import { platform } from "@dotfiles/opencode-orchestrate/node/platform"
import { hostServices } from "../../sim/host-services.ts"
import { simulationTest } from "../../sim/seed.ts"
import { gitInit, withProcessEnv } from "../../tests/git-repo.ts"
import { scratch } from "../../tests/scratch.ts"
import { boot, type Input, WORK } from "./orch-tools-world.ts"
import { main } from "./record.ts"

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Json))
const NOW = 1_800_000_000_000
const DAY = 86_400_000
const CHECKOUT = "a".repeat(40)
const pathAt = (at: number) => `tmp/orchestrate/r${at}.json`
const envelope = (exit: number) => json({ receipt: 1, command: "synthetic check", exit, output: { value: "a result" }, run: "one", checkout: CHECKOUT })
const receiptClaim = (at: number) => ({ id: `receipt-${at}`, key: `key-r${at}`, title: "Read a result", reason_class: "measured", referent: { kind: "receipt", path: pathAt(at) } })
const dependency = (id: string, target: string) => ({ id, key: `key-${id}`, title: "Wait on work", reason_class: "dependency", referent: { kind: "commitment", id: target } })
const receiptSeen = (path: string): ReceiptSeen => ({ path, receiptSha: "b".repeat(64), outputSha: "c".repeat(64), run: "one", checkout: CHECKOUT, exit: 1 })
const cli = (dir: string, db: string) => (action: string, fields: Input) =>
  main([action, "--file", db, "--actor", "scratch-actor", "--json", json(fields)], dir)
const promised = (history: string): number => history.split("\n").filter((line) => line.includes(" promised ")).length
const steps = ["unchanged", "replaced", "archived", "moved", "deleted"] as const

const writes = (from: string): ReadonlyArray<readonly [string, Input]> => [
  ["add", { source_kind: "plan-part", source_ref: "p:2", parts: [{ id: "new", title: "new" }] }],
  ["assign", { id: "base", owner_lane: "lane-two" }],
  ["order", { owner_lane: "lane", ids: ["base"] }],
  ["release", { id: "base" }],
  ["decide", { id: "base", why: "done", reason_class: "guarantee", referent: { kind: "invariant", id: "guard" } }],
  ["defer", { id: "base", reason_class: "dependency", referent: { kind: "commitment", id: "other" } }],
  ["reopen", { id: "closed" }],
  ["word", { word: "go" }],
  ["route", { hand_back: 1, as: "routed" }],
  ["landed", { id: "base", head: CHECKOUT }],
  ["invariant", { id: "new-guard", doc_path: "docs/record.md", anchor: "guard" }],
  ["import", { from, map: "ergo-register" }],
  ["follow_up", dependency("finding", "base")],
]

simulationTest("every CLI and registered commitments write refuses a future file without changing its history", Effect.scoped(Effect.gen(function* () {
  using dir = scratch("record-version-ingress-")
  const path = `${dir.path}/record.db`
  const from = `${dir.path}/register.db`
  const docPath = "docs/record.md"
  const observed = { path: docPath, blob: "b".repeat(40), commit: CHECKOUT }
  {
    using register = new Database(from)
    register.run("CREATE TABLE commitment (id TEXT); CREATE TABLE event (seq INTEGER); CREATE TABLE prerequisite (ref TEXT)")
  }
  const env = withProcessEnv({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" })
  gitInit(dir.path, ["-q", "-b", "main"], env)
  yield* Effect.promise(() => write(`${dir.path}/${docPath}`, "# Fixture guard\n"))
  for (const args of [["add", docPath], ["commit", "-q", "-m", "fixture"]]) expect(spawnSync(["git", "-C", dir.path, ...args], { env }).exitCode).toBe(0)
  const current = yield* Sqlite.connected(path, { readonly: false, now: NOW })
  const ctx = { actor: { id: "fixture-root", role: "root" } as const, now: NOW }
  yield* current.store.run(Command.cases.add.make({ run: "one", sourceKind: "plan-part", sourceRef: "p:1", parts: [{ id: "base", title: "pending", ownerLane: Option.some("lane") }, { id: "other", title: "pending" }, { id: "closed", title: "past" }] }), ctx)
  yield* current.store.run(Command.cases.invariant.make({ id: "guard", anchor: "guard", observed }), ctx)
  yield* current.store.run(Command.cases.decide.make({ id: "closed", why: "held", reason: { reasonClass: "guarantee", referent: "invariant/guard" } }), ctx)
  const held = yield* boot(1, true, {}, () => Layer.merge(
    Layer.succeed(CommitmentRecord, current.store),
    Layer.succeed(Evidence, evidenceOf(new Map(), new Map([[docPath, observed]]))),
  ))
  const root = yield* held.world.session(WORK)
  const child = yield* held.world.session(WORK, { parentID: root })
  {
    using migration = new Database(path)
    migration.transaction(() => migration.run(`PRAGMA user_version = ${Sqlite.VERSION + 1}`)).immediate()
  }
  const before = yield* current.store.events
  const rows = writes(from)
  expect(rows.map(([action]) => action).sort()).toEqual([...ACTIONS.filter((action) => action !== "list" && action !== "history"), "follow_up"].sort())
  const message = `version ${Sqlite.VERSION + 1}; this code writes version ${Sqlite.VERSION}`
  for (const [action, fields] of rows) {
    const result = yield* cli(dir.path, path)(action, fields)
    expect([action, result.code, result.err]).toEqual([action, 1, expect.stringContaining(message)])
    const probe = yield* Match.value(action).pipe(
      Match.when("follow_up", () => held.probe(child, "follow_up", fields)),
      Match.orElse(() => held.probe(root, "commitments", { ...fields, action })),
    )
    expect([action, probe.error, probe.text]).toEqual([action, true, expect.stringContaining(message)])
    expect(yield* current.store.events).toEqual(before)
  }
  current.close()
})).pipe(Effect.provide(Layer.merge(hostServices, platform))))

/** Named command: bun test cmd/orchestrate/record-replay.test.ts -t '20 exact replays' */
simulationTest("20 exact replays ignore receipt lifecycle through the CLI and registered tool", Effect.scoped(Effect.gen(function* () {
  using dir = scratch("record-evidence-replay-")
  gitInit(dir.path, ["-q", "-b", "main"], withProcessEnv({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }))
  const db = `${dir.path}/record.db`
  const call = cli(dir.path, db)
  const fs = yield* FileSystem.FileSystem
  const receipts = yield* Ref.make<ReadonlyMap<string, ReceiptSeen>>(new Map())
  const reads = yield* Ref.make(0)
  const supplied = Layer.succeed(Evidence, Evidence.of({
    receipt: (checkout, path) => Effect.gen(function* () {
      yield* Ref.update(reads, (n) => n + 1)
      return yield* evidenceOf(yield* Ref.get(receipts), new Map()).receipt(checkout, path)
    }),
    document: () => Effect.die("the receipt matrix reads no documents"),
  }))
  const run = yield* boot(1, true, {}, () => Layer.merge(Sqlite.layerScratch(`${dir.path}/tool.db`), supplied))
  const root = yield* run.world.session(WORK)
  const child = yield* run.world.session(WORK, { parentID: root })
  let cases = 0
  for (const at of Arr.range(0, 9)) {
    const input = receiptClaim(at)
    const path = pathAt(at)
    const full = `${dir.path}/${path}`
    yield* Effect.promise(() => write(full, envelope(1)))
    yield* Ref.set(receipts, new Map([[path, receiptSeen(path)]]))
    expect((yield* call("follow_up", input)).code).toBe(0)
    expect((yield* run.probe(child, "follow_up", input)).error).toBe(false)
    const before = yield* call("follow_up", input)
    const toolBefore = yield* run.probe(child, "follow_up", input)
    expect(before.out).toContain("filed already")
    expect(toolBefore.text).toContain("filed already")
    const readCount = yield* Ref.get(reads)
    expect(readCount).toBe(at + 1)
    const step = steps[at % steps.length]
    if (step === "replaced") {
      yield* Effect.promise(() => write(full, envelope(0)))
      yield* Ref.set(receipts, new Map([[path, { ...receiptSeen(path), exit: 0 }]]))
    }
    if (step === "archived") yield* fs.rename(full, `${dir.path}/archive-${at}.json`)
    if (step === "moved") yield* fs.rename(full, `${dir.path}/tmp/orchestrate/moved-${at}.json`)
    if (step === "deleted") yield* fs.remove(full)
    if (step === "archived" || step === "moved" || step === "deleted") yield* Ref.set(receipts, new Map())
    expect(yield* call("follow_up", input)).toEqual(before)
    expect((yield* run.probe(child, "follow_up", input)).text).toEqual(toolBefore.text)
    expect(yield* Ref.get(reads)).toBe(readCount)
    expect(promised((yield* call("history", { id: input.id })).out)).toBe(1)
    expect(promised((yield* run.probe(root, "commitments", { action: "history", id: input.id })).text)).toBe(1)
    cases += 2
  }
  expect(cases).toBe(20)
})).pipe(Effect.provide(hostServices)))

simulationTest("the CLI and registered tool replay after the original commitment dependency closes or reopens", Effect.scoped(Effect.gen(function* () {
  using dir = scratch("record-dependency-replay-")
  const path = `${dir.path}/record.db`
  const opened = yield* Sqlite.connected(path, { readonly: false, now: NOW })
  const actor = { id: "fixture-root", role: "root" } as const
  const store = opened.store
  yield* store.run(Command.cases.add.make({ run: "one", sourceKind: "plan-part", sourceRef: "p:1", parts: [{ id: "base", title: "pending" }] }), { actor, now: NOW })
  yield* store.run(Command.cases.invariant.make({ id: "guard", anchor: "guard", observed: { path: "docs/record.md", blob: "b".repeat(40), commit: CHECKOUT } }), { actor, now: NOW })
  const run = yield* boot(1, true, {}, () => Layer.merge(Sqlite.layerScratch(path), noEvidence))
  const root = yield* run.world.session(WORK)
  const child = yield* run.world.session(WORK, { parentID: root })
  const call = cli(dir.path, path)
  const cliInput = dependency("cli-finding", "base")
  const toolInput = dependency("tool-finding", "base")
  expect((yield* call("follow_up", cliInput)).code).toBe(0)
  expect((yield* run.probe(child, "follow_up", toolInput)).error).toBe(false)
  const cliBefore = yield* call("follow_up", cliInput)
  const toolBefore = yield* run.probe(child, "follow_up", toolInput)
  const close = Command.cases.decide.make({ id: "base", why: "the invariant holds", reason: { reasonClass: "guarantee", referent: "invariant/guard" } })
  const reopen = Command.cases.reopen.make({ id: "base" })
  for (const command of [close, reopen]) {
    yield* store.run(command, { actor, now: NOW })
    expect(yield* call("follow_up", cliInput)).toEqual(cliBefore)
    const after = yield* run.probe(child, "follow_up", toolInput)
    expect([after.error, after.text]).toEqual([false, toolBefore.text])
    expect(promised((yield* call("history", { id: cliInput.id })).out)).toBe(1)
    expect(promised((yield* run.probe(root, "commitments", { action: "history", id: toolInput.id })).text)).toBe(1)
  }
  opened.close()
})).pipe(Effect.provide(Layer.merge(hostServices, platform))))

/** Named command: bun test cmd/orchestrate/record-replay.test.ts -t 'backup and restore' */
simulationTest("backup and restore retains keyed replay without the measured receipt", Effect.gen(function* () {
  using dir = scratch("record-restore-retry-")
  const db = `${dir.path}/record.db`
  const restored = `${dir.path}/restored.db`
  const input = receiptClaim(1)
  gitInit(dir.path, ["-q", "-b", "main"], withProcessEnv({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }))
  yield* Effect.promise(() => write(`${dir.path}/${pathAt(1)}`, envelope(1)))
  expect((yield* cli(dir.path, db)("follow_up", input)).code).toBe(0)
  const expected = yield* cli(dir.path, db)("follow_up", input)
  const next = yield* Sqlite.connected(db, { readonly: false, now: NOW + DAY })
  next.close()
  const day = isoOf(NOW + DAY).slice(0, 10)
  yield* Effect.promise(() => write(restored, file(`${dir.path}/backup/record-${day}.db`)))
  const fs = yield* FileSystem.FileSystem
  yield* fs.remove(`${dir.path}/${pathAt(1)}`)
  const replay = yield* cli(dir.path, restored)("follow_up", input)
  expect(replay).toEqual(expected)
  expect(replay.out).toContain("filed already")
  expect((yield* cli(dir.path, restored)("follow_up", { ...input, title: "different" })).err).toContain("saying something else")
  expect(promised((yield* cli(dir.path, restored)("history", { id: input.id })).out)).toBe(1)
}).pipe(Effect.provide(Layer.merge(hostServices, platform))))
