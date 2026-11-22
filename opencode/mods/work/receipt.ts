// Receipts: what a check run leaves behind, so a land takes it instead of running the check again. A
// receipt names the checkout it ran in, the head and the tree it checked (the tracked files as they were
// on disk), the kind of run, each command with its exit and time, and when it ended. A Rift's round gate
// (scripts/gate.ts), or any proof of its round run or attested through scripts/receipt.ts (focused tests,
// mutants, a model run, real-host laws, a verifier's verdict), writes its `round` receipt into the Rift; a land takes it while it names the Rift's
// head and tree now, and runs the Rift's focused gate (`rift.focus`) in the land when it does not. The
// land's merge check (`rift.mergeCheck`) and the background accept and deep runs write theirs too, for
// the next batch's verifier, in the host's receipts folder beside the land logs.
import { Array as Arr, Data, Option, Schema } from "effect"

/** One command of a run: what ran, its exit code, and how long it took in seconds. */
export const ReceiptCheck = Schema.Struct({ command: Schema.String, code: Schema.Number, seconds: Schema.Number })
export type ReceiptCheck = typeof ReceiptCheck.Type

/**
 * What kind of run wrote it: `round` (a Rift's round gate, or its focused gate a land ran), `merge` (a
 * land's merge check of the merged tree), `accept` (the batch's acceptance run), `deep` (the post-land deep run).
 */
export const ReceiptKind = Schema.Literals(["round", "merge", "accept", "deep"])
export type ReceiptKind = typeof ReceiptKind.Type

export const Receipt = Schema.Struct({
  /** The checkout the run ran in. */
  repo: Schema.String,
  head: Schema.String,
  /** The tree the run checked: the tracked files as they were on disk when it started. */
  tree: Schema.String,
  kind: ReceiptKind,
  checks: Schema.Array(ReceiptCheck),
  /** When it ended, ISO 8601. */
  at: Schema.String,
})
export type Receipt = typeof Receipt.Type

export const ReceiptJson = Schema.fromJsonString(Receipt)

/** Where a checkout stands: its head and the tree of its tracked files as they are on disk. */
export interface Snapshot {
  readonly head: string
  readonly tree: string
}

/** A run that ran at least one command, every one of them exiting 0. */
export const green = (receipt: Receipt): boolean => Arr.isReadonlyArrayNonEmpty(receipt.checks) && receipt.checks.every((check) => check.code === 0)

/** What a Rift's newest round receipt says of it now: it covers its head and tree, it names another, it is red, or there is none. */
export type Standing = Data.TaggedEnum<{
  Current: { readonly receipt: Receipt }
  Moved: { readonly receipt: Receipt }
  Red: { readonly receipt: Receipt }
  Missing: {}
}>
export const Standing = Data.taggedEnum<Standing>()

/** How the newest round receipt stands against the checkout's state now. */
export const standing = (newest: Option.Option<Receipt>, now: Snapshot): Standing =>
  Option.match(newest, {
    onNone: () => Standing.Missing(),
    onSome: (receipt) => {
      if (receipt.head !== now.head || receipt.tree !== now.tree) return Standing.Moved({ receipt })
      if (!green(receipt)) return Standing.Red({ receipt })
      return Standing.Current({ receipt })
    },
  })

/** One argument as `sh` reads it back: in single quotes, each quote of its own closed, escaped and reopened. */
const quoted = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`

/**
 * The focused gate a land runs in a Rift with no current receipt: `rift.focus` with `{paths}` the files the
 * Rift changed (absolute, quoted for `sh`) and `{threads}` its thread share. A repository that names none
 * has its Rifts bring their receipts; the land never runs the full gate for one.
 */
export const focusLine = (template: string, paths: ReadonlyArray<string>, threads: number): string =>
  template.replaceAll("{paths}", paths.map(quoted).join(" ")).replaceAll("{threads}", String(threads))

/** The thread share of a land's focused gate: a quarter of the host's cores, at least one. */
export const shareOf = (cores: number): number => Math.max(1, Math.floor(cores / 4))

/** How a landed Rift was covered: by the receipt it held, or by the focused gate the land ran for it, and why. */
export interface Covered {
  readonly branch: string
  readonly path: string
  readonly receipt: Receipt
  /** `held`: its receipt was current; else why the land ran its focused gate. */
  readonly by: "held" | "missing" | "moved" | "red"
}

/** What a land took and ran, kept in the host's receipts folder under the pushed head for the next batch's verifier. */
export const LandRecord = Schema.Struct({
  head: Schema.String,
  base: Schema.String,
  units: Schema.Array(
    Schema.Struct({ branch: Schema.String, path: Schema.String, receipt: Receipt, by: Schema.Literals(["held", "missing", "moved", "red"]) }),
  ),
  merge: Schema.OptionFromNullOr(Receipt),
  at: Schema.String,
})
export type LandRecord = typeof LandRecord.Type

export const LandRecordJson = Schema.fromJsonString(LandRecord)
