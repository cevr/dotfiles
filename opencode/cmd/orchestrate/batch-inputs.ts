// A review's frozen inputs, wired (mods/orchestrate/batch-input.ts): the producers' own formats at the boundary
// (Work's `Receipt` and `LandRecord` schemas, the updater's record through filestore/receipt-source.ts) and the host's
// receipt files. The plugin's composition root provides `layer` where a review freezes its inputs.
import { type LandFacts, objectName, type ReceiptFacts, ReceiptFormats } from "@dotfiles/opencode-orchestrate/batch-input"
import { installedFacts, type ReceiptPlaces, receiptSource } from "@dotfiles/opencode-orchestrate/filestore/receipt-source"
import { type LandRecord, LandRecordJson, type Receipt, ReceiptJson } from "@dotfiles/opencode-work/receipt"
import { Layer, Option, Schema } from "effect"
import { Digest } from "effect/crypto"

const decodeReceipt = Schema.decodeUnknownOption(ReceiptJson)
const decodeLand = Schema.decodeUnknownOption(LandRecordJson)

/**
 * A Work receipt as the review reads it: its head and tree decoded as full object names (none when either is not
 * one: an abbreviation is never resolved), each command and its exit (its time is the run's, not evidence).
 */
const receiptFacts = (receipt: Receipt): Option.Option<ReceiptFacts> =>
  Option.all({ head: objectName(receipt.head), tree: objectName(receipt.tree) }).pipe(
    Option.map(({ head, tree }) => ({
      repo: receipt.repo,
      head,
      tree,
      kind: receipt.kind,
      checks: receipt.checks.map((check) => ({ command: check.command, code: check.code })),
      at: receipt.at,
    })),
  )

/** A Work land record as the review reads it: none unless its head, base and every receipt inside it name full objects. */
const landFacts = (record: LandRecord): Option.Option<LandFacts> =>
  Option.all({
    head: objectName(record.head),
    base: objectName(record.base),
    units: Option.all(record.units.map((unit) => Option.map(receiptFacts(unit.receipt), (receipt) => ({ branch: unit.branch, by: unit.by, receipt })))),
    merge: Option.match(record.merge, { onNone: () => Option.some(Option.none<ReceiptFacts>()), onSome: (merge) => Option.map(receiptFacts(merge), Option.some) }),
  }).pipe(Option.map((facts) => ({ ...facts, at: record.at })))

/** The producers' formats: Work's schemas for receipts and land records (a unit's checkout path left out), the updater's for its record. */
export const formats = Layer.succeed(
  ReceiptFormats,
  ReceiptFormats.of({
    receipt: (text) => Option.flatMap(decodeReceipt(text), receiptFacts),
    land: (text) => Option.flatMap(decodeLand(text), landFacts),
    installed: installedFacts,
  }),
)

/** Everything `freeze` needs on a host: its receipt files at `places`, the formats, and SHA-256 over Web Crypto. */
export const layer = (places: ReceiptPlaces) => Layer.mergeAll(receiptSource(places), formats, Digest.layerWebCrypto)
