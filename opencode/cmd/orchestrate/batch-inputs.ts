// A review's frozen inputs, wired (mods/orchestrate/batch-input.ts): the producers' own formats at the boundary
// (Work's `Receipt` and `LandRecord` schemas, the updater's record through filestore/run-records.ts) and the host's
// receipt files. The plugin's composition root provides `layer` where a review freezes its inputs.
import { type ReceiptFacts, ReceiptFormats } from "@dotfiles/opencode-orchestrate/batch-input"
import { installedFacts, type ReceiptPlaces, receiptSource } from "@dotfiles/opencode-orchestrate/filestore/run-records"
import { LandRecordJson, type Receipt, ReceiptJson } from "@dotfiles/opencode-work/receipt"
import { Layer, Option, Schema } from "effect"
import { Digest } from "effect/crypto"

const decodeReceipt = Schema.decodeUnknownOption(ReceiptJson)
const decodeLand = Schema.decodeUnknownOption(LandRecordJson)

/** A Work receipt as the review reads it: each command and its exit (its time is the run's, not evidence). */
const receiptFacts = (receipt: Receipt): ReceiptFacts => ({
  repo: receipt.repo,
  head: receipt.head,
  tree: receipt.tree,
  kind: receipt.kind,
  checks: receipt.checks.map((check) => ({ command: check.command, code: check.code })),
  at: receipt.at,
})

/** The producers' formats: Work's schemas for receipts and land records (a unit's checkout path left out), the updater's for its record. */
export const formats = Layer.succeed(
  ReceiptFormats,
  ReceiptFormats.of({
    receipt: (text) => Option.map(decodeReceipt(text), receiptFacts),
    land: (text) =>
      Option.map(decodeLand(text), (record) => ({
        head: record.head,
        base: record.base,
        units: record.units.map((unit) => ({ branch: unit.branch, by: unit.by, receipt: receiptFacts(unit.receipt) })),
        merge: Option.map(record.merge, receiptFacts),
        at: record.at,
      })),
    installed: installedFacts,
  }),
)

/** Everything `freeze` needs on a host: its receipt files at `places`, the formats, and SHA-256 over Web Crypto. */
export const layer = (places: ReceiptPlaces) => Layer.mergeAll(receiptSource(places), formats, Digest.layerWebCrypto)
