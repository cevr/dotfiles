// The device store's two copies on disk (devices.ts): read without ever failing (a copy that cannot be read is a
// condition, never an error that stops the plugin or an update), and written only by the command, whole and atomic.
// - Where: `<digest dir>/devices.json` (the state tree, beside the log and the pairing) and
//   `$XDG_CONFIG_HOME/opencode-digest/devices.json` (the config tree). Two trees, so clearing or rebuilding one (a
//   state dir reset, a file edited by hand) leaves the other; both lost reads as no keys, which closes.
// - A write: under an exclusive lock file (`devices.lock` beside the first copy, O_EXCL; one older than
//   LOCK_STALE_MS was left by a process that died holding it and is removed), the copies are read again, the one
//   change applied to their union (devices.ts storeToEdit), and each copy replaced whole: a temporary file written,
//   fsynced and renamed over it, then its folder fsynced. Two commands at once take turns, so neither loses an ID.
import { randomBytes } from "node:crypto"
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Clock, Data, Effect, Option, Predicate, Schedule, Schema } from "effect"
import type { StatusRead } from "../bind.ts"
import { addedTo, Copy, copyOfText, refusalOf, type Store, Store as StoreSchema, storeToEdit } from "../devices.ts"

/** The store's file name in each tree. */
export const FILE = "devices.json"
/** The lock file beside the first copy. */
export const LOCK = "devices.lock"
/** A lock file this old was left by a process that died holding it. */
export const LOCK_STALE_MS = 10_000

/** The two copies' paths: beside the log in `dir`, and under the config tree `config` (`$XDG_CONFIG_HOME`). */
export const pathsOf = (dir: string, config: string): readonly [string, string] => [join(dir, FILE), join(config, "opencode-digest", FILE)]

const codeOf = (cause: unknown): string => String(Predicate.hasProperty(cause, "code") && cause.code)

/**
 * One copy as it reads now; never fails, never waits on a writer: anything but a regular file there (a folder, a FIFO,
 * a socket, a device) is unreadable at once (`EISDIR`, `ENOTREG`), never opened.
 */
export const readCopy = (path: string): Effect.Effect<Copy> =>
  Effect.tryPromise({ try: () => stat(path), catch: codeOf }).pipe(
    Effect.filterOrFail(
      (info) => info.isFile(),
      (info) => Option.getOrElse(Option.liftPredicate("EISDIR", () => info.isDirectory()), () => "ENOTREG"),
    ),
    Effect.andThen(Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: codeOf })),
    Effect.map(copyOfText),
    Effect.catch((code) => Effect.succeed(Option.getOrElse(Option.liftPredicate(Copy.Absent(), () => code === "ENOENT" || code === "ENOTDIR"), () => Copy.Unreadable({ why: code })))),
  )

/** Both copies. */
export const readCopies = (paths: readonly [string, string]): Effect.Effect<readonly [Copy, Copy]> => Effect.all([readCopy(paths[0]), readCopy(paths[1])])

/** Why the command did not write. */
export class StoreRefused extends Data.TaggedError("StoreRefused")<{ readonly message: string }> {}

const encode = Schema.encodeSync(Schema.fromJsonString(StoreSchema))

const refused = (what: string) => (cause: unknown) => new StoreRefused({ message: `${what}: ${String(cause)}` })

/** A file or folder opened, `use`d and closed whatever happens. */
const withHandle = <A>(path: string, flags: string, use: (handle: Awaited<ReturnType<typeof open>>) => Promise<A>) =>
  Effect.acquireUseRelease(
    Effect.tryPromise({ try: () => open(path, flags, 0o600), catch: refused(`opening ${path}`) }),
    (handle) => Effect.tryPromise({ try: () => use(handle), catch: refused(`writing ${path}`) }),
    (handle) => Effect.promise(() => handle.close()),
  )

/** `text` at `path`, atomically: a temporary file beside it, fsynced, renamed over it, the folder fsynced. */
const replaceWhole = (path: string, text: string): Effect.Effect<void, StoreRefused> => {
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`
  return Effect.tryPromise({ try: () => mkdir(dirname(path), { recursive: true, mode: 0o700 }), catch: refused(`making ${dirname(path)}`) }).pipe(
    Effect.andThen(withHandle(temporary, "wx", (handle) => handle.writeFile(text).then(() => handle.sync()))),
    Effect.andThen(Effect.tryPromise({ try: () => rename(temporary, path), catch: refused(`renaming over ${path}`) })),
    Effect.tapError(() => Effect.promise(() => unlink(temporary).then(() => true, () => false))),
    Effect.andThen(withHandle(dirname(path), "r", (handle) => handle.sync())),
  )
}

/** Held by another command: try again. */
class Held extends Data.TaggedError("Held")<{}> {}

/** The lock, taken: made exclusively, tried every 5 ms for about 5 s; a stale one is removed for the next try. */
const takeLock = (lock: string): Effect.Effect<void, StoreRefused> => {
  const removeStale = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const age = yield* Effect.promise(() => stat(lock).then((info) => now - info.mtimeMs, () => 0))
    if (age > LOCK_STALE_MS) yield* Effect.promise(() => unlink(lock).then(() => true, () => false))
  })
  const once = Effect.tryPromise({ try: () => open(lock, "wx", 0o600).then((handle) => handle.close()), catch: codeOf }).pipe(
    Effect.catchIf((code) => code === "EEXIST", () => Effect.andThen(removeStale, Effect.fail(new Held()))),
    Effect.catchIf(Predicate.isString, (code) => Effect.fail(refused(`the lock ${lock}`)(code))),
  )
  return Effect.tryPromise({ try: () => mkdir(dirname(lock), { recursive: true, mode: 0o700 }), catch: refused(`making ${dirname(lock)}`) }).pipe(
    Effect.andThen(Effect.retry(once, { while: Predicate.isTagged("Held"), schedule: Schedule.spaced("5 millis"), times: 1_000 })),
    Effect.catchTag("Held", () => Effect.fail(new StoreRefused({ message: `${lock} is held by another command; try again` }))),
  )
}

/**
 * One explicit change of the store, under the lock: the copies are read again, `step` applied to their union, the
 * store's invariant checked (devices.ts refusalOf: every ID it adds is, in `status` read now, a device of his), and
 * both copies written whole. Every write goes through here, so no caller adds an ID that is not his. Refused, with
 * nothing written, when an added ID is not his or the status does not read, when `step` refuses, and when a copy
 * exists but neither reads (both are left as they are, for the owner).
 */
export const change = (paths: readonly [string, string], status: Effect.Effect<StatusRead>, step: (store: Store) => Effect.Effect<Store, StoreRefused>): Effect.Effect<Store, StoreRefused> => {
  const lock = join(dirname(paths[0]), LOCK)
  return Effect.acquireUseRelease(
    takeLock(lock),
    () =>
      Effect.flatMap(readCopies(paths), ([primary, secondary]) =>
        Option.match(storeToEdit(primary, secondary), {
          onNone: () => Effect.fail(new StoreRefused({ message: `neither copy reads (${paths.join(", ")}): move the bad one aside to start again; nothing was written` })),
          onSome: (store) =>
            Effect.gen(function* () {
              const next = yield* step(store)
              const added = addedTo(store, next)
              // Read only when the write adds an ID: a removal or a rerun needs no status.
              if (added.length > 0) {
                const refusal = refusalOf(added, yield* status)
                if (Option.isSome(refusal)) return yield* Effect.fail(new StoreRefused({ message: refusal.value }))
              }
              const text = `${encode(next)}\n`
              yield* Effect.forEach(paths, (path) => replaceWhole(path, text), { discard: true })
              return next
            }),
        }),
      ),
    () => Effect.promise(() => unlink(lock).then(() => true, () => false)),
  )
}
