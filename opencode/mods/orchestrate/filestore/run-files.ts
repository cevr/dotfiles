// The runs' files on disk, read at each call: a unit dir's newest request and findings, the verifies the run dirs
// record, and the one file the plugin writes (a verify's batch file). What cannot be read is none.
import { file, Glob, write } from "bun"
import { Array as Arr, Effect, Layer, Option } from "effect"
import { RunFiles, RunFileUnwritten } from "../service.ts"
import { batchHeadOf, findingsBeside, findingsVerdictOf, holdsVerdict, isBatchPlace, newestRound, newestVerified, requestHeadOf, type UnitFiles, type Verified } from "../tools.ts"

/** `name` in `dir`. */
const at = (dir: string, name: string) => `${dir.replace(/\/+$/, "")}/${name}`

/** A directory's entry names; none when it cannot be read. */
const namesIn = (dir: string) => Effect.tryPromise(() => Array.fromAsync(new Glob("*").scan({ cwd: dir, onlyFiles: false, dot: true }))).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))

/** A file's text; none when it cannot be read. */
const textOf = (path: string) => Effect.tryPromise(() => file(path).text()).pipe(Effect.option)

/** A path's stat; none when it is not there. */
const statOf = (path: string) => Effect.tryPromise(() => file(path).stat()).pipe(Effect.option)

/** An effect over an option's value: none stays none. */
const traverse = <A, B>(option: Option.Option<A>, f: (a: A) => Effect.Effect<B>): Effect.Effect<Option.Option<B>> =>
  Option.match(option, { onNone: () => Effect.succeed(Option.none()), onSome: (a) => Effect.map(f(a), Option.some) })

/** A unit dir's newest request (and the head it names) and findings (and the verdict its first line states). */
const unitFilesOf = Effect.fn("RunFiles.unitFilesOf")(function* (dir: string) {
  const names = yield* namesIn(dir)
  const request = yield* traverse(newestRound(names, "request"), ({ round, name }) =>
    Effect.map(textOf(at(dir, name)), (text) => ({ round, path: at(dir, name), head: Option.flatMap(text, requestHeadOf) })),
  )
  const findings = yield* traverse(newestRound(names, "findings"), ({ round, name }) =>
    Effect.map(textOf(at(dir, name)), (text) => ({ round, path: at(dir, name), verdict: Option.flatMap(text, findingsVerdictOf) })),
  )
  return { unit: Option.getOrElse(Arr.last(dir.replace(/\/+$/, "").split("/")), () => dir), dir, request, findings } satisfies UnitFiles
})

/** The verify a batch file records: the head it names, when its findings beside it hold a verdict line. */
const verifiedOf = Effect.fn("RunFiles.verifiedOf")(function* (batch: string) {
  const head = Option.flatMap(yield* textOf(batch), batchHeadOf)
  const findings = findingsBeside(batch)
  const verdict = Option.filter(yield* textOf(findings), holdsVerdict)
  const written = yield* statOf(findings)
  return Option.flatMap(Option.all({ head, verdict, written }), (found) => Option.some<Verified>({ file: batch, head: found.head, at: found.written.mtimeMs }))
})

/** Each verify a run dir records: a batch file (`verify-*\/batch-*.md` or `batch-<k>.md`) naming a head, whose findings beside it hold a verdict line. */
const verifiesIn = Effect.fn("RunFiles.verifiesIn")(function* (runDir: string) {
  const names = yield* namesIn(runDir)
  const dirs = names.filter((name) => name.startsWith("verify-"))
  const nested = yield* Effect.forEach(dirs, (dir) => Effect.map(namesIn(at(runDir, dir)), (inner) => inner.map((name) => `${dir}/${name}`)), { concurrency: 4 })
  const batches = [...names, ...nested.flat()].flatMap((relative) => Option.toArray(Option.map(Option.liftPredicate(relative, isBatchPlace), (place) => at(runDir, place))))
  return (yield* Effect.forEach(batches, verifiedOf, { concurrency: 4 })).flatMap(Option.toArray)
})

export const layer = Layer.succeed(
  RunFiles,
  RunFiles.of({
    verified: (runDirs) => Effect.map(Effect.forEach(runDirs, verifiesIn, { concurrency: 4 }), (found) => newestVerified(found.flat())),
    units: Effect.fn("RunFiles.units")(function* (runDir: string) {
      const dirs = (yield* namesIn(runDir)).map((name) => at(runDir, name))
      const logged = yield* Effect.forEach(dirs, (dir) => Effect.map(statOf(at(dir, "log.md")), (log) => Option.as(log, dir)), { concurrency: 4 })
      return yield* Effect.forEach(logged.flatMap(Option.toArray), unitFilesOf, { concurrency: 4 })
    }),
    unit: unitFilesOf,
    write: (path, text) =>
      Effect.tryPromise({
        try: () => write(path, text, { createPath: true }),
        catch: (cause) => new RunFileUnwritten({ path, message: String(cause) }),
      }),
  }),
)
