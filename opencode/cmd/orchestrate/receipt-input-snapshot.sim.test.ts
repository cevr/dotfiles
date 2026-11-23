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
import { receiptSource } from "@dotfiles/opencode-orchestrate/filestore/run-records"
import { headsOf } from "@dotfiles/opencode-orchestrate/fleet"
import { mainBatchText } from "@dotfiles/opencode-orchestrate/tools"
import { LandRecordJson, type Receipt, ReceiptJson } from "@dotfiles/opencode-work/receipt"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Array as Arr, Context, Data, Effect, Equal, FileSystem, Layer, Match, Option, Order, Path, Result, Schema } from "effect"
import { Digest } from "effect/crypto"
import * as Seed from "../../sim/seed.ts"
import { formats } from "./batch-inputs.ts"

const { seeded } = Seed.runner("cmd/orchestrate/receipt-input-snapshot.sim.test.ts")

const sha = (digit: string) => digit.repeat(40)
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

/** What one file holds in one state of the script: text, a link the source refuses, or a read that fails. */
type Entry = Data.TaggedEnum<{ Text: { readonly text: string }; Link: {}; Broken: {} }>
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
      Link: () => Effect.succeed(SourceRead.Refused({ reason: "a link" })),
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

const byHead = Order.mapInput(Order.String, (row: { readonly head: string }) => row.head)

seeded("23a: a lane's round receipt nested in a later land is evidence of the lane head; the land's merge check is the outer head's alone", ({ expect }) =>
  Effect.gen(function* () {
    const round = receipt(laneHead, "round", laneTree, [0, 0], "2026-11-22T01:00:00.000Z")
    const merge = receiptAt(outerHead, "merge", outerTree, [0], "2026-11-22T02:00:00.000Z", `${REPO}/.work/integrate`)
    const land = encodeLand({ head: outerHead, base, units: [{ branch: "feat/lane", path: LANE, receipt: round, by: "held" }], merge: Option.some(merge), at: "2026-11-22T02:01:00.000Z" })
    const state = files([
      [`land:${outerHead}`, text(land)],
      [`receipt:${laneHead}.round`, text(encodeReceipt(round))],
    ])
    const request: InputRequest = {
      receipts: [
        { head: laneHead, kind: "round" },
        { head: laneHead, kind: "merge" },
        { head: outerHead, kind: "merge" },
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

/** What a receipt state means to the oracle: absent, a receipt with its tree and exits, a torn write, a link. */
type Meaning = Data.TaggedEnum<{ None: {}; Valid: { readonly tree: string; readonly codes: ReadonlyArray<number> }; Torn: {}; Linked: {} }>
const Meaning = Data.taggedEnum<Meaning>()

interface Step {
  readonly files: State
  readonly record: FixtureRecord
  readonly torn: boolean
  readonly receipt: number
}

const ROUND_KEY = `receipt:${laneHead}.round`

const receiptStates: ReadonlyArray<{ readonly entry: Option.Option<Entry>; readonly meaning: Meaning }> = [
  { entry: Option.none(), meaning: Meaning.None() },
  { entry: Option.some(text(encodeReceipt(receipt(laneHead, "round", laneTree, [0, 0], "2026-11-22T01:00:00.000Z")))), meaning: Meaning.Valid({ tree: laneTree, codes: [0, 0] }) },
  { entry: Option.some(text(encodeReceipt(receipt(laneHead, "round", outerTree, [1], "2026-11-22T01:30:00.000Z")))), meaning: Meaning.Valid({ tree: outerTree, codes: [1] }) },
  { entry: Option.some(text(encodeReceipt(receipt(laneHead, "round", laneTree, [0], "2026-11-22T01:00:00.000Z")).slice(0, 37))), meaning: Meaning.Torn() },
  { entry: Option.some(Entry.Link()), meaning: Meaning.Linked() },
]

const PAIRS = [build(installedDotfiles, provenFork), build(laneHead, provenFork), build(aggregateHead, checkoutFork)]

/** The script for a seed: 3 to 8 whole states, each held for 1 to 6 reads, moving the record, the receipt and the handoff marker. */
const scriptOf = (seed: number): ReadonlyArray<Step> => {
  const next = generator(seed)
  const pick = <A>(all: ReadonlyArray<A>, fallback: A) => Option.getOrElse(Arr.get(all, next(all.length)), () => fallback)
  const first = pick(PAIRS, build(base, base))
  const moves: ReadonlyArray<(record: FixtureRecord) => FixtureRecord> = [(record) => staged(record, pick(PAIRS, first)), promoted, provenNow, rolledBack]
  const walk = { record: installedAs(first, Option.some(first)), receipt: next(receiptStates.length), handoff: false }
  const steps: Array<Step> = []
  for (const _state of Arr.range(1, 3 + next(6))) {
    const torn = next(8) === 0
    const whole = encodeRecord(walk.record)
    const installed = text(Match.value(torn).pipe(Match.when(true, () => whole.slice(0, whole.length - 9)), Match.orElse(() => whole)))
    const entries: Array<readonly [string, Entry]> = [["installed", installed]]
    for (const entry of Option.toArray(Option.flatMap(Arr.get(receiptStates, walk.receipt), (each) => each.entry))) entries.push([ROUND_KEY, entry])
    if (walk.handoff) entries.push(["handoff", text('{"pid":1}')])
    const step: Step = { files: files(entries), record: walk.record, torn, receipt: walk.receipt }
    for (const _read of Arr.range(1, 1 + next(6))) steps.push(step)
    walk.record = pick(moves, provenNow)(walk.record)
    if (next(3) === 0) walk.receipt = next(receiptStates.length)
    walk.handoff = next(5) === 0
  }
  return steps
}

/** How many scripts a seed plays. */
const SCRIPTS = 40

seeded("generated source transitions between read boundaries: one complete proven pair, absent, refused, or a reason to read again; never a composite pair or an invented green", ({ seed, expect }) =>
  Effect.gen(function* () {
    const seen = yield* Effect.forEach(Arr.range(1, SCRIPTS), (index) => checkScript(seed * SCRIPTS + index, expect))
    // Each seed's scripts reach every kind of outcome, so the oracle is exercised on each.
    expect([seed, Arr.sort(Arr.dedupe(seen), Order.String)]).toEqual([seed, ["proven", "unproven", "unsettled"]])
  }),
)

/** One generated script, frozen and checked against the oracle: which kind of outcome it reached. */
const checkScript = (seed: number, expect: Seed.Seeded["expect"]) =>
  Effect.gen(function* () {
    const steps = scriptOf(seed)
    const { outcome, served } = yield* run(
      steps.map((each) => each.files),
      { receipts: [{ head: laneHead, kind: "round" }], lands: [], install: true },
    )
    // The oracle walks what was served, two reads per source: two reads that differ, a handoff marker seen, or a failed
    // read must fail and be read again; else each answer is the script's meaning of the one state both reads saw.
    const unsettled = Arr.chunksOf(served, 2).some((pair) => {
      const first = Arr.headNonEmpty(pair)
      const differ = Option.exists(Arr.get(pair, 1), (second) => !Equal.equals(first.entry, second.entry))
      const broken = Option.exists(first.entry, Entry.$is("Broken"))
      return differ || broken || (first.key === "handoff" && Option.isSome(first.entry))
    })
    if (unsettled) {
      expect([seed, Option.map(failureWords(outcome), (words) => words.startsWith("unsettled "))]).toEqual([seed, Option.some(true)])
      return "unsettled"
    }
    const snapshot = yield* Effect.orDie(Effect.fromResult(outcome))
    const stepAt = (key: string) => Option.flatMap(Arr.findFirst(served, (each) => each.key === key), (read) => Arr.get(steps, read.state))
    const meaning = Option.getOrElse(Option.flatMap(stepAt(ROUND_KEY), (step) => Option.map(Arr.get(receiptStates, step.receipt), (each) => each.meaning)), () => Meaning.None())
    const kept = snapshot.receipts.map((each) => ({ tree: each.input.tree, codes: each.input.checks.map((check) => check.code) }))
    const want: ReadonlyArray<unknown> = Meaning.$match(meaning, {
        None: () => [seed, [], [ROUND_KEY], []],
        Valid: (valid) => [seed, [{ tree: valid.tree, codes: valid.codes }], [], []],
        Torn: () => [seed, [], [], [{ source: ROUND_KEY, reason: "not a receipt" }]],
        Linked: () => [seed, [], [], [{ source: ROUND_KEY, reason: "a link" }]],
      })
    const have: ReadonlyArray<unknown> = [seed, kept, snapshot.absent, snapshot.refused]
    expect(have).toEqual(want)
    const expected = Option.flatMap(
      Option.filter(stepAt("installed"), (step) => !step.torn),
      (step) => provenPair(step.record),
    )
    const install = Option.fromNullishOr(snapshot.install)
    const got = Option.flatMap(install, (each) => Match.value(each).pipe(Match.tag("Proven", (proven) => Option.some({ dotfiles: proven.receipt.dotfiles, fork: proven.receipt.fork })), Match.orElse(() => Option.none())))
    expect([seed, got]).toEqual([seed, expected])
    return Option.match(got, { onNone: () => "unproven", onSome: () => "proven" })
  })

seeded("the host's files: only allowlisted regular files are read; a link, a folder, an oversized file, a bad name or an unreadable file is refused or unreadable, never absent or followed", ({ expect }) =>
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
    const places = { host: HOST, repository: { key: "dotfiles", checkouts: [path.join(root, "checkout")] }, receipts, installed: path.join(root, "state", "installed.json"), handoff: path.join(root, "state", "handoff.json"), maxBytes: 4096 }
    const source = Context.get(yield* Layer.build(receiptSource(places)), ReceiptSource)
    const read = (head: string) => Effect.result(source.read(SourceRef.Receipt({ head, kind: "round" })))
    expect(yield* read(laneHead)).toEqual(Result.succeed(SourceRead.Present({ text: valid })))
    expect(yield* read(outerHead)).toEqual(Result.succeed(SourceRead.Refused({ reason: "a link" })))
    expect(yield* read(aggregateHead)).toEqual(Result.succeed(SourceRead.Refused({ reason: "not a regular file" })))
    expect(yield* read(base)).toEqual(Result.succeed(SourceRead.Refused({ reason: "too large" })))
    expect(yield* read(installedDotfiles)).toEqual(Result.succeed(SourceRead.Absent()))
    expect(yield* read("../outside/secret")).toEqual(Result.succeed(SourceRead.Refused({ reason: "not a commit name" })))
    expect(Result.isFailure(yield* read(laneTree))).toBe(true)
    expect(yield* Effect.result(source.read(SourceRef.Installed()))).toEqual(Result.succeed(SourceRead.Absent()))
    const scopes = [path.join(root, "checkout", ".work", "lane"), `${path.join(root, "checkout")}/../outside`, "relative/checkout"].map(source.repositoryOf)
    expect(scopes).toEqual([Option.some("dotfiles"), Option.none(), Option.none()])
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
)
