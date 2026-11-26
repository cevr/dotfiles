// @reads all
// @reads-reason subprocess reads at cmd/orchestrate/receipt-input-snapshot.sim.test.ts: check(yield* Effect.sync(() => spawnSync(["mkfifo", path.join(receipts, `${outerTree}.round.jso
// A review's inputs frozen from receipts (mods/orchestrate/batch-input.ts), through the producers' own formats
// (batch-inputs.ts: Work's receipt and land record schemas, the updater's record), at 20 seeds. The source is a
// script of whole file states, one served per read, so a test sees what a reader racing an install, a land or a
// background accept run sees: a state replaced atomically between two reads, or a torn write. The oracle is the
// script's own meaning of each state (which pair it proves, which tree and exits a receipt holds), never the
// implementation's decode. Replays: 22q's conflicting installed and checkout fork pins, 22s-w and 23a's installed pair
// before and after an install, 23a's lane round receipt nested in a later land whose merge check is the outer head's
// alone, 23b's land and accept on their own clocks with a red accept kept red. Identifiers are synthetic (one repeated
// hex digit); no fixture is a real record. Last, the filestore source against a scratch folder of real files.
import { freeze, type InputConflict, type InputRequest, type InputSnapshot, type InputUnsettled, parseSnapshot, publicView, ReceiptSource, SourceRead, SourceRef, sourceKey, SourceUnreadable, snapshotText } from "@dotfiles/opencode-orchestrate/batch-input"
import { type ReceiptPlaces, receiptSource } from "@dotfiles/opencode-orchestrate/filestore/receipt-source"
import { headsOf } from "@dotfiles/opencode-orchestrate/fleet"
import { mainBatchText } from "@dotfiles/opencode-orchestrate/tools"
import { LandRecordJson, type Receipt, ReceiptJson } from "@dotfiles/opencode-work/receipt"
import * as BunServices from "@effect/platform-bun/BunServices"
import { CryptoHasher, deepEquals, spawnSync } from "bun"
import { expect as check } from "effect-bun-test"
import { Array as Arr, ByteSize, Context, Data, Deferred, Effect, Equal, Exit, type Fiber, FileSystem, Layer, Match, Option, Order, Path, Predicate, Result, Schema, Sink, Stream } from "effect"
import { Digest } from "effect/crypto"
import { ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"
import { simulationRunner, type Seeded as SeedSeeded, simulationTest } from "../../sim/seed.ts"
import { formats, layer } from "./batch-inputs.ts"

const { seeded } = simulationRunner("cmd/orchestrate/receipt-input-snapshot.sim.test.ts")

// The oracle's own full object name: 40 lower-case hex digits (SHA-1) or 64 (SHA-256), branded as a snapshot's names are.
const FullName = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)).pipe(Schema.brand("ObjectName"))
const toName = Schema.decodeSync(FullName)
const isFull = Schema.is(FullName)
const sha = (digit: string) => toName(digit.repeat(40))
const sha256 = (digit: string) => toName(digit.repeat(64))
const HOST = "host-a"
const REPO = "/fixture/dotfiles"
const LANE = "/fixture/dotfiles/.work/lane"
const [installedDotfiles, laneHead, aggregateHead, provenFork, checkoutFork, outerHead, laneTree, outerTree, base] = ["1", "2", "3", "a", "b", "4", "5", "6", "7"].map(sha)

const encodeReceipt = Schema.encodeSync(ReceiptJson)
const encodeLand = Schema.encodeSync(LandRecordJson)

const receiptAt = (head: string, kind: Receipt["kind"], tree: string, codes: ReadonlyArray<number>, at: string, repo: string): Receipt => ({
  repo,
  head,
  tree,
  kind,
  checks: codes.map((code, index) => ({ command: `bun test fixture-${index}.test.ts`, code, seconds: 1 })),
  at,
})
const receipt = (head: string, kind: Receipt["kind"], tree: string, codes: ReadonlyArray<number>, at: string) => receiptAt(head, kind, tree, codes, at, LANE)

/** The updater's record as a fixture writes it: the shape `installed.json` holds (the updater's own schema reads it). */
const FixtureBuild = Schema.Struct({ version: Schema.String, command: Schema.Array(Schema.String), dotfiles: Schema.String, fork: Schema.String })
type FixtureBuild = typeof FixtureBuild.Type
const FixtureRecord = Schema.Struct({
  version: Schema.String,
  command: Schema.Array(Schema.String),
  dotfiles: Schema.String,
  fork: Schema.String,
  good: Schema.optionalKey(FixtureBuild),
  staged: Schema.optionalKey(FixtureBuild),
})
type FixtureRecord = typeof FixtureRecord.Type
const encodeRecord = Schema.encodeSync(Schema.fromJsonString(FixtureRecord))
const encodeOldRecord = Schema.encodeSync(Schema.fromJsonString(Schema.Struct({ version: Schema.String, command: Schema.Array(Schema.String) })))

const build = (dotfiles: string, fork: string): FixtureBuild => ({ version: `2.2.7-prime.${dotfiles.slice(0, 4)}${fork.slice(0, 4)}.tree`, command: ["/fixture/bin/opencode"], dotfiles, fork })

// The script's own install transitions: the updater's semantics, written independently of it.
const installedAs = (each: FixtureBuild, good: Option.Option<FixtureBuild>): FixtureRecord =>
  Option.match(good, {
    onNone: () => ({ version: each.version, command: each.command, dotfiles: each.dotfiles, fork: each.fork }),
    onSome: (proven) => ({ version: each.version, command: each.command, dotfiles: each.dotfiles, fork: each.fork, good: proven }),
  })
const installedBuild = (record: FixtureRecord): FixtureBuild => ({ version: record.version, command: record.command, dotfiles: record.dotfiles, fork: record.fork })
const goodOf = (record: FixtureRecord) => Option.fromNullishOr(record.good)
const staged = (record: FixtureRecord, next: FixtureBuild): FixtureRecord => ({ ...record, staged: next })
const promoted = (record: FixtureRecord): FixtureRecord => Option.match(Option.fromNullishOr(record.staged), { onNone: () => record, onSome: (next) => installedAs(next, goodOf(record)) })
const provenNow = (record: FixtureRecord): FixtureRecord => installedAs(installedBuild(record), Option.some(installedBuild(record)))
const rolledBack = (record: FixtureRecord): FixtureRecord => Option.match(goodOf(record), { onNone: () => record, onSome: (good) => installedAs(good, Option.some(good)) })

/** The pair a record proves, by the script's meaning: its installed build is its good build, field for field. */
const provenPair = (record: FixtureRecord): Option.Option<{ readonly dotfiles: string; readonly fork: string }> =>
  Option.map(
    Option.filter(goodOf(record), (good) => good.version === record.version && good.dotfiles === record.dotfiles && good.fork === record.fork),
    (good) => ({ dotfiles: good.dotfiles, fork: good.fork }),
  )

/** What one file holds in one state of the script: text, a file the source refuses (with its reason), or a read that fails. */
type Entry = Data.TaggedEnum<{ Text: { readonly text: string }; Refused: { readonly reason: string }; Broken: {} }>
const Entry = Data.taggedEnum<Entry>()

type State = ReadonlyMap<string, Entry>

/** A script: the whole file states the source moves through, one per read from the first, the last one held; and what each read served. */
interface Script {
  readonly states: ReadonlyArray<State>
  readonly served: Array<{ readonly key: string; readonly state: number; readonly entry: Option.Option<Entry> }>
}

const inRepo = (checkout: string) => checkout === REPO || checkout.startsWith(`${REPO}/`)
const NO_FILES: State = new Map()

/** The scripted source: each read is served from the state at its index, then the script moves on. */
const scripted = (script: Script) =>
  Layer.succeed(
    ReceiptSource,
    ReceiptSource.of({
      host: HOST,
      repository: "dotfiles",
      repositoryOf: (checkout) => Option.map(Option.liftPredicate(checkout, inRepo), () => "dotfiles"),
      read: (ref: SourceRef) =>
        Effect.suspend(() => {
          const index = Math.min(script.served.length, script.states.length - 1)
          const key = sourceKey(ref)
          const entry = Option.fromNullishOr(Option.getOrElse(Arr.get(script.states, index), () => NO_FILES).get(key))
          script.served.push({ key, state: index, entry })
          return serve(key, entry)
        }),
    }),
  )

/** What a read of a file in a state answers. */
const serve = (key: string, entry: Option.Option<Entry>): Effect.Effect<SourceRead, SourceUnreadable> =>
  Option.match(entry, {
    onNone: () => Effect.succeed(SourceRead.Absent()),
    onSome: Entry.$match({
      Text: (each) => Effect.succeed(SourceRead.Present({ text: each.text })),
      Refused: (each) => Effect.succeed(SourceRead.Refused({ reason: each.reason })),
      Broken: () => Effect.fail(new SourceUnreadable({ source: key, message: "fixture I/O failure" })),
    }),
  })

/** One freeze over a script: its outcome, and what each read served. */
const run = (states: ReadonlyArray<State>, request: InputRequest) =>
  Effect.suspend(() => {
    const script: Script = { states, served: [] }
    return Effect.result(freeze(request)).pipe(
      Effect.provide(Layer.mergeAll(scripted(script), formats, Digest.layerWebCrypto)),
      Effect.map((outcome) => ({ outcome, served: script.served })),
    )
  })

/** A freeze that must settle: its snapshot. */
const frozen = (states: ReadonlyArray<State>, request: InputRequest) => Effect.flatMap(run(states, request), ({ outcome }) => Effect.orDie(Effect.fromResult(outcome)))

/** A snapshot's install state in words: whose proven pair, or why none. */
const installWords = (snapshot: InputSnapshot): string =>
  Option.match(Option.fromNullishOr(snapshot.install), {
    onNone: () => "not asked",
    onSome: (install) =>
      Match.value(install).pipe(
        Match.tag("Proven", (proven) => `proven on ${proven.receipt.host}: ${proven.receipt.buildId} dotfiles=${proven.receipt.dotfiles} fork=${proven.receipt.fork}`),
        Match.tag("Unavailable", (none) => `unavailable on ${none.host}: ${none.reason}`),
        Match.exhaustive,
      ),
  })

/** A freeze's failure in words, none when it settled. */
const failureWords = (outcome: Result.Result<InputSnapshot, InputConflict | InputUnsettled>): Option.Option<string> =>
  Result.match(outcome, {
    onSuccess: () => Option.none(),
    onFailure: (error) =>
      Option.some(
        Match.value(error).pipe(
          Match.tag("InputConflict", (conflict) => `conflict ${conflict.key}`),
          Match.tag("InputUnsettled", (unsettled) => `unsettled ${unsettled.source}: ${unsettled.reason}`),
          Match.exhaustive,
        ),
      ),
  })

const text = (value: string) => Entry.Text({ text: value })
const files = (entries: ReadonlyArray<readonly [string, Entry]>): State => new Map(entries)
const installOnly: InputRequest = { receipts: [], lands: [], install: true }
const installedFile = (record: FixtureRecord) => files([["installed", text(encodeRecord(record))]])

seeded("22q characterisation, which unit C turns over: today's brief renders one pair and its parser hands back the checkout's fork pin, while the frozen install receipt is the proven installed pair", ({ expect }) =>
  Effect.gen(function* () {
    // Today's renderer and target parser, run on 22q's shape: the installed build proved fork `a`, the fork checkout was at `b`.
    const brief = mainBatchText({ name: "batch-fixture", base: installedDotfiles, head: laneHead, last: Option.none(), merges: [], units: [], heads: Option.some({ dotfiles: laneHead, fork: checkoutFork }) })
    expect(brief).not.toContain("Installed:")
    expect(headsOf(brief)).toEqual(Result.succeed({ dotfiles: laneHead, fork: checkoutFork }))
    // The frozen receipt reads the updater's record: the proven pair, whatever a checkout or a brief says.
    const proven = build(installedDotfiles, provenFork)
    const snapshot = yield* frozen([installedFile(installedAs(proven, Option.some(proven)))], installOnly)
    expect(installWords(snapshot)).toBe(`proven on ${HOST}: ${proven.version} dotfiles=${installedDotfiles} fork=${provenFork}`)
  }),
)

seeded("22s-w and 23a: the installed pair before and after an install: a stage proves nothing, a promotion is unproven, the health check proves the new pair, a rollback the old one", ({ expect }) =>
  Effect.gen(function* () {
    const before = build(installedDotfiles, provenFork)
    const after = build(laneHead, provenFork)
    const start = installedAs(before, Option.some(before))
    const promotion = promoted(staged(start, after))
    const steps = [start, staged(start, after), promotion, provenNow(promotion), rolledBack(promotion)]
    const seen = yield* Effect.forEach(steps, (record) => Effect.map(frozen([installedFile(record)], installOnly), installWords))
    expect(seen).toEqual([
      `proven on ${HOST}: ${before.version} dotfiles=${installedDotfiles} fork=${provenFork}`,
      `proven on ${HOST}: ${before.version} dotfiles=${installedDotfiles} fork=${provenFork}`,
      `unavailable on ${HOST}: unproven`,
      `proven on ${HOST}: ${after.version} dotfiles=${laneHead} fork=${provenFork}`,
      `proven on ${HOST}: ${before.version} dotfiles=${installedDotfiles} fork=${provenFork}`,
    ])
    // The proof a review used stays its bytes: the record moving on changes no frozen snapshot.
    const first = yield* frozen([installedFile(start)], installOnly)
    const bytes = snapshotText(first)
    const later = yield* frozen([installedFile(provenNow(promotion))], installOnly)
    expect(snapshotText(first)).toBe(bytes)
    expect(Option.map(parseSnapshot(bytes), snapshotText)).toEqual(Option.some(bytes))
    expect(later.id).not.toBe(first.id)
    // No record, an old record naming no commits, and a record that does not decode: no pair, each with why.
    const old = text(encodeOldRecord({ version: "2.2.5", command: ["/fixture/bin/opencode"] }))
    const reasons = yield* Effect.forEach([NO_FILES, files([["installed", old]]), files([["installed", text('{"version":')]])], (state) =>
      Effect.map(frozen([state], installOnly), installWords),
    )
    expect(reasons).toEqual([`unavailable on ${HOST}: missing`, `unavailable on ${HOST}: unnamed`, `unavailable on ${HOST}: corrupt`])
  }),
)

const byHead = Order.mapInput(Order.String, (row: { readonly head: string; readonly kind: string }) => `${row.head}.${row.kind}`)

seeded("23a: a lane's round receipt nested in a later land is evidence of the lane head; the land's merge check is the outer head's alone", ({ expect }) =>
  Effect.gen(function* () {
    const round = receipt(laneHead, "round", laneTree, [0, 0], "2026-11-22T01:00:00.000Z")
    const merge = receiptAt(outerHead, "merge", outerTree, [0], "2026-11-22T02:00:00.000Z", `${REPO}/.work/integrate`)
    const land = encodeLand({ head: outerHead, base, units: [{ branch: "feat/lane", path: LANE, receipt: round, by: "held" }], merge: Option.some(merge), at: "2026-11-22T02:01:00.000Z" })
    const state = files([
      [`land:${outerHead}`, text(land)],
      [`receipt:${laneHead}.round`, text(encodeReceipt(round))],
      [`receipt:${outerHead}.accept`, text(encodeReceipt(receipt(outerHead, "accept", outerTree, [0], "2026-11-22T02:30:00.000Z")))],
    ])
    const request: InputRequest = {
      receipts: [
        { head: laneHead, kind: "round" },
        { head: laneHead, kind: "merge" },
        { head: outerHead, kind: "merge" },
        { head: outerHead, kind: "accept" },
      ],
      lands: [outerHead],
      install: false,
    }
    const snapshot = yield* frozen([state], request)
    const rows = snapshot.receipts.map((each) => ({ head: each.input.head, kind: `${each.input.kind}`, tree: each.input.tree, sources: each.sources }))
    expect(Arr.sort(rows, byHead)).toEqual(
      Arr.sort(
        [
          { head: laneHead, kind: "round", tree: laneTree, sources: [`land:${outerHead}`, `receipt:${laneHead}.round`] },
          { head: outerHead, kind: "merge", tree: outerTree, sources: [`land:${outerHead}`] },
          { head: outerHead, kind: "accept", tree: outerTree, sources: [`receipt:${outerHead}.accept`] },
        ],
        byHead,
      ),
    )
    // No merge check of the lane head exists, and no cached one of the outer head: both stay absent (owed), never the land's proof moved onto them.
    expect(snapshot.absent).toEqual([`receipt:${laneHead}.merge`, `receipt:${outerHead}.merge`])
    expect(snapshot.lands.map((each) => [each.input.head, each.input.base, each.input.units.map((unit) => unit.branch)])).toEqual([[outerHead, base, ["feat/lane"]]])
    // Asked in any order, the same snapshot, byte for byte.
    const reversed = yield* frozen([state], { ...request, receipts: request.receipts.toReversed() })
    expect(snapshotText(reversed)).toBe(snapshotText(snapshot))
    // A reader outside the restricted artifacts sees no command and no checkout.
    expect(publicView(snapshot)).not.toContain("fixture-0.test.ts")
    expect(publicView(snapshot)).not.toContain(REPO)
    expect(snapshotText(snapshot)).toContain("fixture-0.test.ts")
  }),
)

const kindOf = (snapshot: InputSnapshot, kind: string) =>
  Option.map(
    Arr.findFirst(snapshot.receipts, (each) => each.input.kind === kind),
    (each) => ({ at: each.input.at, codes: each.input.checks.map((check) => check.code) }),
  )

seeded("23b: a land's merge check and a later accept run of the same head keep their own clocks and results; a red accept stays red", ({ expect }) =>
  Effect.gen(function* () {
    const merge = receipt(aggregateHead, "merge", outerTree, [0], "2026-11-22T03:00:00.000Z")
    const accept = receipt(aggregateHead, "accept", outerTree, [0, 1], "2026-11-22T03:40:00.000Z")
    const land = encodeLand({ head: aggregateHead, base, units: [], merge: Option.some(merge), at: "2026-11-22T03:01:00.000Z" })
    const state = files([
      [`land:${aggregateHead}`, text(land)],
      [`receipt:${aggregateHead}.accept`, text(encodeReceipt(accept))],
    ])
    const snapshot = yield* frozen([state], { receipts: [{ head: aggregateHead, kind: "accept" }], lands: [aggregateHead], install: false })
    expect([kindOf(snapshot, "merge"), kindOf(snapshot, "accept")]).toEqual([
      Option.some({ at: "2026-11-22T03:00:00.000Z", codes: [0] }),
      Option.some({ at: "2026-11-22T03:40:00.000Z", codes: [0, 1] }),
    ])
    expect(snapshot.lands.map((each) => each.input.at)).toEqual(["2026-11-22T03:01:00.000Z"])
  }),
)


seeded("duplicate, conflicting, aliased, out-of-scope, traversing and unreadable inputs: one identity with two contents conflicts, a file naming another head or repository is refused, a failed read is never absent", ({ expect }) =>
  Effect.gen(function* () {
    const round = receipt(laneHead, "round", laneTree, [0], "2026-11-22T01:00:00.000Z")
    const land = encodeLand({ head: outerHead, base, units: [{ branch: "feat/lane", path: LANE, receipt: round, by: "held" }], merge: Option.none(), at: "2026-11-22T02:00:00.000Z" })
    const overwritten = encodeReceipt(receipt(laneHead, "round", outerTree, [0], "2026-11-22T05:00:00.000Z"))
    const conflict = yield* run([files([[`land:${outerHead}`, text(land)], [`receipt:${laneHead}.round`, text(overwritten)]])], { receipts: [{ head: laneHead, kind: "round" }], lands: [outerHead], install: false })
    expect(failureWords(conflict.outcome)).toEqual(Option.some(`conflict dotfiles:${laneHead}:round`))
    const aliased = yield* frozen([files([[`receipt:${outerHead}.merge`, text(encodeReceipt(receipt(laneHead, "merge", laneTree, [0], "2026-11-22T01:00:00.000Z")))]])], { receipts: [{ head: outerHead, kind: "merge" }], lands: [], install: false })
    expect([aliased.receipts, aliased.refused]).toEqual([[], [{ source: `receipt:${outerHead}.merge`, reason: "names another head" }]])
    // A land whose merge check names another head, or whose unit receipt is another repository's, proves nothing of its own.
    const strayMerge = encodeLand({ head: outerHead, base, units: [], merge: Option.some(receipt(laneHead, "merge", laneTree, [0], "2026-11-22T02:00:00.000Z")), at: "2026-11-22T02:00:00.000Z" })
    const strayUnit = encodeLand({ head: aggregateHead, base, units: [{ branch: "feat/other", path: "/fixture/other", receipt: receiptAt(laneHead, "round", laneTree, [0], "2026-11-22T01:00:00.000Z", "/fixture/other"), by: "held" }], merge: Option.none(), at: "2026-11-22T02:00:00.000Z" })
    const strays = yield* frozen([files([[`land:${outerHead}`, text(strayMerge)], [`land:${aggregateHead}`, text(strayUnit)]])], { receipts: [], lands: [outerHead, aggregateHead], install: false })
    expect([strays.receipts, strays.lands, strays.refused]).toEqual([
      [],
      [],
      [
        { source: `land:${aggregateHead}`, reason: "unit feat/other: not a round receipt of this repository" },
        { source: `land:${outerHead}`, reason: "merge check: names another head" },
      ],
    ])
    const foreignText = encodeReceipt(receiptAt(laneHead, "round", laneTree, [0], "2026-11-22T01:00:00.000Z", "/fixture/other"))
    const foreign = yield* frozen([files([[`receipt:${laneHead}.round`, text(foreignText)]])], { receipts: [{ head: laneHead, kind: "round" }], lands: [], install: false })
    expect(foreign.refused).toEqual([{ source: `receipt:${laneHead}.round`, reason: "outside the repository" }])
    const traversal = yield* run([NO_FILES], { receipts: [{ head: "../../../etc/passwd", kind: "round" }], lands: [], install: false })
    expect([Option.map(Result.getSuccess(traversal.outcome), (snapshot) => snapshot.refused), traversal.served]).toEqual([Option.some([{ source: "receipt:../../../etc/passwd.round", reason: "not a commit name" }]), []])
    const broken = yield* run([files([[`receipt:${laneHead}.round`, Entry.Broken()]])], { receipts: [{ head: laneHead, kind: "round" }], lands: [], install: false })
    expect(failureWords(broken.outcome)).toEqual(Option.some(`unsettled receipt:${laneHead}.round: unreadable`))
    const handoff = yield* run([files([["handoff", text('{"pid":1}')], ["installed", text(encodeRecord(installedAs(build(base, base), Option.none())))]])], installOnly)
    expect(failureWords(handoff.outcome)).toEqual(Option.some("unsettled handoff: handoff"))
  }),
)

/** A small seeded generator: the script's moves come from the seed alone. */
const generator = (seed: number) => {
  const cell = { value: (seed * 2654435761) >>> 0 }
  return (below: number) => {
    cell.value = (Math.imul(cell.value, 1103515245) + 12345) >>> 0
    return (cell.value >>> 8) % below
  }
}

/** What a source state means to the oracle: absent, a record with the tree and exits it proves, a torn write, a refused file, a failing read. */
type Meaning = Data.TaggedEnum<{ None: {}; Valid: { readonly tree: string; readonly codes: ReadonlyArray<number> }; Torn: {}; Refused: { readonly reason: string }; Broken: {} }>
const Meaning = Data.taggedEnum<Meaning>()

interface Step {
  readonly files: State
  readonly record: FixtureRecord
  readonly torn: boolean
  readonly receipt: number
  readonly land: number
}

const ROUND_KEY = `receipt:${laneHead}.round`
const LAND_KEY = `land:${outerHead}`

/** Every refusal the host's source gives for a file it will not read. */
const REFUSALS = ["a link", "not a regular file", "too large", "not text"]

/** A source state for each refusal and for a failing read: the same for every source. */
const unreadStates: ReadonlyArray<{ readonly entry: Option.Option<Entry>; readonly meaning: Meaning }> = [
  ...REFUSALS.map((reason) => ({ entry: Option.some(Entry.Refused({ reason })), meaning: Meaning.Refused({ reason }) })),
  { entry: Option.some(Entry.Broken()), meaning: Meaning.Broken() },
]

const receiptStates: ReadonlyArray<{ readonly entry: Option.Option<Entry>; readonly meaning: Meaning }> = [
  { entry: Option.none(), meaning: Meaning.None() },
  { entry: Option.some(text(encodeReceipt(receipt(laneHead, "round", laneTree, [0, 0], "2026-11-22T01:00:00.000Z")))), meaning: Meaning.Valid({ tree: laneTree, codes: [0, 0] }) },
  { entry: Option.some(text(encodeReceipt(receipt(laneHead, "round", outerTree, [1], "2026-11-22T01:30:00.000Z")))), meaning: Meaning.Valid({ tree: outerTree, codes: [1] }) },
  { entry: Option.some(text(encodeReceipt(receipt(laneHead, "round", laneTree, [0], "2026-11-22T01:00:00.000Z")).slice(0, 37))), meaning: Meaning.Torn() },
  ...unreadStates,
]

/** A land of the outer head whose merge check proves `tree` with `codes`. */
const landText = (tree: string, codes: ReadonlyArray<number>, at: string) =>
  encodeLand({ head: outerHead, base, units: [], merge: Option.some(receiptAt(outerHead, "merge", tree, codes, at, REPO)), at })

const landStates: ReadonlyArray<{ readonly entry: Option.Option<Entry>; readonly meaning: Meaning }> = [
  { entry: Option.none(), meaning: Meaning.None() },
  { entry: Option.some(text(landText(outerTree, [0], "2026-11-22T02:00:00.000Z"))), meaning: Meaning.Valid({ tree: outerTree, codes: [0] }) },
  { entry: Option.some(text(landText(laneTree, [0, 1], "2026-11-22T02:30:00.000Z"))), meaning: Meaning.Valid({ tree: laneTree, codes: [0, 1] }) },
  { entry: Option.some(text(landText(outerTree, [0], "2026-11-22T02:00:00.000Z").slice(0, 50))), meaning: Meaning.Torn() },
  ...unreadStates,
]

const PAIRS = [build(installedDotfiles, provenFork), build(laneHead, provenFork), build(aggregateHead, checkoutFork)]

/** A whole source state with its independent oracle facts. */
const stepOf = ({ record, receipt, land, handoff }: Omit<Step, "files" | "torn"> & { readonly handoff: boolean }, torn = false): Step => {
  const whole = encodeRecord(record)
  const installed = text(Match.value(torn).pipe(Match.when(true, () => whole.slice(0, whole.length - 9)), Match.orElse(() => whole)))
  const entries: Array<readonly [string, Entry]> = [["installed", installed]]
  for (const entry of Option.toArray(Option.flatMap(Arr.get(receiptStates, receipt), (each) => each.entry))) entries.push([ROUND_KEY, entry])
  for (const entry of Option.toArray(Option.flatMap(Arr.get(landStates, land), (each) => each.entry))) entries.push([LAND_KEY, entry])
  if (handoff) entries.push(["handoff", text('{"pid":1}')])
  return { files: files(entries), record, torn, receipt, land }
}

/** The script for a seed: 3 to 8 whole states, each held for 1 to 6 reads, moving the record, the receipt, the land and the handoff marker. */
const scriptOf = (seed: number): ReadonlyArray<Step> => {
  const next = generator(seed)
  const pick = <A>(all: ReadonlyArray<A>, fallback: A) => Option.getOrElse(Arr.get(all, next(all.length)), () => fallback)
  const first = pick(PAIRS, build(base, base))
  const moves: ReadonlyArray<(record: FixtureRecord) => FixtureRecord> = [(record) => staged(record, pick(PAIRS, first)), promoted, provenNow, rolledBack]
  const walk = { record: installedAs(first, Option.some(first)), receipt: next(receiptStates.length), land: next(landStates.length), handoff: false }
  const steps: Array<Step> = []
  for (const _state of Arr.range(1, 3 + next(6))) {
    const step = stepOf(walk, next(8) === 0)
    for (const _read of Arr.range(1, 1 + next(6))) steps.push(step)
    walk.record = pick(moves, provenNow)(walk.record)
    if (next(3) === 0) walk.receipt = next(receiptStates.length)
    if (next(3) === 0) walk.land = next(landStates.length)
    walk.handoff = next(5) === 0
  }
  return steps
}

/** How many scripts a seed plays. */
const SCRIPTS = 80

/** What the generated scripts ask for. */
const GENERATED: InputRequest = { receipts: [{ head: laneHead, kind: "round" }], lands: [outerHead], install: true }

/**
 * The documented observation, written down rather than read off the calls made: the receipt read twice, then the
 * land twice, then the handoff marker twice, the installed record twice and the marker twice again. A pair whose two
 * answers differ, a marker present, or a read that fails ends the freeze there with a reason to read again.
 */
const READS = [ROUND_KEY, ROUND_KEY, LAND_KEY, LAND_KEY, "handoff", "handoff", "installed", "installed", "handoff", "handoff"]

/** Guaranteed witnesses: the record moves before the installed pair, or between its two reads. */
const witnesses = () => {
  const incumbent = build(installedDotfiles, provenFork)
  const pending = staged(installedAs(incumbent, Option.some(incumbent)), build(laneHead, checkoutFork))
  const promotion = promoted(pending)
  const state = (record: FixtureRecord) => stepOf({ record, receipt: 1, land: 2, handoff: false })
  const transition = (before: FixtureRecord, after: FixtureRecord, priorReads: number) => [...Arr.replicate(state(before), priorReads), state(after)]
  return [
    ["proven", transition(promotion, provenNow(promotion), 6)],
    ["unproven", transition(pending, promotion, 6)],
    ["unsettled", transition(pending, promotion, 7)],
  ] as const
}

/** What the script puts at read `index` of `key`: the state the script holds then. */
const entryAt = (steps: ReadonlyArray<Step>, index: number, key: string): Option.Option<Entry> =>
  Option.flatMap(Arr.get(steps, Math.min(index, steps.length - 1)), (step) => Option.fromNullishOr(step.files.get(key)))

/** The script's own verdict on one pair of reads: none when the pair settles. */
const pairVerdict = (steps: ReadonlyArray<Step>, pair: number): Option.Option<{ readonly reads: number; readonly failure: string }> => {
  const key = Option.getOrElse(Arr.get(READS, pair * 2), () => "")
  const [first, second] = [entryAt(steps, pair * 2, key), entryAt(steps, pair * 2 + 1, key)]
  if (Option.exists(first, Entry.$is("Broken"))) return Option.some({ reads: pair * 2 + 1, failure: `unsettled ${key}: unreadable` })
  if (Option.exists(second, Entry.$is("Broken"))) return Option.some({ reads: pair * 2 + 2, failure: `unsettled ${key}: unreadable` })
  if (!Equal.equals(first, second)) return Option.some({ reads: pair * 2 + 2, failure: `unsettled ${key}: changed` })
  if (key === "handoff" && Option.isSome(first)) return Option.some({ reads: pair * 2 + 2, failure: "unsettled handoff: handoff" })
  return Option.none()
}

/** The reads a freeze of the script must make, and its failure if it must fail. */
const observation = (steps: ReadonlyArray<Step>) =>
  Option.match(Arr.findFirst(Arr.range(0, READS.length / 2 - 1), (pair) => pairVerdict(steps, pair)), {
    onNone: () => ({ reads: READS, failure: Option.none<string>() }),
    onSome: (verdict) => ({ reads: READS.slice(0, verdict.reads), failure: Option.some(verdict.failure) }),
  })

/** Every head, tree and base a snapshot projects. */
const namesIn = (snapshot: InputSnapshot): ReadonlyArray<string> => [
  ...snapshot.receipts.flatMap((each) => [each.input.head, each.input.tree]),
  ...snapshot.lands.flatMap((each) => [each.input.head, each.input.base]),
  ...Option.toArray(Option.fromNullishOr(snapshot.install)).flatMap((each) => Match.value(each).pipe(Match.tag("Proven", (proven) => [proven.receipt.dotfiles, proven.receipt.fork]), Match.orElse(() => []))),
]

seeded("generated source transitions between read boundaries, for the receipt, the land, the installed record and the marker: one complete proven pair, absent, refused with the file's own reason, or a reason to read again; never a composite pair or an invented green", ({ seed, expect }) =>
  Effect.gen(function* () {
    const guaranteed = yield* Effect.forEach(witnesses(), ([kind, steps]) => checkScript(kind, steps, expect))
    expect([seed, guaranteed]).toEqual([seed, ["proven", "unproven", "unsettled"]])
    yield* Effect.forEach(Arr.range(1, SCRIPTS), (index) => {
      const scriptSeed = seed * SCRIPTS + index
      return checkScript(scriptSeed, scriptOf(scriptSeed), expect)
    }, { discard: true })
  }),
)

/** What a source's meaning leaves in a snapshot: the receipts it proves (head, kind, tree, exits), absent or refused with why. */
const leaves = (key: string, head: string, kind: string, notOne: string, meaning: Meaning) =>
  Meaning.$match(meaning, {
    None: () => ({ rows: [], absent: [key], refused: [] }),
    Valid: (valid) => ({ rows: [{ head, kind, tree: valid.tree, codes: valid.codes }], absent: [], refused: [] }),
    Torn: () => ({ rows: [], absent: [], refused: [{ source: key, reason: notOne }] }),
    Refused: (refused) => ({ rows: [], absent: [], refused: [{ source: key, reason: refused.reason }] }),
    Broken: () => ({ rows: [], absent: [], refused: [] }),
  })

/** One script, frozen and checked against the oracle: which kind of outcome it reached. */
const checkScript = (label: number | string, steps: ReadonlyArray<Step>, expect: SeedSeeded["expect"]) =>
  Effect.gen(function* () {
    const { outcome, served } = yield* run(
      steps.map((each) => each.files),
      GENERATED,
    )
    const must = observation(steps)
    // The freeze made exactly the documented reads, and failed exactly when and why the script says it must.
    expect([label, served.map((each) => each.key), failureWords(outcome)]).toEqual([label, must.reads, must.failure])
    if (Option.isSome(must.failure)) return "unsettled"
    const snapshot = yield* Effect.orDie(Effect.fromResult(outcome))
    const meaningAt = (read: number, of: (step: Step) => Option.Option<Meaning>) => Option.getOrElse(Option.flatMap(Arr.get(steps, Math.min(read, steps.length - 1)), of), () => Meaning.None())
    const round = leaves(ROUND_KEY, laneHead, "round", "not a receipt", meaningAt(0, (step) => Option.map(Arr.get(receiptStates, step.receipt), (each) => each.meaning)))
    const land = leaves(LAND_KEY, outerHead, "merge", "not a land record", meaningAt(2, (step) => Option.map(Arr.get(landStates, step.land), (each) => each.meaning)))
    const rows = snapshot.receipts.map((each) => ({ head: each.input.head, kind: `${each.input.kind}`, tree: each.input.tree, codes: each.input.checks.map((check) => check.code) }))
    const have: ReadonlyArray<unknown> = [label, Arr.sort(rows, byHead), snapshot.lands.map((each) => each.input.head), snapshot.absent, snapshot.refused]
    expect(have).toEqual([
      label,
      Arr.sort([...land.rows, ...round.rows], byHead),
      land.rows.map((each) => each.head),
      [...land.absent, ...round.absent],
      [...land.refused, ...round.refused],
    ])
    expect([label, namesIn(snapshot).every(isFull)]).toEqual([label, true])
    const step = Arr.get(steps, Math.min(6, steps.length - 1))
    const expected = Option.flatMap(Option.filter(step, (each) => !each.torn), (each) => provenPair(each.record))
    const install = Option.fromNullishOr(snapshot.install)
    const haveInstall: ReadonlyArray<unknown> = Option.match(install, {
      onNone: () => [label, "missing install evidence"],
      onSome: Match.type<NonNullable<InputSnapshot["install"]>>().pipe(
        Match.tag("Proven", (each) => [label, "Proven", { dotfiles: each.receipt.dotfiles, fork: each.receipt.fork }]),
        Match.tag("Unavailable", (each) => [label, "Unavailable", each.reason]),
        Match.exhaustive,
      ),
    })
    const reason = Match.value(Option.exists(step, (each) => each.torn)).pipe(Match.when(true, () => "corrupt"), Match.orElse(() => "unproven"))
    expect(haveInstall).toEqual(Option.match(expected, {
      onNone: () => [label, "Unavailable", reason],
      onSome: (pair) => [label, "Proven", pair],
    }))
    return Match.value(Option.exists(install, (each) => each._tag === "Proven")).pipe(Match.when(true, () => "proven"), Match.orElse(() => "unproven"))
  })

/** A freeze's result in words: its refusals, else what it froze; the install state when asked. */
const resultWords = (outcome: Result.Result<InputSnapshot, InputConflict | InputUnsettled>): string =>
  Result.match(outcome, {
    onFailure: () => Option.getOrElse(failureWords(outcome), () => "failed"),
    onSuccess: (snapshot) =>
      Match.value(snapshot.refused.length > 0).pipe(
        Match.when(true, () => snapshot.refused.map((each) => `refused ${each.reason}`).join(", ")),
        Match.orElse(() => `frozen ${snapshot.receipts.length} receipts, ${snapshot.lands.length} lands; install ${installWords(snapshot)}`),
      ),
  })

seeded("every head, tree and base a snapshot projects is a full object name: a record naming an abbreviation or upper case anywhere in it (a nested round, a merge check, a base, an installed or good build), or mixing object formats, is refused whole; a SHA-256 repository's 64-digit names stand", ({ expect }) =>
  Effect.gen(function* () {
    const short = (name: string) => name.slice(0, 8)
    const at = "2026-11-22T01:00:00.000Z"
    const round = (head: string, tree: string) => receipt(head, "round", tree, [0], at)
    const merge = (head: string, tree: string) => receiptAt(head, "merge", tree, [0], at, REPO)
    const landOf = (head: string, landBase: string, unit: Receipt, check: Receipt) =>
      encodeLand({ head, base: landBase, units: [{ branch: "feat/lane", path: LANE, receipt: unit, by: "held" }], merge: Option.some(check), at })
    const [wideOuter, wideBase, wideLane, wideTree] = ["c", "d", "e", "f"].map(sha256)
    const lettered = sha("e")
    const landCase = (head: string, landText: string) => run([files([[`land:${head}`, text(landText)]])], { receipts: [], lands: [head], install: false })
    const receiptCase = (receiptText: string) => run([files([[ROUND_KEY, text(receiptText)]])], { receipts: [{ head: laneHead, kind: "round" }], lands: [], install: false })
    const proven = (each: FixtureBuild, good: FixtureBuild) => run([installedFile(installedAs(each, Option.some(good)))], installOnly)
    const whole = build(installedDotfiles, provenFork)
    const cases: ReadonlyArray<readonly [string, Effect.Effect<{ readonly outcome: Result.Result<InputSnapshot, InputConflict | InputUnsettled> }>]> = [
      ["land: nested round head abbreviated", landCase(outerHead, landOf(outerHead, base, round(short(laneHead), laneTree), merge(outerHead, outerTree)))],
      ["land: nested round tree abbreviated", landCase(outerHead, landOf(outerHead, base, round(laneHead, short(laneTree)), merge(outerHead, outerTree)))],
      ["land: nested round head upper case", landCase(outerHead, landOf(outerHead, base, round(lettered.toUpperCase(), laneTree), merge(outerHead, outerTree)))],
      ["land: merge head abbreviated", landCase(outerHead, landOf(outerHead, base, round(laneHead, laneTree), merge(short(outerHead), outerTree)))],
      ["land: merge tree abbreviated", landCase(outerHead, landOf(outerHead, base, round(laneHead, laneTree), merge(outerHead, short(outerTree))))],
      ["land: base abbreviated", landCase(outerHead, landOf(outerHead, short(base), round(laneHead, laneTree), merge(outerHead, outerTree)))],
      ["land: its own head abbreviated", landCase(outerHead, landOf(short(outerHead), base, round(laneHead, laneTree), merge(outerHead, outerTree)))],
      ["land: two object formats", landCase(wideOuter, landOf(wideOuter, wideBase, round(laneHead, laneTree), merge(wideOuter, wideTree)))],
      ["land: SHA-256 throughout", landCase(wideOuter, landOf(wideOuter, wideBase, round(wideLane, wideTree), merge(wideOuter, wideTree)))],
      ["receipt: tree abbreviated", receiptCase(encodeReceipt(round(laneHead, short(laneTree))))],
      ["receipt: head upper case", receiptCase(encodeReceipt(round(lettered.toUpperCase(), laneTree)))],
      ["receipt: tree followed by newline", receiptCase(encodeReceipt(round(laneHead, `${laneTree}\n`)))],
      ["receipt: two object formats", receiptCase(encodeReceipt(round(laneHead, wideTree)))],
      ["install: installed dotfiles abbreviated", proven(build(short(installedDotfiles), provenFork), build(short(installedDotfiles), provenFork))],
      ["install: good fork abbreviated", proven(whole, build(installedDotfiles, short(provenFork)))],
      ["install: each repository its own format", proven(build(wideLane, provenFork), build(wideLane, provenFork))],
    ]
    const seen = yield* Effect.forEach(cases, ([name, each]) =>
      Effect.map(each, ({ outcome }) => {
        const names = Result.match(outcome, { onFailure: () => [], onSuccess: namesIn })
        return [name, resultWords(outcome), names.every(isFull)] as const
      }),
    )
    const wide = build(wideLane, provenFork)
    expect(seen).toEqual([
      ["land: nested round head abbreviated", "refused not a land record", true],
      ["land: nested round tree abbreviated", "refused not a land record", true],
      ["land: nested round head upper case", "refused not a land record", true],
      ["land: merge head abbreviated", "refused not a land record", true],
      ["land: merge tree abbreviated", "refused not a land record", true],
      ["land: base abbreviated", "refused not a land record", true],
      ["land: its own head abbreviated", "refused not a land record", true],
      ["land: two object formats", "refused mixes object formats", true],
      ["land: SHA-256 throughout", "frozen 2 receipts, 1 lands; install not asked", true],
      ["receipt: tree abbreviated", "refused not a receipt", true],
      ["receipt: head upper case", "refused not a receipt", true],
      ["receipt: tree followed by newline", "refused not a receipt", true],
      ["receipt: two object formats", "refused mixes object formats", true],
      ["install: installed dotfiles abbreviated", "frozen 0 receipts, 0 lands; install unavailable on host-a: corrupt", true],
      ["install: good fork abbreviated", "frozen 0 receipts, 0 lands; install unavailable on host-a: corrupt", true],
      ["install: each repository its own format", `frozen 0 receipts, 0 lands; install proven on host-a: ${wide.version} dotfiles=${wideLane} fork=${provenFork}`, true],
    ])
  }),
)

/** Every answer a source gives, as a snapshot observes it: none, two texts of different sizes, and each refusal with its reason. */
const ANSWERS: ReadonlyArray<SourceRead> = [
  SourceRead.Absent(),
  SourceRead.Present({ text: "{}" }),
  SourceRead.Present({ text: '{"a":1}' }),
  ...[...REFUSALS, "not a commit name"].map((reason) => SourceRead.Refused({ reason })),
]

/** A source answering each key from its own list, one answer per read of that key, the last one held (absent when none). */
const perKey = (answers: ReadonlyMap<string, ReadonlyArray<SourceRead>>) => {
  const counts = new Map<string, number>()
  return Layer.succeed(
    ReceiptSource,
    ReceiptSource.of({
      host: HOST,
      repository: "dotfiles",
      repositoryOf: (checkout) => Option.map(Option.liftPredicate(checkout, inRepo), () => "dotfiles"),
      read: (ref: SourceRef) =>
        Effect.sync(() => {
          const key = sourceKey(ref)
          const index = Option.getOrElse(Option.fromNullishOr(counts.get(key)), () => 0)
          counts.set(key, index + 1)
          const list = Option.getOrElse(Option.fromNullishOr(answers.get(key)), () => [])
          return Option.getOrElse(Arr.get(list, Math.min(index, list.length - 1)), () => SourceRead.Absent())
        }),
    }),
  )
}

/** A freeze of the generated request over `source`, its outcome. */
const freezeOver = (source: Layer.Layer<ReceiptSource>) => Effect.result(freeze(GENERATED)).pipe(Effect.provide(Layer.mergeAll(source, formats, Digest.layerWebCrypto)))

seeded("two reads of one source that differ in anything observable (absent or present, the text, its size, refused or not, the refusal's reason) are changed, for every source and both marker brackets; equal reads never are", ({ expect }) =>
  Effect.gen(function* () {
    // Where each source's pair of reads falls: the receipt, the land, the marker before the installed record, the record, the marker after it.
    const placings: ReadonlyArray<readonly [string, string, (pair: ReadonlyArray<SourceRead>) => ReadonlyArray<SourceRead>]> = [
      ["receipt", ROUND_KEY, (pair) => pair],
      ["land", LAND_KEY, (pair) => pair],
      ["marker before", "handoff", (pair) => pair],
      ["installed", "installed", (pair) => pair],
      ["marker after", "handoff", (pair) => [SourceRead.Absent(), SourceRead.Absent(), ...pair]],
    ]
    const wrong = yield* Effect.forEach(placings, ([name, key, place]) =>
      Effect.forEach(ANSWERS, (first) =>
        Effect.forEach(ANSWERS, (second) =>
          Effect.gen(function* () {
            const outcome = yield* freezeOver(perKey(new Map([[key, place([first, second])]])))
            const differ = !Equal.equals(first, second)
            const must = Match.value({ differ, marker: key === "handoff" && first._tag !== "Absent" }).pipe(
              Match.when({ differ: true }, () => Option.some(`unsettled ${key}: changed`)),
              Match.when({ marker: true }, () => Option.some("unsettled handoff: handoff")),
              Match.orElse(() => Option.none<string>()),
            )
            return Option.liftPredicate({ name, first, second, must, got: failureWords(outcome) }, (row) => !Equal.equals(row.must, row.got))
          }),
        ),
      ),
    )
    expect(wrong.flat(2).flatMap(Option.toArray)).toEqual([])
  }),
)

simulationTest("the host's files: only allowlisted regular files are read; a link, a folder, an oversized file, a bad name or an unreadable file is refused or unreadable, never absent or followed",
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "receipt-input-" })
    const receipts = path.join(root, "receipts")
    const outside = path.join(root, "outside")
    yield* fs.makeDirectory(receipts)
    yield* fs.makeDirectory(outside)
    const valid = encodeReceipt(receiptAt(laneHead, "round", laneTree, [0], "2026-11-22T01:00:00.000Z", path.join(root, "checkout")))
    yield* fs.writeFileString(path.join(receipts, `${laneHead}.round.json`), valid)
    yield* fs.writeFileString(path.join(outside, "secret.json"), valid)
    yield* fs.symlink(path.join(outside, "secret.json"), path.join(receipts, `${outerHead}.round.json`))
    yield* fs.makeDirectory(path.join(receipts, `${aggregateHead}.round.json`))
    yield* fs.writeFileString(path.join(receipts, `${base}.round.json`), "x".repeat(5000))
    yield* fs.writeFileString(path.join(receipts, `${laneTree}.round.json`), valid)
    yield* fs.chmod(path.join(receipts, `${laneTree}.round.json`), 0)
    const places = { host: HOST, repository: { key: "dotfiles", checkouts: [path.join(root, "checkout")] }, receipts, installed: path.join(root, "state", "installed.json"), handoff: path.join(root, "state", "handoff.json"), maxBytes: 4096, readWithin: "1 second" as const }
    const source = Context.get(yield* Layer.build(receiptSource(places)), ReceiptSource)
    const read = (head: string) => Effect.result(source.read(SourceRef.Receipt({ head, kind: "round" })))
    check(yield* read(laneHead)).toEqual(Result.succeed(SourceRead.Present({ text: valid })))
    check(yield* read(outerHead)).toEqual(Result.succeed(SourceRead.Refused({ reason: "a link" })))
    check(yield* read(aggregateHead)).toEqual(Result.succeed(SourceRead.Refused({ reason: "not a regular file" })))
    check(yield* read(base)).toEqual(Result.succeed(SourceRead.Refused({ reason: "too large" })))
    check(yield* read(installedDotfiles)).toEqual(Result.succeed(SourceRead.Absent()))
    // A FIFO is refused unopened (opening one would wait for a writer); a link to nothing is still a link, never absent.
    check(yield* Effect.sync(() => spawnSync(["mkfifo", path.join(receipts, `${outerTree}.round.json`)]).exitCode)).toBe(0)
    check(yield* read(outerTree)).toEqual(Result.succeed(SourceRead.Refused({ reason: "not a regular file" })))
    yield* fs.symlink(path.join(root, "nowhere.json"), path.join(receipts, `${checkoutFork}.round.json`))
    check(yield* read(checkoutFork)).toEqual(Result.succeed(SourceRead.Refused({ reason: "a link" })))
    check(yield* read("../outside/secret")).toEqual(Result.succeed(SourceRead.Refused({ reason: "not a commit name" })))
    check(Result.isFailure(yield* read(laneTree))).toBe(true)
    check(yield* Effect.result(source.read(SourceRef.Installed()))).toEqual(Result.succeed(SourceRead.Absent()))
    const scopes = [path.join(root, "checkout", ".work", "lane"), `${path.join(root, "checkout")}/../outside`, `${path.join(root, "checkout")}-elsewhere`, path.relative(path.resolve("."), path.join(root, "checkout"))].map(source.repositoryOf)
    check(scopes).toEqual([Option.some("dotfiles"), Option.none(), Option.none(), Option.none()])
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
)

/** A SHA-256 of `bytes` by Bun's own hasher: an oracle independent of the Effect digest the snapshot uses. */
const byteHash = (bytes: Uint8Array) => new CryptoHasher("sha256").update(bytes).digest("hex")

const UTF8 = new TextEncoder()

/** What may come before the JSON: nothing, or a UTF-8 byte-order mark. */
const PREFIXES = [Uint8Array.of(), Uint8Array.of(0xef, 0xbb, 0xbf)]

/** The JSON a producer wrote, laid out as a file might hold it: compact, broken over LF lines, over CRLF lines, padded, CRLF-ended. */
const LAYOUTS: ReadonlyArray<(json: string) => string> = [
  (json) => json,
  (json) => json.replaceAll(',"', ',\n  "'),
  (json) => json.replaceAll(',"', ',\r\n  "'),
  (json) => `  ${json}\n`,
  (json) => `${json}\r\n`,
]

/** What may follow the JSON: nothing, a stray byte of text, a byte that is not UTF-8. */
const TAILS = [Uint8Array.of(), UTF8.encode("x"), Uint8Array.of(0xff)]

/** Commands with and without multi-byte characters. */
const COMMANDS = ["bun test fixture.test.ts", "bun test fixtüre-日本-🙂.test.ts"]

interface Combo {
  readonly prefix: number
  readonly layout: number
  readonly tail: number
  readonly command: number
}

/** One file's bytes: the prefix, the laid-out JSON, the tail. */
const bytesOf = (combo: Combo, json: string) =>
  Uint8Array.from([
    ...Option.getOrElse(Arr.get(PREFIXES, combo.prefix), () => Uint8Array.of()),
    ...UTF8.encode(Option.getOrElse(Arr.get(LAYOUTS, combo.layout), () => (each: string) => each)(json)),
    ...Option.getOrElse(Arr.get(TAILS, combo.tail), () => Uint8Array.of()),
  ])

/** What the oracle expects of a combination: bytes that are not UTF-8 refused by the source; a mark or a stray tail refused by the decoder; else frozen. */
const expectedOf = (combo: Combo) =>
  Match.value({ prefix: combo.prefix, tail: combo.tail }).pipe(
    Match.when({ tail: 2 }, () => ({ read: "Refused", receipt: "not text", install: "refused", artifacts: 0, proven: Option.none<boolean>() })),
    Match.when({ prefix: 0, tail: 0 }, () => ({ read: "Present", receipt: "frozen", install: "Proven", artifacts: 2, proven: Option.some(true) })),
    Match.orElse(() => ({ read: "Present", receipt: "not a receipt", install: "corrupt", artifacts: 0, proven: Option.none<boolean>() })),
  )

/** The install state's tag, or its reason when unavailable. */
const installState = (snapshot: InputSnapshot) =>
  Option.match(Option.fromNullishOr(snapshot.install), {
    onNone: () => "none",
    onSome: (install) => Match.value(install).pipe(Match.tag("Proven", () => "Proven"), Match.tag("Unavailable", (none) => none.reason), Match.exhaustive),
  })

/** The host an install state names. */
const installHost = (snapshot: InputSnapshot) =>
  Option.match(Option.fromNullishOr(snapshot.install), {
    onNone: () => "none",
    onSome: (install) => Match.value(install).pipe(Match.tag("Proven", (proven) => proven.receipt.host), Match.tag("Unavailable", (none) => none.host), Match.exhaustive),
  })

/** The proven install's evidence digest. */
const provenDigest = (snapshot: InputSnapshot) =>
  Option.flatMap(Option.fromNullishOr(snapshot.install), (install) => Match.value(install).pipe(Match.tag("Proven", (proven) => Option.some(proven.receipt.proven)), Match.orElse(() => Option.none<string>())))

/** A freeze of `request` over the host files at `places`. */
const freezeAt = (places: ReceiptPlaces, request: InputRequest) => freeze(request).pipe(Effect.provide(layer(places)))

simulationTest("evidence is the file's exact bytes: a byte-order mark is kept and refused, CRLF and padding are kept as written, a stray tail is refused, bytes that are not UTF-8 are refused; every accepted file's digest is an independent hash of the file",
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "receipt-bytes-" })
    const receipts = path.join(root, "receipts")
    const checkout = path.join(root, "checkout")
    yield* fs.makeDirectory(receipts)
    yield* fs.makeDirectory(path.join(root, "state"))
    const places = { host: HOST, repository: { key: "dotfiles", checkouts: [checkout] }, receipts, installed: path.join(root, "state", "installed.json"), handoff: path.join(root, "state", "handoff.json"), maxBytes: 65536, readWithin: "1 second" as const }
    const source = Context.get(yield* Layer.build(receiptSource(places)), ReceiptSource)
    const combos: ReadonlyArray<Combo> = PREFIXES.flatMap((_, prefix) =>
      LAYOUTS.flatMap((_, layout) => TAILS.flatMap((_, tail) => COMMANDS.map((_, command) => ({ prefix, layout, tail, command })))),
    )
    const seen = yield* Effect.forEach(combos, (combo) =>
      Effect.gen(function* () {
        const command = Option.getOrElse(Arr.get(COMMANDS, combo.command), () => "bun test")
        const receiptJson = encodeReceipt({ ...receiptAt(laneHead, "round", laneTree, [0], "2026-11-22T01:00:00.000Z", checkout), checks: [{ command, code: 0, seconds: 1 }] })
        const proven = { ...build(installedDotfiles, provenFork), command: [command] }
        const receiptBytes = bytesOf(combo, receiptJson)
        const installedBytes = bytesOf(combo, encodeRecord(installedAs(proven, Option.some(proven))))
        yield* fs.writeFile(path.join(receipts, `${laneHead}.round.json`), receiptBytes)
        yield* fs.writeFile(places.installed, installedBytes)
        // The source answers the file's bytes exactly, the mark included, or refuses bytes that are not UTF-8.
        const read = yield* source.read(SourceRef.Receipt({ head: laneHead, kind: "round" }))
        const exact = SourceRead.$match(read, { Present: (present) => deepEquals(UTF8.encode(present.text), receiptBytes), Absent: () => false, Refused: () => true })
        const snapshot = yield* freezeAt(places, { receipts: [{ head: laneHead, kind: "round" }], lands: [], install: true })
        const hashes = [byteHash(receiptBytes), byteHash(installedBytes)]
        // Every artifact kept reproduces one of the two files byte for byte, under its independent hash.
        const artifactsExact = snapshot.artifacts.every((each) => hashes.includes(each.digest) && each.digest === byteHash(UTF8.encode(each.text)))
        const have = {
          read: `${read._tag}`,
          receipt: Option.getOrElse(Option.map(Arr.head(snapshot.receipts), () => "frozen"), () => snapshot.refused.map((each) => each.reason).join(",")),
          install: installState(snapshot),
          artifacts: snapshot.artifacts.length,
          proven: Option.map(provenDigest(snapshot), (digest) => digest === byteHash(installedBytes)),
        }
        return [combo, have, exact, artifactsExact] as const
      }),
    )
    check(seen).toEqual(combos.map((combo) => [combo, expectedOf(combo), true, true] as const))
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
)

simulationTest("host scope: a source stamps the host it reads on; Work's receipts and the updater's record name no producing host, so bytes copied into another host's folder read as that host's, with the same digest",
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "receipt-hosts-" })
    const checkout = path.join(root, "checkout")
    const placesOf = (host: string) => ({
      host,
      repository: { key: "dotfiles", checkouts: [checkout] },
      receipts: path.join(root, host, "receipts"),
      installed: path.join(root, host, "installed.json"),
      handoff: path.join(root, host, "handoff.json"),
      maxBytes: 65536,
      readWithin: "1 second" as const,
    })
    const [first, second] = [placesOf("host-a"), placesOf("host-b")]
    yield* Effect.forEach([first, second], (places) => fs.makeDirectory(places.receipts, { recursive: true }))
    const proven = build(installedDotfiles, provenFork)
    yield* fs.writeFileString(path.join(first.receipts, `${laneHead}.round.json`), encodeReceipt(receiptAt(laneHead, "round", laneTree, [0], "2026-11-22T01:00:00.000Z", checkout)))
    yield* fs.writeFileString(first.installed, encodeRecord(installedAs(proven, Option.some(proven))))
    const request: InputRequest = { receipts: [{ head: laneHead, kind: "round" }], lands: [], install: true }
    const freezeOn = (places: ReceiptPlaces) => freezeAt(places, request)
    const hosts = (snapshot: InputSnapshot) => ({
      snapshot: snapshot.host,
      receipts: snapshot.receipts.map((each) => each.input.observedOn),
      install: installHost(snapshot),
      absent: snapshot.absent,
    })
    const onFirst = yield* freezeOn(first)
    const beforeCopy = yield* freezeOn(second)
    yield* fs.copyFile(path.join(first.receipts, `${laneHead}.round.json`), path.join(second.receipts, `${laneHead}.round.json`))
    yield* fs.copyFile(first.installed, second.installed)
    const onSecond = yield* freezeOn(second)
    check([hosts(onFirst), hosts(beforeCopy), hosts(onSecond)]).toEqual([
      { snapshot: "host-a", receipts: ["host-a"], install: "host-a", absent: [] },
      { snapshot: "host-b", receipts: [], install: "host-b", absent: [ROUND_KEY] },
      { snapshot: "host-b", receipts: ["host-b"], install: "host-b", absent: [] },
    ])
    // The same bytes, so the same evidence digests; the observation differs, so the identities do.
    check(onSecond.artifacts.map((each) => each.digest)).toEqual(onFirst.artifacts.map((each) => each.digest))
    check([onSecond.id === onFirst.id, onSecond.receipts[0]?.id === onFirst.receipts[0]?.id]).toEqual([false, false])
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
)

/** One entry of the fake file system: a file (its inode, its text, how many names it has), a FIFO, a folder, a link. */
type Node = Data.TaggedEnum<{
  File: { readonly ino: bigint; readonly text: string; readonly names: number }
  Fifo: { readonly ino: bigint; readonly text: string }
  Folder: { readonly ino: bigint }
  Link: { readonly ino: bigint; readonly target: string }
}>
const Node = Data.taggedEnum<Node>()

/** The fake's world: an entry by absolute path, changed in place by a swap. */
type World = Map<string, Node>

/** Where `file` leads in `world`: every link among its parents followed, the last one too when `followLast`. */
const resolveIn = (world: World, file: string, followLast: boolean): string => {
  if (file === "/") return file
  const parts = file.split("/").filter((part) => part !== "")
  return Arr.reduce(parts, "", (at, part, index) => {
    const next = `${at}/${part}`
    return Option.match(Option.filter(Option.fromNullishOr(world.get(next)), Node.$is("Link")), {
      onNone: () => next,
      onSome: (link) => Match.value(index < parts.length - 1 || followLast).pipe(Match.when(true, () => resolveIn(world, link.target, true)), Match.orElse(() => next)),
    })
  })
}

/** An entry's facts as `stat` gives them. */
const infoOf = (node: Node): FileSystem.File.Info => {
  const [type, size, names] = Node.$match(node, {
    File: (each) => ["File", UTF8.encode(each.text).length, each.names] as const,
    Fifo: (each) => ["FIFO", UTF8.encode(each.text).length, 1] as const,
    Folder: () => ["Directory", 0, 2] as const,
    Link: (each) => ["SymbolicLink", each.target.length, 1] as const,
  })
  return {
    type,
    mtime: Option.none(),
    atime: Option.none(),
    birthtime: Option.none(),
    dev: 1n,
    ino: Option.some(node.ino),
    mode: 0o644,
    nlink: Option.some(BigInt(names)),
    uid: Option.none(),
    gid: Option.none(),
    rdev: Option.none(),
    size: ByteSize.bytes(size),
    blksize: Option.none(),
    blocks: Option.none(),
  }
}

// The platform's own "no such entry", as its no-op file system answers it.
const NOTHING = FileSystem.makeNoop({})
/** The entry at `file`, or the platform's NotFound. */
const found = (node: Option.Option<Node>, file: string) =>
  Option.match(node, { onNone: () => NOTHING.lstat(file).pipe(Effect.andThen(Effect.die("the no-op file system has no entries"))), onSome: Effect.succeed })

/** A phase in which the file observation may stop responding. */
type Call = "realPath" | "lstat" | "open" | "stat" | "read" | "close"
/** `effect`, or one that never returns when `call` is among `hangs`. */
const stuckIf =
  (hangs: ReadonlyArray<Call>) =>
  <A, E>(call: Call, effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    Match.value(hangs.includes(call)).pipe(Match.when(true, () => Effect.never), Match.orElse(() => effect))

/**
 * A scripted host at the two external seams. The fake child answers the wire protocol and owns the opened
 * file until its scope closes; deliberately hanging the pipe or exit tests the parent, not Perl.
 */
const swapping = (world: World, beforeOpen: (world: World) => void, afterOpen: (world: World) => void, hangs: ReadonlyArray<Call> = []) => {
  const stuck = stuckIf(hangs)
  const opened: Array<string> = []
  const live = { handles: 0, reads: 0 }
  const swaps = { before: [beforeOpen], after: [afterOpen] }
  const files = Layer.succeed(
    FileSystem.FileSystem,
    FileSystem.makeNoop({
      realPath: (file) =>
        stuck("realPath", Effect.suspend(() => {
          const real = resolveIn(world, file, true)
          return Effect.as(found(Option.fromNullishOr(world.get(real)), file), real)
        })),
      lstat: (file) => stuck("lstat", Effect.suspend(() => Effect.map(found(Option.fromNullishOr(world.get(resolveIn(world, file, false))), file), infoOf))),
    }),
  )
  const processes = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand") return yield* Effect.die("expected one file reader")
      const [bound, real, name, cap] = command.args.slice(-4)
      if (!Predicate.isString(bound) || !Predicate.isString(real) || !Predicate.isString(name) || !Predicate.isString(cap)) return yield* Effect.die("invalid reader arguments")
      const sameRoot = () => {
        const parts = real.split("/").filter((part) => part.length > 0)
        const prefixes = ["/", ...parts.map((_, i) => `/${parts.slice(0, i + 1).join("/")}`)]
        return bound.split("/").every((id, i) =>
          Option.exists(Option.flatMap(Arr.get(prefixes, i), (prefix) => Option.fromNullishOr(world.get(prefix))), (node) => node._tag === "Folder" && `1:${node.ino}` === id),
        )
      }
      const seen = yield* Effect.acquireRelease(Effect.sync(() => {
        live.handles += 1
        for (const swap of swaps.before.splice(0)) swap(world)
        const file = `${real}/${name}`
        const node = Option.fromNullishOr(world.get(file))
        const inside = sameRoot()
        const held = Option.filter(node, (entry) => inside && entry._tag !== "Link")
        if (Option.isSome(held)) opened.push(file)
        for (const swap of swaps.after.splice(0)) swap(world)
        return { node, held, file, inside }
      }), () => Effect.sync(() => { live.handles -= 1 }))
      const response = Option.match(seen.held, {
        onNone: () => {
          if (!seen.inside) return "U"
          if (Option.isNone(seen.node)) return "A"
          return "L"
        },
        onSome: Node.$match({
          Link: () => "L",
          Fifo: () => "N",
          Folder: () => "N",
          File: (before) => {
            const after = Option.fromNullishOr(world.get(seen.file))
            if (before.names > 1) return "H"
            if (Option.isNone(after) || after.value._tag !== "File" || after.value.ino !== before.ino || !sameRoot()) return "U"
            if (UTF8.encode(after.value.text).length > Number(cap)) return "S"
            return `P${after.value.text}`
          },
        }),
      })
      const stopped = yield* Deferred.make<void>()
      const reply = stuck("open", stuck("stat", stuck("read", Effect.succeed(UTF8.encode(response)))))
      const tracked = Effect.acquireRelease(Effect.sync(() => { live.reads += 1 }), () => Effect.sync(() => { live.reads -= 1 }))
      const stdout = Stream.fromEffect(Effect.scoped(Effect.andThen(tracked, Effect.raceFirst(reply, Effect.as(Deferred.await(stopped), new Uint8Array())))))
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(42),
        exitCode: stuck("close", Effect.succeed(ChildProcessSpawner.ExitCode(0))),
        isRunning: Effect.succeed(true),
        kill: () => Deferred.complete(stopped, Effect.void).pipe(Effect.asVoid),
        stdin: Sink.drain,
        stdout,
        stderr: Stream.empty,
        all: stdout,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      })
    }),
  ))
  return { layer: Layer.mergeAll(files, processes), opened, live }
}

/** Let runnable fibers settle before advancing the fake clock. */
const settle = Effect.forEach(Arr.range(1, 20), () => Effect.yieldNow, { discard: true })

/** `fiber`'s exit, the virtual clock moved a second at a time until it ends (at most 4 s), and how many seconds it took. */
const byTheClock = <A, E>(fiber: Fiber.Fiber<A, E>, seconds = 0): Effect.Effect<readonly [number, Option.Option<Exit.Exit<A, E>>]> =>
  settle.pipe(
    Effect.andThen(
      Effect.suspend(() => {
        const exit = Option.fromNullishOr(fiber.pollUnsafe())
        return Match.value(Option.isSome(exit) || seconds >= 4).pipe(
          Match.when(true, () => Effect.succeed([seconds, exit] as const)),
          Match.orElse(() => TestClock.adjust("1 second").pipe(Effect.andThen(byTheClock(fiber, seconds + 1)))),
        )
      }),
    ),
  )

seeded("a fake host schedules file swaps and interrupted readers: the source propagates refusals and timeouts, and no child or pending pipe read survives its deadline", ({ expect }) =>
  Effect.gen(function* () {
    const name = `${laneHead}.round.json`
    const leaf = `/real/receipts/${name}`
    const good = encodeReceipt(receipt(laneHead, "round", laneTree, [0], "2026-11-22T01:00:00.000Z"))
    const other = encodeReceipt(receipt(laneHead, "round", outerTree, [1], "2026-11-22T02:00:00.000Z"))
    const secret = encodeReceipt(receipt(laneHead, "round", base, [0], "2026-11-22T03:00:00.000Z"))
    const secretFile = Node.File({ ino: 20n, text: secret, names: 1 })
    const worldOf = (): World =>
      new Map<string, Node>([
        ["/", Node.Folder({ ino: 0n })],
        ["/real", Node.Folder({ ino: 1n })],
        ["/real/receipts", Node.Folder({ ino: 2n })],
        [leaf, Node.File({ ino: 10n, text: good, names: 1 })],
        ["/outside", Node.Folder({ ino: 3n })],
        ["/outside/secret.json", secretFile],
        [`/outside/${name}`, Node.File({ ino: 21n, text: secret, names: 1 })],
        ["/alias", Node.Link({ ino: 4n, target: "/real" })],
      ])
    const keep = (_world: World) => {}
    const put = (file: string, node: Node) => (world: World) => void world.set(file, node)
    const restore = (file: string) => (world: World) => void Option.map(Option.fromNullishOr(worldOf().get(file)), (node) => world.set(file, node))
    const cases: ReadonlyArray<readonly [string, string, (world: World) => void, (world: World) => void]> = [
      ["no swap", "/real/receipts", keep, keep],
      ["configured ancestor already a link", "/alias/receipts", keep, keep],
      ["file swapped for a link to an outside file", "/real/receipts", put(leaf, Node.Link({ ino: 30n, target: "/outside/secret.json" })), keep],
      ["file swapped for a FIFO", "/real/receipts", put(leaf, Node.Fifo({ ino: 31n, text: secret })), keep],
      ["file swapped for a FIFO, then back before the writer comes", "/real/receipts", put(leaf, Node.Fifo({ ino: 31n, text: secret })), restore(leaf)],
      ["file swapped for a folder", "/real/receipts", put(leaf, Node.Folder({ ino: 32n })), keep],
      ["file swapped for a hard link to an outside file", "/real/receipts", put(leaf, Node.File({ ...secretFile, names: 2 })), keep],
      ["file swapped for another file", "/real/receipts", put(leaf, Node.File({ ino: 33n, text: other, names: 1 })), keep],
      ["parent folder swapped for a link outside", "/real/receipts", put("/real/receipts", Node.Link({ ino: 34n, target: "/outside" })), keep],
      ["parent folder swapped for a link outside, then back", "/real/receipts", put("/real/receipts", Node.Link({ ino: 34n, target: "/outside" })), restore("/real/receipts")],
      ["file replaced while open", "/real/receipts", keep, put(leaf, Node.File({ ino: 35n, text: other, names: 1 }))],
      ["file written past the cap in place while open", "/real/receipts", keep, put(leaf, Node.File({ ino: 10n, text: `${good}${" ".repeat(65536)}`, names: 1 }))],
    ]
    const places = (folder: string) => ({ host: HOST, repository: { key: "dotfiles", checkouts: [LANE] }, receipts: folder, installed: "/real/state/installed.json", handoff: "/real/state/handoff.json", maxBytes: 65536, readWithin: "1 second" as const })
    const sourceOn = (fake: ReturnType<typeof swapping>, folder: string) =>
      Effect.map(Layer.build(receiptSource(places(folder)).pipe(Layer.provide(Layer.mergeAll(fake.layer, Path.layer)))), (built) => Context.get(built, ReceiptSource))
    const said = (read: Result.Result<SourceRead, SourceUnreadable>, messages: boolean) =>
      Result.match(read, {
        onFailure: (error) => Match.value(messages).pipe(Match.when(true, () => `unreadable: ${error.message}`), Match.orElse(() => "unreadable")),
        onSuccess: SourceRead.$match({
          Present: (present) => Match.value(present.text).pipe(Match.when(good, () => "the file"), Match.when(other, () => "the other file"), Match.orElse(() => "OTHER BYTES")),
          Absent: () => "absent",
          Refused: (refused) => `refused: ${refused.reason}`,
        }),
      })
    /** One read by the virtual clock: what it answered, how many seconds it took, where its opens led, and the handles left open once it ended. */
    const readBy = (fake: ReturnType<typeof swapping>, source: ReceiptSource["Service"], messages: boolean) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.result(source.read(SourceRef.Receipt({ head: laneHead, kind: "round" }))))
        const [seconds, exit] = yield* byTheClock(fiber)
        yield* settle
        const words = Option.match(exit, { onNone: () => "still waiting", onSome: Exit.match({ onFailure: () => "died", onSuccess: (read) => said(read, messages) }) })
        return { seconds, words, opened: [...fake.opened], live: fake.live.handles + fake.live.reads }
      })
    const seen = yield* Effect.forEach(cases, ([what, folder, beforeOpen, afterOpen]) =>
      Effect.gen(function* () {
        const fake = swapping(worldOf(), beforeOpen, afterOpen)
        const read = yield* readBy(fake, yield* sourceOn(fake, folder), false)
        return [what, read.words, read.seconds, read.opened, read.live] as const
      }),
    )
    expect(seen).toEqual([
      ["no swap", "the file", 0, [leaf], 0],
      ["configured ancestor already a link", "unreadable", 0, [], 0],
      ["file swapped for a link to an outside file", "refused: a link", 0, [], 0],
      ["file swapped for a FIFO", "refused: not a regular file", 0, [leaf], 0],
      ["file swapped for a FIFO, then back before the writer comes", "refused: not a regular file", 0, [leaf], 0],
      ["file swapped for a folder", "refused: not a regular file", 0, [leaf], 0],
      ["file swapped for a hard link to an outside file", "refused: a hard link", 0, [leaf], 0],
      ["file swapped for another file", "the other file", 0, [leaf], 0],
      ["parent folder swapped for a link outside", "unreadable", 0, [], 0],
      ["parent folder swapped for a link outside, then back", "unreadable", 0, [], 0],
      ["file replaced while open", "unreadable", 0, [leaf], 0],
      ["file written past the cap in place while open", "refused: too large", 0, [leaf], 0],
    ])
    // Once the first open hangs behind a FIFO that is renamed away, its scope must release before a new read.
    const hangs: Array<Call> = ["open"]
    const fake = swapping(worldOf(), put(leaf, Node.Fifo({ ino: 31n, text: secret })), restore(leaf), hangs)
    const source = yield* sourceOn(fake, "/real/receipts")
    const first = yield* readBy(fake, source, true)
    hangs.pop()
    const after = yield* readBy(fake, source, true)
    expect([first, after].map((each) => [each.words, each.seconds, each.opened.length, each.live])).toEqual([
      ["unreadable: file reader did not return in time", 1, 1, 0],
      ["the file", 0, 2, 0],
    ])
    // The same deadline handles the rest of the phases, including a child that sent bytes but never exited.
    const hung = yield* Effect.forEach(["stat", "read", "close"] as const, (call) =>
      Effect.gen(function* () {
        const fake = swapping(worldOf(), keep, keep, [call])
        const read = yield* readBy(fake, yield* sourceOn(fake, "/real/receipts"), true)
        return [call, read.words, read.seconds] as const
      }),
    )
    expect(hung).toEqual([
      ["stat", "unreadable: file reader did not return in time", 1],
      ["read", "unreadable: file reader did not return in time", 1],
      ["close", "unreadable: file reader did not return in time", 1],
    ])
    const setup = swapping(worldOf(), keep, keep, ["lstat"])
    const started = yield* Effect.forkChild(sourceOn(setup, "/real/receipts"))
    const [seconds, bound] = yield* byTheClock(started)
    expect(seconds).toBe(1)
    expect(Option.exists(bound, Exit.isSuccess)).toBe(true)
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
)
