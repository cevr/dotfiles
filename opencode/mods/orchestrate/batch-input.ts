// The inputs of an exact review, frozen. A review names what it reviews by immutable evidence: the receipts a check
// run left (`<head>.<kind>.json`), the records a land left (`<head>.land.json`), and the host's proven installed
// pair (the updater's `installed.json`). Those files are lookups, not identities: a later run overwrites one, an
// install moves the record. So a review reads each one whole, twice (and the installed record between two reads of
// the handoff marker), keeps the bytes it read with their digest and a canonical projection of what they say, and
// answers one snapshot: every input whole from one stable read, or a typed reason to read again. Never a pair made
// of two reads, never a result stamped against another head, never a green the files do not hold.
//
// The source (ReceiptSource) is a port: the filestore reads only its allowlisted files, by typed reference and
// never by a caller's path. The formats (ReceiptFormats) are the producers' own schemas (Work's receipts and land
// records, the updater's record), bound at the composition root.
import { Array as Arr, Context, Data, Effect, Equal, Option, Order, Result, Schema } from "effect"
import { Digest } from "effect/crypto"

/**
 * A full Git object name (a commit or a tree), lower-case hex: 40 digits in a SHA-1 repository, 64 in a SHA-256 one.
 * Every head, tree and base a snapshot projects has this type, decoded at the producer's boundary: a record naming
 * anything else (an abbreviation, upper case, a ref name) is refused whole, and nothing here resolves an
 * abbreviation. One record may not mix the two lengths: a repository has one object format.
 */
export const ObjectName = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)).pipe(Schema.brand("ObjectName"))
export type ObjectName = typeof ObjectName.Type

/** Whether `text` is a full object name. */
export const isObjectName = Schema.is(ObjectName)

/** `text` as a full object name; none for anything else. */
export const objectName = Schema.decodeUnknownOption(ObjectName)

/** Whether the names all have one length (one object format). */
export const oneFormat = (names: ReadonlyArray<ObjectName>): boolean => Arr.dedupe(names.map((name) => name.length)).length <= 1

/** The kinds of run a receipt records (Work's `ReceiptKind`). */
export const EvidenceKind = Schema.Literals(["round", "merge", "accept", "deep"])
export type EvidenceKind = typeof EvidenceKind.Type

/** What the source is asked for: a receipt by head and kind, a land record by its pushed head, the installed record, the handoff marker. */
export type SourceRef = Data.TaggedEnum<{
  Receipt: { readonly head: string; readonly kind: EvidenceKind }
  Land: { readonly head: string }
  Installed: {}
  Handoff: {}
}>
export const SourceRef = Data.taggedEnum<SourceRef>()

/** The name a reference carries in a snapshot: no path, only what it asks for. */
export const sourceKey = (ref: SourceRef): string =>
  SourceRef.$match(ref, {
    Receipt: (each) => `receipt:${each.head}.${each.kind}`,
    Land: (each) => `land:${each.head}`,
    Installed: () => "installed",
    Handoff: () => "handoff",
  })

/**
 * One read: no such file, the whole file, or a file the source will not read (a link, not a regular file, too large,
 * not UTF-8), with why. `Present.text` is the file's exact bytes as strict UTF-8 with any byte-order mark kept, so
 * its UTF-8 encoding is the file byte for byte: a digest of it is the digest of the file. Two reads are the same
 * observation only when every field is equal, the refusal's reason included.
 */
export type SourceRead = Data.TaggedEnum<{
  Absent: {}
  Present: { readonly text: string }
  Refused: { readonly reason: string }
}>
export const SourceRead = Data.taggedEnum<SourceRead>()

/** A read that failed for another reason than absence (permissions, I/O): never taken for absent. */
export class SourceUnreadable extends Schema.TaggedError<SourceUnreadable>()("SourceUnreadable", { source: Schema.String, message: Schema.String }) {}

/**
 * Where a review's inputs are read: one host's receipts folder and installed record for one repository.
 * - `host`: the host this source OBSERVES the files on (its configuration). Work's receipts and land records and
 *   the updater's record name no producing host, so a snapshot's `observedOn` proves only where the bytes were
 *   read, never where they were made: bytes copied from another host's folder read as this host's.
 * - `repository`: the repository key every input read here is stamped with.
 * - `repositoryOf`: the repository a checkout path (a receipt's `repo`) belongs to; none outside this repository's checkouts.
 * - `read`: one whole read of the file a reference names, or why there is none.
 */
export class ReceiptSource extends Context.Service<
  ReceiptSource,
  {
    readonly host: string
    readonly repository: string
    readonly repositoryOf: (checkout: string) => Option.Option<string>
    readonly read: (ref: SourceRef) => Effect.Effect<SourceRead, SourceUnreadable>
  }
>()("dotfiles-opencode/orchestrate/ReceiptSource") {}

/** One command of a receipt, as its producer wrote it. */
export interface CheckFacts {
  readonly command: string
  readonly code: number
}

/** A receipt as Work's `Receipt` schema decodes it, its head and tree full object names of one format. */
export interface ReceiptFacts {
  readonly repo: string
  readonly head: ObjectName
  readonly tree: ObjectName
  readonly kind: EvidenceKind
  readonly checks: ReadonlyArray<CheckFacts>
  readonly at: string
}

/** A land record as Work's `LandRecord` schema decodes it (a unit's checkout path left out), every name in it full and of one format. */
export interface LandFacts {
  readonly head: ObjectName
  readonly base: ObjectName
  readonly units: ReadonlyArray<{ readonly branch: string; readonly by: string; readonly receipt: ReceiptFacts }>
  readonly merge: Option.Option<ReceiptFacts>
  readonly at: string
}

/** A build as the updater's record names it, its two commits full object names. */
export interface BuildFacts {
  readonly version: string
  readonly dotfiles: ObjectName
  readonly fork: ObjectName
}

/** The updater's record, through its own `buildOf` (installed, when it names its commits) and `goodOf` (last health-proven). */
export interface InstalledFacts {
  readonly installed: Option.Option<BuildFacts>
  readonly good: Option.Option<BuildFacts>
}

/** The producers' formats: each decodes a file's text, none for text that is not one. */
export class ReceiptFormats extends Context.Service<
  ReceiptFormats,
  {
    readonly receipt: (text: string) => Option.Option<ReceiptFacts>
    readonly land: (text: string) => Option.Option<LandFacts>
    readonly installed: (text: string) => Option.Option<InstalledFacts>
  }
>()("dotfiles-opencode/orchestrate/ReceiptFormats") {}

/** A check as a snapshot shows it: the digest of its command (the command itself stays in the restricted artifact) and its exit. */
export const CheckInput = Schema.Struct({ id: Schema.String, code: Schema.Number })

/** A receipt's canonical projection: what it proves, of which repository, head and tree, and the host it was read on (`observedOn`: where the bytes were observed, not who produced them). */
export const ReceiptInput = Schema.Struct({
  schema: Schema.Literal("receipt-input/v1"),
  producer: Schema.Literal("work"),
  kind: EvidenceKind,
  repository: Schema.String,
  observedOn: Schema.String,
  head: ObjectName,
  tree: ObjectName,
  checks: Schema.Array(CheckInput),
  at: Schema.String,
})
export interface ReceiptInput extends Schema.Schema.Type<typeof ReceiptInput> {}

/** A frozen receipt: its identity (the digest of its projection), the projection, and every source it was read from. */
export const FrozenReceipt = Schema.Struct({ id: Schema.String, input: ReceiptInput, sources: Schema.Array(Schema.String) })
export interface FrozenReceipt extends Schema.Schema.Type<typeof FrozenReceipt> {}

/** A land record's projection: the pushed head, its base, each unit's round receipt and the merge check by identity. */
export const LandInput = Schema.Struct({
  schema: Schema.Literal("land-input/v1"),
  repository: Schema.String,
  observedOn: Schema.String,
  head: ObjectName,
  base: ObjectName,
  units: Schema.Array(Schema.Struct({ branch: Schema.String, by: Schema.String, receipt: Schema.String })),
  merge: Schema.NullOr(Schema.String),
  at: Schema.String,
  digest: Schema.String,
})
export interface LandInput extends Schema.Schema.Type<typeof LandInput> {}

export const FrozenLand = Schema.Struct({ id: Schema.String, input: LandInput })
export interface FrozenLand extends Schema.Schema.Type<typeof FrozenLand> {}

/** The immutable install receipt a review uses: the proven installed pair in the record read on `host` (the observing source's host; the record names none), and the digest of the record's exact bytes. */
export const InstallReceipt = Schema.Struct({
  schema: Schema.Literal("install-receipt/v1"),
  host: Schema.String,
  buildId: Schema.String,
  dotfiles: ObjectName,
  fork: ObjectName,
  proven: Schema.String,
})
export interface InstallReceipt extends Schema.Schema.Type<typeof InstallReceipt> {}

/** Why a host has no proven installed pair now: no record, a record that does not decode, one naming no commits, or an installed build no health check proved. */
export const Unproven = Schema.Literals(["missing", "corrupt", "unnamed", "unproven", "refused"])
export type Unproven = typeof Unproven.Type

/** The host's proven installed pair, frozen. */
export const Proven = Schema.TaggedStruct("Proven", { id: Schema.String, receipt: InstallReceipt })
/** No proven installed pair on the host now, and why. */
export const Unavailable = Schema.TaggedStruct("Unavailable", { host: Schema.String, reason: Unproven })
export const InstallState = Schema.Union([Proven, Unavailable])
export type InstallState = typeof InstallState.Type

/** An input the source would not give, or gave in a form that proves nothing: by its source key, with why. */
export const RefusedInput = Schema.Struct({ source: Schema.String, reason: Schema.String })

/**
 * The bytes a snapshot read, by digest: restricted (they may hold commands and paths), never shown by `publicView`.
 * `text` is the file exactly as read (CRLF, padding and key order as written: only the projections are canonical);
 * its UTF-8 encoding is the file's bytes and `digest` their SHA-256.
 */
export const Artifact = Schema.Struct({ digest: Schema.String, text: Schema.String })

/**
 * Everything a review reads, frozen: the receipts and land records by identity, the install state, the inputs absent
 * or refused (an absent input proves nothing: it stays owed), and the bytes behind each, all in canonical order.
 */
export const InputSnapshot = Schema.Struct({
  schema: Schema.Literal("input-snapshot/v1"),
  id: Schema.String,
  host: Schema.String,
  repository: Schema.String,
  receipts: Schema.Array(FrozenReceipt),
  lands: Schema.Array(FrozenLand),
  install: Schema.NullOr(InstallState),
  absent: Schema.Array(Schema.String),
  refused: Schema.Array(RefusedInput),
  artifacts: Schema.Array(Artifact),
})
export interface InputSnapshot extends Schema.Schema.Type<typeof InputSnapshot> {}

/** What a review asks to freeze: receipts by head and kind, land records by pushed head, and whether the install. */
export interface InputRequest {
  readonly receipts: ReadonlyArray<{ readonly head: string; readonly kind: EvidenceKind }>
  readonly lands: ReadonlyArray<string>
  readonly install: boolean
}

/** A source that did not hold still while it was read (two reads differ, an install handoff ran), or could not be read: read again. */
export class InputUnsettled extends Schema.TaggedError<InputUnsettled>()("InputUnsettled", {
  source: Schema.String,
  reason: Schema.Literals(["changed", "handoff", "unreadable"]),
}) {}

/** Two sources give one identity (repository, head, kind) two different contents: neither is taken. */
export class InputConflict extends Schema.TaggedError<InputConflict>()("InputConflict", { key: Schema.String, ids: Schema.Array(Schema.String) }) {}

const SnapshotJson = Schema.fromJsonString(InputSnapshot)
const encodeSnapshot = Schema.encodeSync(SnapshotJson)
const decodeSnapshot = Schema.decodeUnknownOption(SnapshotJson)
const encodeReceiptInput = Schema.encodeSync(Schema.fromJsonString(ReceiptInput))
const encodeLandInput = Schema.encodeSync(Schema.fromJsonString(LandInput))
const encodeInstall = Schema.encodeSync(Schema.fromJsonString(InstallReceipt))
const PublicSnapshot = InputSnapshot.mapFields(({ artifacts: _artifacts, ...rest }) => ({ ...rest, artifacts: Schema.Array(Schema.String) }))
const encodePublic = Schema.encodeSync(Schema.fromJsonString(PublicSnapshot))

/** A snapshot's canonical bytes: the same snapshot always the same text. */
export const snapshotText = (snapshot: InputSnapshot): string => encodeSnapshot(snapshot)

/** A snapshot from its canonical bytes; none for text that is not one. */
export const parseSnapshot = (text: string): Option.Option<InputSnapshot> => decodeSnapshot(text)

/** What a reader who may not see the restricted artifacts sees: the snapshot with each artifact as its digest alone. */
export const publicView = (snapshot: InputSnapshot): string => encodePublic({ ...snapshot, artifacts: snapshot.artifacts.map((each) => each.digest) })

const encoder = new TextEncoder()

/** The SHA-256 of `text`'s UTF-8 bytes, lower-case hex. */
const digestOf = (text: string) => Effect.flatMap(Digest.Digest, (digest) => digest.digestHex(Digest.sha256, encoder.encode(text)))

/** One source read twice: the same observation both times (every field, a refusal's reason too), else unsettled. */
const stableRead = Effect.fn("BatchInput.stableRead")(function* (ref: SourceRef) {
  const source = yield* ReceiptSource
  const key = sourceKey(ref)
  const read = source.read(ref).pipe(Effect.mapError(() => new InputUnsettled({ source: key, reason: "unreadable" })))
  const first = yield* read
  const second = yield* read
  if (!Equal.equals(first, second)) return yield* new InputUnsettled({ source: key, reason: "changed" })
  return first
})

/** What freezing gathers before it is canonical. */
interface Gathered {
  readonly receipts: ReadonlyArray<{ readonly id: string; readonly input: ReceiptInput; readonly source: string }>
  readonly lands: ReadonlyArray<FrozenLand>
  readonly absent: ReadonlyArray<string>
  readonly refused: ReadonlyArray<{ readonly source: string; readonly reason: string }>
  readonly artifacts: ReadonlyArray<{ readonly digest: string; readonly text: string }>
}

const EMPTY: Gathered = { receipts: [], lands: [], absent: [], refused: [], artifacts: [] }

const joined = (all: ReadonlyArray<Gathered>): Gathered => ({
  receipts: all.flatMap((each) => each.receipts),
  lands: all.flatMap((each) => each.lands),
  absent: all.flatMap((each) => each.absent),
  refused: all.flatMap((each) => each.refused),
  artifacts: all.flatMap((each) => each.artifacts),
})

const refusal = (source: string, reason: string): Gathered => ({ ...EMPTY, refused: [{ source, reason }] })

/** Why a decoded receipt cannot stand for `head` and `kind` in this repository, if it cannot. */
const receiptFault = (facts: ReceiptFacts, head: string, kind: EvidenceKind, repository: Option.Option<string>): Option.Option<string> => {
  if (facts.head !== head) return Option.some("names another head")
  if (facts.kind !== kind) return Option.some("names another kind")
  if (!oneFormat([facts.head, facts.tree])) return Option.some("mixes object formats")
  if (Option.isNone(repository)) return Option.some("outside the repository")
  return Option.none()
}

/** A decoded receipt's projection and identity. */
const project = Effect.fn("BatchInput.project")(function* (facts: ReceiptFacts) {
  const source = yield* ReceiptSource
  const checks = yield* Effect.forEach(facts.checks, (check) => Effect.map(digestOf(check.command), (id) => ({ id, code: check.code })))
  const input: ReceiptInput = {
    schema: "receipt-input/v1",
    producer: "work",
    kind: facts.kind,
    repository: source.repository,
    observedOn: source.host,
    head: facts.head,
    tree: facts.tree,
    checks,
    at: facts.at,
  }
  return { id: yield* digestOf(encodeReceiptInput(input)), input }
})

/** One receipt by head and kind, frozen, absent or refused. */
const freezeReceipt = Effect.fn("BatchInput.freezeReceipt")(function* (head: string, kind: EvidenceKind) {
  const ref = SourceRef.Receipt({ head, kind })
  const key = sourceKey(ref)
  if (!isObjectName(head)) return refusal(key, "not a commit name")
  const read = yield* stableRead(ref)
  if (read._tag === "Absent") return { ...EMPTY, absent: [key] }
  if (read._tag === "Refused") return refusal(key, read.reason)
  const formats = yield* ReceiptFormats
  const source = yield* ReceiptSource
  const decoded = formats.receipt(read.text)
  if (Option.isNone(decoded)) return refusal(key, "not a receipt")
  const fault = receiptFault(decoded.value, head, kind, source.repositoryOf(decoded.value.repo))
  if (Option.isSome(fault)) return refusal(key, fault.value)
  const frozen = yield* project(decoded.value)
  return { ...EMPTY, receipts: [{ ...frozen, source: key }], artifacts: [{ digest: yield* digestOf(read.text), text: read.text }] }
})

/** Every object name a land record carries: its head and base, each unit receipt's and the merge check's head and tree. */
const namesOf = (facts: LandFacts): ReadonlyArray<ObjectName> => [
  facts.head,
  facts.base,
  ...[...facts.units.map((unit) => unit.receipt), ...Option.toArray(facts.merge)].flatMap((receipt) => [receipt.head, receipt.tree]),
]

/** Why a land record cannot stand for `head` in this repository, if it cannot: each unit's round receipt and the merge check must be this repository's, of their own head. */
const landFault = (facts: LandFacts, head: string, repositoryOf: (checkout: string) => Option.Option<string>): Option.Option<string> => {
  if (facts.head !== head) return Option.some("names another head")
  if (!oneFormat(namesOf(facts))) return Option.some("mixes object formats")
  const unit = Arr.findFirst(facts.units, (each) => Option.isSome(receiptFault(each.receipt, each.receipt.head, "round", repositoryOf(each.receipt.repo))))
  if (Option.isSome(unit)) return Option.some(`unit ${unit.value.branch}: not a round receipt of this repository`)
  return Option.flatMap(facts.merge, (merge) =>
    Option.map(receiptFault(merge, head, "merge", repositoryOf(merge.repo)), (why) => `merge check: ${why}`),
  )
}

/** One land record by pushed head, frozen with its units' round receipts and its merge check, each evidence of its own head only. */
const freezeLand = Effect.fn("BatchInput.freezeLand")(function* (head: string) {
  const ref = SourceRef.Land({ head })
  const key = sourceKey(ref)
  if (!isObjectName(head)) return refusal(key, "not a commit name")
  const read = yield* stableRead(ref)
  if (read._tag === "Absent") return { ...EMPTY, absent: [key] }
  if (read._tag === "Refused") return refusal(key, read.reason)
  const formats = yield* ReceiptFormats
  const source = yield* ReceiptSource
  const decoded = formats.land(read.text)
  if (Option.isNone(decoded)) return refusal(key, "not a land record")
  const facts = decoded.value
  const fault = landFault(facts, head, source.repositoryOf)
  if (Option.isSome(fault)) return refusal(key, fault.value)
  const units = yield* Effect.forEach(facts.units, (unit) => Effect.map(project(unit.receipt), (frozen) => ({ unit, frozen })))
  const merge = yield* Effect.transposeOption(Option.map(facts.merge, project))
  const digest = yield* digestOf(read.text)
  const input: LandInput = {
    schema: "land-input/v1",
    repository: source.repository,
    observedOn: source.host,
    head: facts.head,
    base: facts.base,
    units: units.map(({ unit, frozen }) => ({ branch: unit.branch, by: unit.by, receipt: frozen.id })),
    merge: Option.getOrNull(Option.map(merge, (each) => each.id)),
    at: facts.at,
    digest,
  }
  const embedded = [...units.map((each) => each.frozen), ...Option.toArray(merge)].map((frozen) => ({ ...frozen, source: key }))
  return { ...EMPTY, receipts: embedded, lands: [{ id: yield* digestOf(encodeLandInput(input)), input }], artifacts: [{ digest, text: read.text }] }
})

const sameBuild = (a: BuildFacts, b: BuildFacts): boolean => a.version === b.version && a.dotfiles === b.dotfiles && a.fork === b.fork

/** The record's proven installed build, or why it proves none: no build named, or the installed build is not the proven one. */
const provenOf = (facts: InstalledFacts): Result.Result<BuildFacts, Unproven> => {
  if (Option.isNone(facts.installed)) return Result.fail("unnamed")
  const build = facts.installed.value
  if (!Option.exists(facts.good, (good) => sameBuild(good, build))) return Result.fail("unproven")
  return Result.succeed(build)
}

/** Fails unsettled while the install handoff runs. */
const noHandoff = Effect.fn("BatchInput.noHandoff")(function* () {
  const marker = yield* stableRead(SourceRef.Handoff())
  if (marker._tag !== "Absent") return yield* new InputUnsettled({ source: sourceKey(SourceRef.Handoff()), reason: "handoff" })
})

/**
 * The host's installed pair as one immutable install receipt: the record read whole twice between two reads of the
 * handoff marker, its installed build (`buildOf`) and its last proven build (`goodOf`) the same version and the same
 * two commits. A staged build proves nothing; a promoted build no health check proved is unproven; a rollback
 * yields the known-good pair it installed again.
 */
const freezeInstall = Effect.fn("BatchInput.freezeInstall")(function* () {
  const source = yield* ReceiptSource
  const formats = yield* ReceiptFormats
  const unavailable = (reason: Unproven) => ({ state: Unavailable.make({ host: source.host, reason }), artifacts: EMPTY.artifacts })
  yield* noHandoff()
  const read = yield* stableRead(SourceRef.Installed())
  yield* noHandoff()
  if (read._tag === "Absent") return unavailable("missing")
  if (read._tag === "Refused") return unavailable("refused")
  const decoded = formats.installed(read.text)
  if (Option.isNone(decoded)) return unavailable("corrupt")
  const checked = provenOf(decoded.value)
  if (Result.isFailure(checked)) return unavailable(checked.failure)
  const build = checked.success
  const proven = yield* digestOf(read.text)
  const receipt: InstallReceipt = { schema: "install-receipt/v1", host: source.host, buildId: build.version, dotfiles: build.dotfiles, fork: build.fork, proven }
  return { state: Proven.make({ id: yield* digestOf(encodeInstall(receipt)), receipt }), artifacts: [{ digest: proven, text: read.text }] }
})

const byString = Order.String

/** The receipts gathered, one per identity with every source it came from; two identities for one (repository, head, kind) conflict. */
const settle = (receipts: Gathered["receipts"]) =>
  Effect.gen(function* () {
    const byId = Arr.groupBy(receipts, (each) => each.id)
    const frozen = Arr.sort(
      Object.values(byId).map((group) => {
        const first = Arr.headNonEmpty(group)
        return { id: first.id, input: first.input, sources: Arr.sort(Arr.dedupe(group.map((each) => each.source)), byString) }
      }),
      Order.mapInput(byString, (each: FrozenReceipt) => each.id),
    )
    const byKey = Arr.groupBy(frozen, (each) => `${each.input.repository}:${each.input.head}:${each.input.kind}`)
    const clash = Arr.findFirst(Object.entries(byKey), ([, group]) => group.length > 1)
    if (Option.isSome(clash)) return yield* new InputConflict({ key: clash.value[0], ids: clash.value[1].map((each) => each.id) })
    return frozen
  })

/** Artifacts by digest, each once, in digest order. */
const artifactsOf = (all: Gathered["artifacts"]) =>
  Arr.sort(
    Arr.dedupeWith(all, (a, b) => a.digest === b.digest),
    Order.mapInput(byString, (each: { readonly digest: string }) => each.digest),
  )

/**
 * Freezes what `request` names into one snapshot, every input from one stable read: or fails `InputUnsettled` (read
 * again) or `InputConflict`. Its id is the digest of its canonical bytes, so the same inputs always make the same id
 * whatever order they were asked in.
 */
export const freeze = Effect.fn("BatchInput.freeze")(function* (request: InputRequest) {
  const source = yield* ReceiptSource
  const wanted = Arr.dedupeWith(request.receipts, (a, b) => a.head === b.head && a.kind === b.kind)
  const receipts = yield* Effect.forEach(wanted, (each) => freezeReceipt(each.head, each.kind))
  const lands = yield* Effect.forEach(Arr.dedupe(request.lands), freezeLand)
  const gathered = joined([...receipts, ...lands])
  const install = yield* Effect.transposeOption(Option.liftPredicate(request.install, (wantsIt) => wantsIt).pipe(Option.map(() => freezeInstall())))
  const body = {
    schema: "input-snapshot/v1" as const,
    host: source.host,
    repository: source.repository,
    receipts: yield* settle(gathered.receipts),
    lands: Arr.sort(gathered.lands, Order.mapInput(byString, (each: FrozenLand) => each.id)),
    install: Option.getOrNull(Option.map(install, (each) => each.state)),
    absent: Arr.sort(Arr.dedupe(gathered.absent), byString),
    refused: Arr.sort(gathered.refused, Order.mapInput(byString, (each: { readonly source: string }) => each.source)),
    artifacts: artifactsOf([...gathered.artifacts, ...Option.match(install, { onNone: () => EMPTY.artifacts, onSome: (each) => each.artifacts })]),
  }
  const id = yield* digestOf(encodeSnapshot({ ...body, id: "" }))
  return { ...body, id }
})
