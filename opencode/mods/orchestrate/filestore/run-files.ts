// The runs' files on disk, read at each call: a unit dir's newest request and findings, the verifies the run dirs
// record, and the one file the plugin writes (a verify's batch file). What cannot be read is none.
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { Effect, Layer, Option } from "effect"
import { RunFiles, RunFileUnwritten } from "../service.ts"
import { batchHeadOf, findingsBeside, findingsVerdictOf, holdsVerdict, isBatchFile, newestRound, newestVerified, requestHeadOf, type UnitFiles, type Verified } from "../tools.ts"

/** A directory's entry names; none when it cannot be read. */
const namesIn = (dir: string) => Effect.tryPromise(() => readdir(dir)).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))

/** A file's text; none when it cannot be read. */
const textOf = (path: string) => Effect.tryPromise(() => readFile(path, "utf8")).pipe(Effect.option)

/** A path's stat; none when it is not there. */
const statOf = (path: string) => Effect.tryPromise(() => stat(path)).pipe(Effect.option)

/** An effect over an option's value: none stays none. */
const traverse = <A, B>(option: Option.Option<A>, f: (a: A) => Effect.Effect<B>): Effect.Effect<Option.Option<B>> =>
  Option.match(option, { onNone: () => Effect.succeed(Option.none()), onSome: (a) => Effect.map(f(a), Option.some) })

/** A unit dir's newest request (and the head it names) and findings (and the verdict its first line states). */
const unitFilesOf = Effect.fn("RunFiles.unitFilesOf")(function* (dir: string) {
  const names = yield* namesIn(dir)
  const request = yield* traverse(newestRound(names, "request"), ({ round, name }) =>
    Effect.map(textOf(join(dir, name)), (text) => ({ round, path: join(dir, name), head: Option.flatMap(text, requestHeadOf) })),
  )
  const findings = yield* traverse(newestRound(names, "findings"), ({ round, name }) =>
    Effect.map(textOf(join(dir, name)), (text) => ({ round, path: join(dir, name), verdict: Option.flatMap(text, findingsVerdictOf) })),
  )
  return { unit: basename(dir), dir, request, findings } satisfies UnitFiles
})

/** The verify a batch file records: the head it names, when its findings beside it hold a verdict line. */
const verifiedOf = Effect.fn("RunFiles.verifiedOf")(function* (batch: string) {
  const head = Option.flatMap(yield* textOf(batch), batchHeadOf)
  const findings = findingsBeside(batch)
  const verdict = Option.filter(yield* textOf(findings), holdsVerdict)
  const written = yield* statOf(findings)
  return Option.flatMap(Option.all({ head, verdict, written }), (found) => Option.some<Verified>({ file: batch, head: found.head, at: found.written.mtimeMs }))
})

/** Each verify a run dir records: a `verify-*\/batch-*.md` naming a head, whose findings beside it hold a verdict line. */
const verifiesIn = Effect.fn("RunFiles.verifiesIn")(function* (runDir: string) {
  const dirs = (yield* namesIn(runDir)).filter((name) => name.startsWith("verify-")).map((name) => join(runDir, name))
  const batches = (yield* Effect.forEach(dirs, (dir) => Effect.map(namesIn(dir), (names) => names.filter(isBatchFile).map((name) => join(dir, name))), { concurrency: 4 })).flat()
  return (yield* Effect.forEach(batches, verifiedOf, { concurrency: 4 })).flatMap(Option.toArray)
})

export const layer = Layer.succeed(
  RunFiles,
  RunFiles.of({
    verified: (runDirs) => Effect.map(Effect.forEach(runDirs, verifiesIn, { concurrency: 4 }), (found) => newestVerified(found.flat())),
    units: Effect.fn("RunFiles.units")(function* (runDir: string) {
      const dirs = (yield* namesIn(runDir)).map((name) => join(runDir, name))
      const logged = yield* Effect.forEach(dirs, (dir) => Effect.map(statOf(join(dir, "log.md")), (log) => Option.as(log, dir)), { concurrency: 4 })
      return yield* Effect.forEach(logged.flatMap(Option.toArray), unitFilesOf, { concurrency: 4 })
    }),
    unit: unitFilesOf,
    write: (path, text) =>
      Effect.tryPromise({
        try: () => mkdir(dirname(path), { recursive: true }).then(() => writeFile(path, text)),
        catch: (cause) => new RunFileUnwritten({ path, message: String(cause) }),
      }),
  }),
)
