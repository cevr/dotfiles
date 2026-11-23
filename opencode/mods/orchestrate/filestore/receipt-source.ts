// A review's receipt inputs as the host's files (mods/orchestrate/batch-input.ts `ReceiptSource`): Work's receipts
// and land records in its receipts folder, the updater's installed record and handoff marker, each read whole from
// one opened handle; and the updater's record decoded by its own reader. Nothing here touches the run's own records.
import { buildOf, goodOf, parseRecord } from "@dotfiles/opencode-update/record"
import { ByteSize, Deferred, type Duration, Effect, Equal, FileSystem, Layer, Match, Option, Path, type PlatformError, Ref } from "effect"
import { type BuildFacts, type InstalledFacts, isObjectName, objectName, ReceiptSource, SourceRead, SourceRef, sourceKey, SourceUnreadable } from "../batch-input.ts"

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
  /** How long each call into the file system may take (the look, the open, the stat, the read, the real path); past it the read is unreadable (read again), never a wait. */
  readonly readWithin: Duration.Input
}

/** Where one open stands: still opening, given up on by its reader (late), or returned. */
type OpenState = "opening" | "late" | "returned"

/**
 * One open of a file, made by a fiber of its own so that its reader waits for it at most the deadline (an open of a
 * FIFO for reading waits for a writer, and an open in progress cannot be interrupted). The fiber hands the handle
 * over and holds it until the reader lets it go (`done`), then closes it, so the reader never waits for a close; an
 * open that returns after its reader gave up finds `done` already set and closes its handle at once.
 */
interface Opening {
  readonly handle: Deferred.Deferred<FileSystem.File, PlatformError.PlatformError>
  readonly done: Deferred.Deferred<void>
  readonly state: Ref.Ref<OpenState>
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
 * name, so it names no path), read whole, as its exact bytes, from one opened handle (`whole`), only when it is a
 * regular file with one name, no larger than `maxBytes`, and strict UTF-8. A missing file or folder is absent; any
 * other failure, a file moved while it was read included, is unreadable (read again), never absent.
 */
export const receiptSource = (places: ReceiptPlaces) =>
  Layer.effect(
    ReceiptSource,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const roots = places.repository.checkouts.map((root) => path.resolve(root))
      /** The allowlisted folder and file name a reference names; none for a head that is not a full object name. */
      const placeOf = (ref: SourceRef): Option.Option<{ readonly folder: string; readonly name: string }> =>
        SourceRef.$match(ref, {
          Receipt: (each) => Option.map(Option.liftPredicate(each.head, isObjectName), (head) => ({ folder: places.receipts, name: `${head}.${each.kind}.json` })),
          Land: (each) => Option.map(Option.liftPredicate(each.head, isObjectName), (head) => ({ folder: places.receipts, name: `${head}.land.json` })),
          Installed: () => Option.some({ folder: path.dirname(places.installed), name: path.basename(places.installed) }),
          Handoff: () => Option.some({ folder: path.dirname(places.handoff), name: path.basename(places.handoff) }),
        })
      const unreadable = (ref: SourceRef) => (error: PlatformError.PlatformError) => new SourceUnreadable({ source: sourceKey(ref), message: error.message })
      const notFound = (error: PlatformError.PlatformError | SourceUnreadable) => error._tag === "PlatformError" && error.reason._tag === "NotFound"
      const tooLarge = (size: bigint) => size > BigInt(places.maxBytes)
      /** `effect`, or unreadable (read again) when it has not returned by the deadline: no call into the file system is waited on longer. */
      const inTime =
        (ref: SourceRef, what: string) =>
        <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.timeoutOrElse(effect, { duration: places.readWithin, orElse: () => Effect.fail(new SourceUnreadable({ source: sourceKey(ref), message: `${what} did not return in time` })) })
      // Opens given up on that have not returned yet. While one waits (a FIFO swapped in and away again, so no writer
      // can be found for it), no new open is made: the reads are unreadable at once, so a folder's writer can hold at
      // most one of the host's file-system threads, never every one.
      const late = yield* Ref.make(0)
      /** Start one open of `file` (see `Opening`); it never creates, truncates or follows a link at the file. */
      const opening = (file: string, flag: "r" | "r+") =>
        Effect.gen(function* () {
          const handle = yield* Deferred.make<FileSystem.File, PlatformError.PlatformError>()
          const done = yield* Deferred.make<void>()
          const state = yield* Ref.make<OpenState>("opening")
          const returned = Ref.getAndSet(state, "returned").pipe(Effect.flatMap((was) => Match.value(was).pipe(Match.when("late", () => Ref.update(late, (count) => count - 1)), Match.orElse(() => Effect.void))))
          yield* Effect.forkDetach(
            Effect.scoped(
              fs.open(file, { flag, noFollow: true }).pipe(
                Effect.onExit(() => returned),
                Effect.flatMap((opened) => Deferred.succeed(handle, opened)),
                Effect.andThen(Deferred.await(done)),
              ),
            ).pipe(Effect.catchTag("PlatformError", (error) => Deferred.fail(handle, error))),
          )
          return { handle, done, state } satisfies Opening
        })
      const letGo = (open: Opening) => Deferred.complete(open.done, Effect.void)
      /** The opened handle, or none when the open has not returned by the deadline. */
      const waitFor = (open: Opening) => Effect.timeoutOption(Deferred.await(open.handle), places.readWithin)
      /** The reader gives up on `open`: counted late until it returns, unless it returned meanwhile. */
      const giveUp = (open: Opening) =>
        Ref.update(late, (count) => count + 1).pipe(
          Effect.andThen(Ref.modify(open.state, (was) => Match.value(was).pipe(Match.when("opening", () => [true, "late"] as const), Match.orElse(() => [false, was] as const)))),
          Effect.flatMap((counted) => Match.value(counted).pipe(Match.when(false, () => Ref.update(late, (count) => count - 1)), Match.orElse(() => Effect.void))),
        )
      /**
       * `file` opened for reading, waited on at most the deadline. An open still waiting then is a FIFO with no writer
       * (the look saw a regular file, so one was swapped in since), and it returns the moment a writer opens it: so the
       * reader is that writer for an instant, by an open for reading and writing (`r+`: it never creates or
       * truncates, nothing is written, and it opens a FIFO without waiting on macOS and Linux), let go at once; then
       * the first open returns, its handle says FIFO, and the read is refused. An open that still does not return
       * (the FIFO was swapped away again before the writer came) is given up: unreadable, read again.
       */
      const openInTime = (ref: SourceRef, file: string) =>
        Effect.gen(function* () {
          if ((yield* Ref.get(late)) > 0) return yield* new SourceUnreadable({ source: sourceKey(ref), message: "an earlier open is still waiting for a writer" })
          const reading = yield* Effect.acquireRelease(opening(file, "r"), letGo)
          const first = yield* waitFor(reading)
          if (Option.isSome(first)) return first.value
          const writing = yield* opening(file, "r+")
          yield* waitFor(writing).pipe(
            Effect.flatMap(Option.match({ onNone: () => giveUp(writing), onSome: () => Effect.void })),
            Effect.ignore,
            Effect.ensuring(letGo(writing)),
          )
          const second = yield* waitFor(reading)
          if (Option.isSome(second)) return second.value
          yield* giveUp(reading)
          return yield* new SourceUnreadable({ source: sourceKey(ref), message: "the open did not return in time" })
        })
      /**
       * One allowlisted file, read whole from one opened handle. The folder is resolved to its real path once for the
       * read (a link among its parents is followed here, before anything is opened) and the file is opened by its
       * name in that real folder with O_NOFOLLOW, so a link swapped in at the file fails the open and is never
       * followed. The `lstat` before is an early refusal only (a link, a folder, a FIFO whose open would wait for a
       * writer). Every fact the read rests on comes from the opened handle (fstat): a regular file, its size, its names (a
       * hard link to a file elsewhere is refused; none means it was removed while open: the check below fails it), its
       * device and inode; the bytes come from that handle only.
       * Last, the folder must still resolve to the same real path and its entry by that name must still be the opened
       * file (device and inode): a parent swapped for a link, or the file replaced, while it was opened fails the read
       * (read again). Node and Bun give no openat, so the leaf cannot be opened relative to a folder handle: the
       * identity check after the open stands in for it.
       * Nothing is waited on past the deadline: the real paths, the looks, the stat and the read each by `inTime`, the
       * open by `openInTime` (a FIFO swapped in between the look and the open is released and refused), and the close
       * not at all (the open's own fiber closes the handle once the read lets it go).
       */
      const whole = (ref: SourceRef, place: { readonly folder: string; readonly name: string }) =>
        Effect.gen(function* () {
          const timed = (what: string) => inTime(ref, what)
          const folder = yield* timed("the folder's real path")(fs.realPath(place.folder))
          const file = path.join(folder, place.name)
          const entry = yield* timed("the look")(fs.lstat(file))
          if (entry.type === "SymbolicLink") return SourceRead.Refused({ reason: "a link" })
          if (entry.type !== "File") return SourceRead.Refused({ reason: "not a regular file" })
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* openInTime(ref, file)
              const info = yield* timed("the opened file's stat")(handle.stat)
              if (info.type !== "File") return SourceRead.Refused({ reason: "not a regular file" })
              if (tooLarge(ByteSize.toBigInt(info.size))) return SourceRead.Refused({ reason: "too large" })
              if (Option.exists(info.nlink, (names) => names > 1n)) return SourceRead.Refused({ reason: "a hard link" })
              const bytes = Option.getOrElse(yield* timed("the read")(handle.readAlloc(places.maxBytes + 1)), () => new Uint8Array())
              if (tooLarge(BigInt(bytes.byteLength))) return SourceRead.Refused({ reason: "too large" })
              const still = yield* timed("the folder's real path")(fs.realPath(place.folder))
              const now = yield* timed("the look")(fs.lstat(file))
              if (still !== folder || now.dev !== info.dev || !Equal.equals(now.ino, info.ino)) {
                return yield* new SourceUnreadable({ source: sourceKey(ref), message: "the file moved while it was read" })
              }
              return yield* Effect.try({ try: () => SourceRead.Present({ text: utf8.decode(bytes) }), catch: () => "not text" }).pipe(
                Effect.orElseSucceed(() => SourceRead.Refused({ reason: "not text" })),
              )
            }),
          )
        })
      const read = Effect.fn("ReceiptSource.read")(function* (ref: SourceRef) {
        const place = placeOf(ref)
        if (Option.isNone(place)) return SourceRead.Refused({ reason: "not a commit name" })
        // A failed look or read: absent when there is no such file or folder, else unreadable (never absent).
        return yield* whole(ref, place.value).pipe(
          Effect.catchIf(notFound, () => Effect.succeed(SourceRead.Absent())),
          Effect.catchTag("PlatformError", (error) => Effect.fail(unreadable(ref)(error))),
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
