// What a run dir keeps about the skill, as files: the version the run last
// saw in `<run dir>/skill-version` (skill-drift.ts `SEEN_FILE`), the
// "Departs from" lines of the run's own top-level Markdown files (common.md,
// plan.md, rules files; unit dirs are the units', not the run's), and the
// run's own log.md, where a verdict's fleet line goes.
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs"
import { readdir, readFile, writeFile } from "node:fs/promises"
import * as TuiDirs from "@dotfiles/decider/tui-dirs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { buildOf, goodOf, parseRecord } from "@dotfiles/opencode-update/record"
import { Effect, FileSystem, Layer, Option, Path, type PlatformError } from "effect"
import { type BuildFacts, type InstalledFacts, isObjectName, objectName, ReceiptSource, SourceRead, SourceRef, sourceKey, SourceUnreadable } from "../batch-input.ts"
import { RunRecords } from "../service.ts"
import { departuresOf, SEEN_FILE } from "../skill-drift.ts"

/** The run dir holding `file`: its dir, or that dir's parent when the dir is a unit's (it holds spec.md). */
const runDirOf = (file: string) => {
  const dir = dirname(file)
  return existsSync(join(dir, "spec.md")) ? dirname(dir) : dir
}

const isDirectory = (path: string) => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export const layer = Layer.succeed(RunRecords, {
  seen: (runDir) =>
    Effect.tryPromise(() => readFile(join(runDir, SEEN_FILE), "utf8")).pipe(
      Effect.map((text) => text.trim() || undefined),
      Effect.orElseSucceed(() => undefined),
      Effect.withSpan("RunRecords.seen"),
    ),
  see: (runDir, version) =>
    Effect.tryPromise(() => writeFile(join(runDir, SEEN_FILE), `${version}\n`)).pipe(Effect.ignore, Effect.withSpan("RunRecords.see")),
  departures: Effect.fn("RunRecords.departures")(function* (runDir) {
    const entries = yield* Effect.tryPromise(() => readdir(runDir, { withFileTypes: true })).pipe(Effect.orElseSucceed(() => []))
    const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => entry.name).sort()
    const found = yield* Effect.forEach(files, (file) =>
      Effect.tryPromise(() => readFile(join(runDir, file), "utf8")).pipe(
        Effect.map((text) => departuresOf(file, text)),
        Effect.orElseSucceed((): ReadonlyArray<string> => []),
      ),
    )
    return found.flat()
  }),
  log: ({ near, line, directory }) =>
    Effect.sync(() => {
      const file = near.startsWith("~/") ? join(TuiDirs.dirs().home, near.slice(2)) : isAbsolute(near) ? near : directory === undefined ? undefined : resolve(directory, near)
      if (file === undefined) return
      const runDir = runDirOf(file)
      if (!isDirectory(runDir)) return
      const log = join(runDir, "log.md")
      try {
        const before = existsSync(log) ? readFileSync(log, "utf8") : ""
        appendFileSync(log, `${before !== "" && !before.endsWith("\n") ? "\n" : ""}${line}\n`)
      } catch {
        // Dropped: see the contract.
      }
    }).pipe(Effect.withSpan("RunRecords.log")),
})

/**
 * Where a review's inputs live on one host (batch-input.ts `ReceiptSource`): Work's receipts folder (each receipt
 * `<head>.<kind>.json`, each land record `<head>.land.json`), the updater's installed record and its handoff marker,
 * and the repository whose checkouts a receipt may name. Nothing else is ever opened.
 */
export interface ReceiptPlaces {
  readonly host: string
  readonly repository: { readonly key: string; readonly checkouts: ReadonlyArray<string> }
  readonly receipts: string
  readonly installed: string
  readonly handoff: string
  /** The largest file read whole; a larger one is refused. */
  readonly maxBytes: number
}

/** A build the record names, its two commits full object names (each repository's own format); none when either is not. */
const buildFacts = (build: { readonly version: string; readonly dotfiles: string; readonly fork: string }): Option.Option<BuildFacts> =>
  Option.map(Option.all({ dotfiles: objectName(build.dotfiles), fork: objectName(build.fork) }), ({ dotfiles, fork }) => ({ version: build.version, dotfiles, fork }))

/** A named build that names a commit by anything but its full name makes the whole record corrupt. */
const named = <A>(build: Option.Option<A>, facts: (build: A) => Option.Option<BuildFacts>): Option.Option<Option.Option<BuildFacts>> =>
  Option.match(build, { onNone: () => Option.some(Option.none()), onSome: (each) => Option.map(facts(each), Option.some) })

/**
 * The updater's record in a file's text, through its own `parseRecord`, `buildOf` and `goodOf`; none for text that is
 * not one, or whose installed or good build names a commit by anything but its full object name.
 */
export const installedFacts = (text: string): Option.Option<InstalledFacts> =>
  Option.flatMap(parseRecord(text), (record) => Option.all({ installed: named(buildOf(record), buildFacts), good: named(goodOf(record), buildFacts) }))

/** Strict UTF-8 that keeps a byte-order mark as text, so the text's UTF-8 encoding is the file's bytes exactly. */
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

/**
 * The receipt source over the host's files: a reference names one allowlisted file (a head must be a full object
 * name, so it names no path), read whole, as its exact bytes, through a handle opened without following a link, only
 * when it is a regular file no larger than `maxBytes` and strict UTF-8. The configured folders are the composition
 * root's to trust (a link among their parents is followed); the files in them are not. A missing file or folder is
 * absent; any other failure is unreadable, never absent.
 */
export const receiptSource = (places: ReceiptPlaces) =>
  Layer.effect(
    ReceiptSource,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const roots = places.repository.checkouts.map((root) => path.resolve(root))
      const fileOf = (ref: SourceRef): Option.Option<string> =>
        SourceRef.$match(ref, {
          Receipt: (each) => Option.map(Option.liftPredicate(each.head, isObjectName), (head) => path.join(places.receipts, `${head}.${each.kind}.json`)),
          Land: (each) => Option.map(Option.liftPredicate(each.head, isObjectName), (head) => path.join(places.receipts, `${head}.land.json`)),
          Installed: () => Option.some(places.installed),
          Handoff: () => Option.some(places.handoff),
        })
      const unreadable = (ref: SourceRef) => (error: PlatformError.PlatformError) => new SourceUnreadable({ source: sourceKey(ref), message: error.message })
      const notFound = (error: PlatformError.PlatformError) => error.reason._tag === "NotFound"
      // The entry itself (lstat: a link is not followed) is a regular file before it is opened, so a link, a folder or a
      // FIFO (whose open would wait for a writer) is refused unopened; the opened handle is checked again, and an
      // entry swapped between the two (a link now: the open refuses it) fails the read: read again.
      const whole = (file: string) =>
        Effect.gen(function* () {
          const entry = yield* fs.lstat(file)
          if (entry.type === "SymbolicLink") return SourceRead.Refused({ reason: "a link" })
          if (entry.type !== "File") return SourceRead.Refused({ reason: "not a regular file" })
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* fs.open(file, { flag: "r", noFollow: true })
              const info = yield* handle.stat
              if (info.type !== "File") return SourceRead.Refused({ reason: "not a regular file" })
              const bytes = yield* handle.readAlloc(places.maxBytes + 1)
              const read = Option.getOrElse(bytes, () => new Uint8Array())
              if (read.byteLength > places.maxBytes) return SourceRead.Refused({ reason: "too large" })
              return yield* Effect.try({ try: () => SourceRead.Present({ text: utf8.decode(read) }), catch: () => "not text" }).pipe(
                Effect.orElseSucceed(() => SourceRead.Refused({ reason: "not text" })),
              )
            }),
          )
        })
      const read = Effect.fn("ReceiptSource.read")(function* (ref: SourceRef) {
        const file = fileOf(ref)
        if (Option.isNone(file)) return SourceRead.Refused({ reason: "not a commit name" })
        // A failed look or read: absent when there is no such file, else unreadable (never absent).
        return yield* whole(file.value).pipe(
          Effect.catchIf(notFound, () => Effect.succeed(SourceRead.Absent())),
          Effect.mapError(unreadable(ref)),
        )
      })
      return ReceiptSource.of({
        host: places.host,
        repository: places.repository.key,
        repositoryOf: (checkout) =>
          Option.map(
            Option.liftPredicate(path.resolve(checkout), (resolved) => path.isAbsolute(checkout) && roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))),
            () => places.repository.key,
          ),
        read,
      })
    }),
  )
