// Why a commitment is not done now, or why it was closed: a reason class and a referent the plugin checks, never
// prose. The public payload is `{ reason_class, referent }`, the referent a tagged pointer:
//
//   guarantee  → { kind: "invariant", id }  a repository-local invariant the root declared (`commitments invariant`)
//              → { kind: "spec-item", id }  an accepted spec item (unit C)
//   dependency → { kind: "commitment", id } an open commitment of this record, not itself, its chain open and acyclic
//              → { kind: "unit", id }        an unlanded unit (unit D)
//              → { kind: "owner-question", id } an open owner question (units D, E)
//   measured   → { kind: "receipt", path }   a structured receipt under the checkout's evidence root (below)
//
// Each decodes to a closed union and encodes once to its canonical pointer (`invariant/<id>`, `commitment/<id>`,
// `receipt/<path>`), the record's `referent` column, decoded strictly on read. A kind whose source has not shipped is
// refused by name, with the unit that brings it. `measured` orders, never closes; a close's reason is a guarantee.
//
// The receipt a measured reason names is a file the checkout holds under `tmp/orchestrate/` (the runs' folders), read
// through the host's FileSystem and Path, never run. Version 1 of its envelope, as JSON:
//
//   { "receipt": 1, "command": "<the command, one line>", "exit": <its exit code>,
//     "output": { "path": "<a file under the same root>" } | { "value": "<its output, one line>" },
//     "run": "<the run, a slug>", "checkout": "<the commit it ran at, 7 to 40 hex>" }
//
// Nothing else is accepted (no `validated` field, no extra key). The reader checks that the receipt and its output
// file are regular files inside the root after every link is resolved, and bounded; it hashes both (SHA-256) and the
// record keeps the hashes, the exit, the run and the commit: pointers and hashes, never the output or the command.
import { Effect, Layer, Match, Option, Predicate, Result, Schema, Stream } from "effect"
import { Digest } from "effect/crypto"
import { FileSystem, Path } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { printed, type Printable, printable } from "./printable.ts"
import { Evidence, EvidenceRefused } from "./service.ts"

export const REASON_CLASSES = ["guarantee", "dependency", "measured"] as const
export type ReasonClass = (typeof REASON_CLASSES)[number]

export const REFERENT_KINDS = ["invariant", "spec-item", "commitment", "unit", "owner-question", "receipt"] as const
export type ReferentKind = (typeof REFERENT_KINDS)[number]

/** The referent kinds each class takes. */
export const KINDS_OF: Readonly<Record<ReasonClass, ReadonlyArray<ReferentKind>>> = {
  guarantee: ["invariant", "spec-item"],
  dependency: ["commitment", "unit", "owner-question"],
  measured: ["receipt"],
}

/** The kinds whose source has not shipped, each with the unit that brings it: refused by name until then. */
export const UNAVAILABLE: ReadonlyMap<ReferentKind, string> = new Map([
  ["spec-item", "spec-items (unit C)"],
  ["unit", "hand-back-tools (unit D)"],
  ["owner-question", "hand-back-tools and question-reasons (units D, E)"],
])

/** The root under the checkout a receipt and its output live in: the runs' folders. */
export const EVIDENCE_ROOT = "tmp/orchestrate"
/** The longest pointer the record keeps (its `referent` column's CHECK). */
export const POINTER_MAX = 512
/** The largest receipt the reader reads, bytes. */
export const RECEIPT_MAX = 64 * 1024
/** The largest output file the reader hashes, bytes. */
export const OUTPUT_MAX = 16 * 1024 * 1024

const SLUG = "[A-Za-z0-9][A-Za-z0-9._-]{0,79}"
const SEGMENT = "[A-Za-z0-9._-]+"
/** A checkout-relative path: segments of letters, digits, `.`, `_`, `-`, none `.` or `..`, no leading or doubled `/`. */
const RELATIVE = new RegExp(`^(?!(?:${SEGMENT}/)*\\.{1,2}(?:/|$))${SEGMENT}(?:/${SEGMENT})*$`)
const SLUG_ONLY = new RegExp(`^${SLUG}$`)
/** A canonical pointer: `<kind>/<slug>`, or `receipt/<path under the evidence root>`. */
const POINTER = new RegExp(`^(?:(?:invariant|spec-item|commitment|unit|owner-question)/${SLUG}|receipt/${EVIDENCE_ROOT}/(?!(?:${SEGMENT}/)*\\.{1,2}(?:/|$))${SEGMENT}(?:/${SEGMENT})*)$`)

/** A referent, decoded: one of the six kinds, each with its own field. */
export type Referent =
  | { readonly kind: "invariant" | "spec-item" | "commitment" | "unit" | "owner-question"; readonly id: string }
  | { readonly kind: "receipt"; readonly path: string }

/** A reason: its class and what it points at. */
export interface Reason {
  readonly reasonClass: ReasonClass
  readonly referent: Referent
}

/** A canonical pointer, as the record keeps it: checked against the grammar on every decode. */
export const Pointer = Schema.String.check(Schema.isPattern(POINTER), Schema.isMaxLength(POINTER_MAX))
export type Pointer = typeof Pointer.Type

/** A reason as an event and a row keep it: its class and its canonical pointer. */
export const ReasonData = Schema.Struct({ reasonClass: Schema.Literals(REASON_CLASSES), referent: Pointer })
export interface ReasonData extends Schema.Schema.Type<typeof ReasonData> {}

/** The public payload's referent, as a tool or the CLI takes it. */
export const ReferentInput = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["invariant", "spec-item", "commitment", "unit", "owner-question"]), id: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("receipt"), path: Schema.String }),
])
export type ReferentInput = typeof ReferentInput.Type

/** The pointer of a referent: encoded once, here. */
export const pointerOf = (referent: Referent): string =>
  Match.value(referent).pipe(
    Match.when({ kind: "receipt" }, (receipt) => `receipt/${receipt.path}`),
    Match.orElse((named) => `${named.kind}/${named.id}`),
  )

/** A pointer decoded strictly: the referent it names, or none for anything the grammar does not take. */
export const referentOf = (pointer: string): Option.Option<Referent> => {
  if (!POINTER.test(pointer) || pointer.length > POINTER_MAX) return Option.none()
  const at = pointer.indexOf("/")
  const kind = pointer.slice(0, at)
  const rest = pointer.slice(at + 1)
  if (kind === "receipt") return Option.some({ kind, path: rest })
  return Option.map(
    Option.fromUndefinedOr(REFERENT_KINDS.find((each): each is Exclude<ReferentKind, "receipt"> => each === kind && each !== "receipt")),
    (named) => ({ kind: named, id: rest }),
  )
}

/** A stored reason as the domain reads it: the class and the referent its pointer decodes to. */
export const reasonOf = (data: ReasonData): Option.Option<Reason> => Option.map(referentOf(data.referent), (referent) => ({ reasonClass: data.reasonClass, referent }))

/** A reason as the record keeps it. */
export const dataOf = (reason: Reason): ReasonData => ({ reasonClass: reason.reasonClass, referent: pointerOf(reason.referent) })

/** The reason a pointer and class name, in a line: `guarantee invariant/root-owns`. */
export const lineOf = (data: ReasonData): Printable => printed`${printable(data.reasonClass)} ${printable(data.referent)}`

/** Why `path` is not a checkout-relative path the record takes, else none. The path is never repeated. */
const pathRefusal = (what: string, path: string): Option.Option<string> =>
  Option.liftPredicate(`${what} is not a checkout-relative path (segments of letters, digits, ".", "_", "-"; no "." or ".." segment)`, () => !RELATIVE.test(path))

/**
 * A caller's `{ reason_class, referent }` checked and canonicalised: the class takes the kind, the kind has shipped, the
 * id is a slug and a receipt's path a normalised path under the evidence root; else why not. Nothing a caller says of
 * its own evidence is taken: the referent is a pointer, and what it points at is checked where it is used.
 */
export const reasonFrom = (reasonClass: ReasonClass, input: ReferentInput): Result.Result<Reason, string> => {
  const kind = input.kind
  if (!KINDS_OF[reasonClass].includes(kind)) return Result.fail(`a ${reasonClass} reason takes a referent of kind ${KINDS_OF[reasonClass].join(" or ")}; ${kind} is not one`)
  const ships = UNAVAILABLE.get(kind)
  if (Predicate.isNotUndefined(ships)) return Result.fail(`a ${kind} referent is not available yet: it ships with ${ships}`)
  if ("path" in input) {
    const path = input.path
    const refused = Option.orElse(pathRefusal("the receipt's path", path), () =>
      Option.liftPredicate(`the receipt's path is not under ${EVIDENCE_ROOT}/ (the runs' folders)`, () => !path.startsWith(`${EVIDENCE_ROOT}/`)),
    )
    if (Option.isSome(refused)) return Result.fail(refused.value)
    const referent: Referent = { kind: "receipt", path }
    if (pointerOf(referent).length > POINTER_MAX) return Result.fail(`the receipt's pointer is longer than ${POINTER_MAX} characters`)
    return Result.succeed({ reasonClass, referent })
  }
  if (!SLUG_ONLY.test(input.id)) return Result.fail(`the ${kind} id is not a slug (letters, digits, ".", "_", "-", at most 80, starting with a letter or digit); the value is not repeated`)
  return Result.succeed({ reasonClass, referent: { kind: input.kind, id: input.id } })
}

// ── What the host's files say: receipts and declared documents ──

/** A receipt as the reader found it: its path, the SHA-256 of its bytes and of its output, its exit, run and commit. */
export const ReceiptSeen = Schema.Struct({
  path: Schema.String,
  receiptSha: Schema.String,
  outputSha: Schema.String,
  exit: Schema.Int,
  run: Schema.String,
  checkout: Schema.String,
})
export interface ReceiptSeen extends Schema.Schema.Type<typeof ReceiptSeen> {}

/** A declared invariant's document as git holds it: its path, its blob at the checkout's HEAD, and that HEAD. */
export const DocumentSeen = Schema.Struct({ path: Schema.String, blob: Schema.String, commit: Schema.String })
export interface DocumentSeen extends Schema.Schema.Type<typeof DocumentSeen> {}

/** The receipt envelope, version 1 (see the top of this file): exactly these keys. */
export const ReceiptEnvelope = Schema.Struct({
  receipt: Schema.Literal(1),
  command: Schema.String,
  exit: Schema.Int,
  output: Schema.Union([Schema.Struct({ path: Schema.String }), Schema.Struct({ value: Schema.String })]),
  run: Schema.String,
  checkout: Schema.String,
})
export type ReceiptEnvelope = typeof ReceiptEnvelope.Type

const decodeEnvelope = Schema.decodeUnknownResult(Schema.fromJsonString(ReceiptEnvelope))
const HEAD = /^[0-9a-f]{7,40}$/
const ONE_LINE = /^[^\n\r]+$/

/** Why an envelope's fields do not make a receipt (said of `subject`, as "the receipt's"), else none. No field's value is repeated. */
export const envelopeRefusal = (envelope: ReceiptEnvelope, subject: string): Option.Option<string> => {
  const output = envelope.output
  const outputRefusal = Match.value(output).pipe(
    Match.when({ value: Match.string }, (each) =>
      Option.liftPredicate(`${subject} output value is not one line of at most 200 characters that says something`, () => each.value.trim() === "" || !ONE_LINE.test(each.value) || each.value.length > 200),
    ),
    Match.orElse((each) => Option.orElse(pathRefusal(`${subject} output path`, each.path), () => Option.liftPredicate(`${subject} output path is not under ${EVIDENCE_ROOT}/`, () => !each.path.startsWith(`${EVIDENCE_ROOT}/`)))),
  )
  return Option.firstSomeOf([
    Option.liftPredicate(`${subject} command is not one line of at most 500 characters that says something`, () => envelope.command.trim() === "" || !ONE_LINE.test(envelope.command) || envelope.command.length > 500),
    Option.liftPredicate(`${subject} run is not a slug`, () => !SLUG_ONLY.test(envelope.run)),
    Option.liftPredicate(`${subject} checkout is not a commit (7 to 40 lowercase hex digits)`, () => !HEAD.test(envelope.checkout)),
    outputRefusal,
  ])
}

const refused = (reason: string) => new EvidenceRefused({ reason: printable(reason) })

/** What git prints for `args` in `dir`, trimmed, when it exits 0 and prints something; else none. Bounded in time. */
const gitOut = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"], dir: string, args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(ChildProcess.make("git", ["-C", dir, ...args], { stdin: "ignore", stderr: "ignore", forceKillAfter: "3 seconds" }))
      const [code, out] = yield* Effect.all([handle.exitCode, handle.stdout.pipe(Stream.decodeText(), Stream.mkString)], { concurrency: 2 })
      return Option.filter(Option.some(out.trim()), (text) => Number(code) === 0 && text !== "")
    }),
  ).pipe(Effect.timeoutOption("10 seconds"), Effect.map(Option.flatten), Effect.orElseSucceed(() => Option.none<string>()))

/**
 * The reader on the host's files, paths and processes, and the plugin's digest: a receipt and its output, or a
 * declared document, each a regular file inside its root once every link is resolved, bounded, and hashed (a
 * receipt) or found in git at HEAD (a document). It runs nothing a receipt names.
 */
export const evidenceLayer = Layer.effect(
  Evidence,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const paths = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const digest = yield* Digest.Digest
    /**
     * The checkout's top, canonical: git's top, else the directory itself, every link in it resolved once. A link above
     * the checkout (macOS's /var → /private/var) is resolved here and is legitimate; every root below is held to it.
     */
    const topOf = (checkout: string) =>
      Effect.flatMap(Effect.map(gitOut(spawner, checkout, ["rev-parse", "--show-toplevel"]), Option.getOrElse(() => checkout)), (top) =>
        Effect.mapError(fs.realPath(top), () => refused("the checkout is not a directory this host reads")),
      )
    /**
     * An approved root: `relative` under the canonical `top`, as the configuration names it, approved only when its own
     * real path is that very path. A root that is a link, or sits under one, inside the checkout (`tmp/orchestrate`
     * linked out of it) is refused, never followed: the root is configured, not discovered through a link.
     */
    const approvedRoot = (top: string, relative: string, what: string) =>
      Effect.gen(function* () {
        const root = paths.join(top, relative)
        const real = yield* Effect.mapError(fs.realPath(root), () => refused(`${what} does not exist`))
        if (real !== root) return yield* Effect.fail(refused(`${what} is reached through a link: it is not an approved root`))
        return root
      })
    /**
     * The one containment rule every reader of a referent's file uses: `relative` under the approved `root`, a regular
     * file of at most `max` bytes whose real path is inside `root`; its real path.
     */
    const regularIn = (root: string, relative: string, what: string, max: number) =>
      Effect.gen(function* () {
        const real = yield* Effect.mapError(fs.realPath(paths.join(root, relative)), () => refused(`${what} does not exist`))
        if (!real.startsWith(`${root}${paths.sep}`)) return yield* Effect.fail(refused(`${what} resolves outside its root`))
        const info = yield* Effect.mapError(fs.stat(real), () => refused(`${what} cannot be read`))
        if (info.type !== "File") return yield* Effect.fail(refused(`${what} is not a regular file`))
        if (Number(info.size) > max) return yield* Effect.fail(refused(`${what} is larger than ${max} bytes`))
        return real
      })
    /**
     * `relative`'s bytes, read under the containment rule, and its real path the same after the read: a root or a folder
     * swapped for a link between the check and the read is refused, not read through.
     */
    const readIn = (root: string, relative: string, what: string, max: number) =>
      Effect.gen(function* () {
        const real = yield* regularIn(root, relative, what, max)
        const bytes = yield* Effect.mapError(fs.readFile(real), () => refused(`${what} cannot be read`))
        const after = yield* regularIn(root, relative, what, max)
        if (after !== real) return yield* Effect.fail(refused(`${what} moved while it was read`))
        return bytes
      })
    const shaOf = (bytes: Uint8Array) => digest.digestHex(Digest.sha256, bytes)
    return Evidence.of({
      receipt: (checkout, path) =>
        Effect.gen(function* () {
          if (!path.startsWith(`${EVIDENCE_ROOT}/`)) return yield* Effect.fail(refused(`the receipt is not under ${EVIDENCE_ROOT}/`))
          const top = yield* topOf(checkout)
          const root = yield* approvedRoot(top, EVIDENCE_ROOT, `the checkout's ${EVIDENCE_ROOT}/`)
          const bytes = yield* readIn(root, path.slice(EVIDENCE_ROOT.length + 1), "the receipt", RECEIPT_MAX)
          const envelope = yield* Result.match(decodeEnvelope(new TextDecoder().decode(bytes), { onExcessProperty: "error" }), {
            onFailure: () => Effect.fail(refused("the receipt is not a version 1 receipt envelope (receipt, command, exit, output, run, checkout; nothing else)")),
            onSuccess: Effect.succeed,
          })
          const why = envelopeRefusal(envelope, "the receipt's")
          if (Option.isSome(why)) return yield* Effect.fail(refused(why.value))
          const output = envelope.output
          const outputBytes = yield* Match.value(output).pipe(
            Match.when({ path: Match.string }, (each) => readIn(root, each.path.slice(EVIDENCE_ROOT.length + 1), "the receipt's output file", OUTPUT_MAX)),
            Match.orElse((each) => Effect.succeed(new TextEncoder().encode(each.value))),
          )
          return { path, receiptSha: yield* shaOf(bytes), outputSha: yield* shaOf(outputBytes), exit: envelope.exit, run: envelope.run, checkout: envelope.checkout }
        }),
      document: (checkout, path) =>
        Effect.gen(function* () {
          const refusal = pathRefusal("the document's path", path)
          if (Option.isSome(refusal)) return yield* Effect.fail(refused(refusal.value))
          const top = yield* topOf(checkout)
          yield* regularIn(top, path, "the document", Number.MAX_SAFE_INTEGER)
          const commit = yield* gitOut(spawner, top, ["rev-parse", "--verify", "HEAD"])
          const blob = yield* gitOut(spawner, top, ["rev-parse", "--verify", `HEAD:${path}`])
          return yield* Option.match(Option.all([blob, commit]), {
            onNone: () => Effect.fail(refused("the document is not in git at HEAD: commit it, then declare the invariant")),
            onSome: ([held, at]) => Effect.succeed({ path, blob: held, commit: at }),
          })
        }),
    })
  }),
)

/** A reader that finds nothing: a host with no files to read (the simulated host's record, a stand-in). */
export const noEvidence = Layer.succeed(
  Evidence,
  Evidence.of({
    receipt: () => Effect.fail(refused("this host reads no receipts")),
    document: () => Effect.fail(refused("this host reads no documents")),
  }),
)

/** A reader over maps: what a model or a stand-in says the host's files hold, by checkout-relative path. */
export const evidenceOf = (receipts: ReadonlyMap<string, ReceiptSeen>, documents: ReadonlyMap<string, DocumentSeen>) =>
  Evidence.of({
    receipt: (_checkout, path) => Option.match(Option.fromUndefinedOr(receipts.get(path)), { onNone: () => Effect.fail(refused("the receipt does not exist")), onSome: Effect.succeed }),
    document: (_checkout, path) => Option.match(Option.fromUndefinedOr(documents.get(path)), { onNone: () => Effect.fail(refused("the document does not exist")), onSome: Effect.succeed }),
  })
