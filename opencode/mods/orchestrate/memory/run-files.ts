// The runs' files held in memory, for the plugin's tests: each file's text and when it was written, by path. The
// readers are the ones the disk's adapter uses (tools.ts), over these files.
import { Array as Arr, Clock, Effect, Layer, Option } from "effect"
import { RunFiles } from "../service.ts"
import { batchHeadOf, findingsBeside, findingsVerdictOf, holdsVerdict, isBatchPlace, newestRound, newestVerified, requestHeadOf, type UnitFiles, type Verified } from "../tools.ts"

/** A file: its text and when it was written (epoch ms). */
export interface File {
  readonly text: string
  readonly at: number
}

/** The files, by absolute path. */
export type Files = Map<string, File>

const under = (dir: string) => `${dir.replace(/\/+$/, "")}/`

/** The files directly in `dir`, by name. */
const namesIn = (files: Files, dir: string): ReadonlyArray<string> =>
  [...files.keys()].flatMap((path) => Option.toArray(Option.filter(Option.liftPredicate(path.slice(under(dir).length), () => path.startsWith(under(dir))), (name) => !name.includes("/"))))

const fileAt = (files: Files, path: string) => Option.fromUndefinedOr(files.get(path))
const textOf = (files: Files, path: string) => Option.map(fileAt(files, path), (file) => file.text)

/** A unit dir's newest request and findings, as the disk's adapter reads them. */
const unitFilesOf = (files: Files, dir: string): UnitFiles => {
  const names = namesIn(files, dir)
  return {
    unit: Option.getOrElse(Arr.last(dir.replace(/\/+$/, "").split("/")), () => dir),
    dir,
    request: Option.map(newestRound(names, "request"), ({ round, name }) => ({ round, path: `${under(dir)}${name}`, head: Option.flatMap(textOf(files, `${under(dir)}${name}`), requestHeadOf) })),
    findings: Option.map(newestRound(names, "findings"), ({ round, name }) => ({ round, path: `${under(dir)}${name}`, verdict: Option.flatMap(textOf(files, `${under(dir)}${name}`), findingsVerdictOf) })),
  }
}

/** The verify a batch file at `path` records, when it sits where a run dir's batch files go and its findings hold a verdict. */
const verifiedAt = (files: Files, runDirs: ReadonlyArray<string>, path: string): Option.Option<Verified> =>
  Option.flatMap(Arr.findFirst(runDirs, (dir) => path.startsWith(under(dir))), (run) => {
    if (!isBatchPlace(path.slice(under(run).length))) return Option.none()
    const findings = Option.filter(fileAt(files, findingsBeside(path)), (found) => holdsVerdict(found.text))
    return Option.zipWith(Option.flatMap(textOf(files, path), batchHeadOf), findings, (head, found) => ({ file: path, head, at: found.at }))
  })

export const layer = (files: Files) =>
  Layer.succeed(
    RunFiles,
    RunFiles.of({
      verified: (runDirs) => Effect.sync(() => newestVerified([...files.keys()].flatMap((path) => Option.toArray(verifiedAt(files, runDirs, path))))),
      units: (runDir) =>
        Effect.sync(() =>
          // A unit dir holds log.md; the world of a test that keeps its logs apart has its requests instead.
          Arr.dedupe(
            [...files.keys()].flatMap((path) =>
              Option.toArray(Option.liftPredicate(path.slice(0, path.lastIndexOf("/")), () => path.startsWith(under(runDir)) && /\/(?:log|round-\d+-request)\.md$/.test(path))),
            ),
          ).flatMap((dir) => Option.toArray(Option.liftPredicate(dir, () => !dir.slice(under(runDir).length).includes("/"))).map((found) => unitFilesOf(files, found))),
        ),
      unit: (unitDir) => Effect.sync(() => unitFilesOf(files, unitDir)),
      write: (path, text) => Effect.map(Clock.currentTimeMillis, (at) => void files.set(path, { text, at })),
    }),
  )
