// The owed post-land steps and accept checks, with the newest load reading at or past the cores, in one JSON file beside the
// land logs (`<logs>/post-land-owed.json`), so a server restart keeps them. A write goes to a temporary file
// renamed over the old one, so a reader never sees half of one; a missing file holds nothing owed, and one
// that cannot be decoded is kept aside as `post-land-owed.json.bad-<ms>` (said in the log, never written
// over) and holds nothing owed. The first version's file, the owed steps alone as an array, reads as those
// steps with no loaded reading.
//
// Every rift plugin instance on the host (OpenCode loads one per directory it serves) and every process
// shares the file, so a read and a change of it hold `locks/post-land-owed.lock` (a reader moving a bad file
// aside never moves one a writer just wrote), a change from its read to its write, and the
// post-land claim is `locks/post-land.lock`, both flock(2) locks beside the land locks.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Array as Arr, Clock, Effect, Layer, Option, Schema } from "effect"
import { Debts, noDebts, OwedPostLand } from "../owed.ts"
import { holding, holdingIfFree } from "../process/flock.ts"
import { PostLandClaim, PostLandDebts, RiftFailed } from "../service.ts"

/** The file under the land logs that holds the owed steps. */
export const debtsFile = (logs: string): string => join(logs, "post-land-owed.json")

/** The lock files beside `file`'s land logs: one held across each change of it, one the post-land claim. */
export const claimFiles = (file: string) => ({
  change: join(dirname(file), "locks", "post-land-owed.lock"),
  claim: join(dirname(file), "locks", "post-land.lock"),
})

const Stored = Schema.fromJsonString(Debts)
const decode = Schema.decodeUnknownOption(Stored)
const decodeFirst = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(OwedPostLand)))
const encode = Schema.encodeSync(Stored)

/** What the file's text holds: the current form, else the first version's; none when it is neither. */
const parse = (text: string): Option.Option<Debts> =>
  Option.orElse(decode(text), () => Option.map(decodeFirst(text), (owed): Debts => ({ owed, accepts: [], loadedAt: Option.none() })))

const failed = (operation: string) => (cause: unknown) => new RiftFailed({ operation, message: String(cause) })

/** The names a file kept aside at `at` goes under, in order: the first free one is taken. */
const asideNames = (file: string, at: number): ReadonlyArray<string> => [`${file}.bad-${at}`, ...Array.from({ length: 9 }, (_, index) => `${file}.bad-${at}-${index + 2}`)]

export const layer = (file: string) => {
  const locks = claimFiles(file)
  const change = <A, E, R>(effect: Effect.Effect<A, E, R>) => holding([[locks.change, "exclusive"]], effect)
  /** Moves the file that cannot be decoded aside, never over another kept aside; answers where it went. */
  const setAside = Effect.flatMap(Clock.currentTimeMillis, (at) =>
    Effect.try({
      try: () => {
        const names = asideNames(file, at)
        const name = Option.getOrElse(Arr.findFirst(names, (each) => !existsSync(each)), () => `${file}.bad-${at}-last`)
        renameSync(file, name)
        return name
      },
      catch: failed("keep aside the owed post-land steps that cannot be decoded"),
    }),
  )
  /**
   * What the file holds, read under the change lock: nothing before the first write; a file that cannot be
   * decoded is kept aside (`<file>.bad-<ms>`) and said, never written over, and nothing read from it is owed,
   * so nothing runs or wakes on it.
   */
  const readKept = Effect.gen(function* () {
    const text = yield* Effect.try({
      try: () => Option.map(Option.liftPredicate(file, existsSync), (path) => readFileSync(path, "utf8")),
      catch: failed("read the owed post-land steps"),
    })
    if (Option.isNone(text)) return noDebts
    const parsed = parse(text.value)
    if (Option.isSome(parsed)) return parsed.value
    const aside = yield* setAside
    yield* Effect.logWarning(`work: the owed post-land steps in ${file} could not be decoded; the file is kept aside as ${aside}, and nothing in it is owed`)
    return noDebts
  })
  const read = change(readKept)
  const write = (debts: Debts) =>
    Effect.try({
      try: () => {
        mkdirSync(dirname(file), { recursive: true })
        const next = `${file}.next`
        writeFileSync(next, encode(debts))
        renameSync(next, file)
        return debts
      },
      catch: failed("write the owed post-land steps"),
    })
  return Layer.mergeAll(
    Layer.succeed(
      PostLandDebts,
      PostLandDebts.of({
        read,
        update: (next) => change(Effect.flatMap(readKept, (kept) => write(next(kept)))),
      }),
    ),
    Layer.succeed(
      PostLandClaim,
      PostLandClaim.of({
        hold: (effect) => holding([[locks.claim, "exclusive"]], effect),
        holdIfFree: (effect) => holdingIfFree(locks.claim, effect),
      }),
    ),
  )
}
