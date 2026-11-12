// A login store in its slot-file format over a temporary directory, as the
// suites' other writer: it signs logins in, refreshes one as another process
// does and reads what the pool wrote. Its refresh takes the store's lock on
// its own (an exclusive SQLite transaction on `.locks/anthropic.lock.db`), not
// through the pool's code, so a suite proves the pool honours the lock as the
// file defines it. Every token is a fake the test drew.
import { Database } from "bun:sqlite"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Option, Schedule } from "effect"
import { decodeStoredOAuth, encodeRefresh, type StoredOAuth } from "../../mods/pool/store/store.ts"

export interface Tokens {
  readonly access: string
  readonly refresh: string
  readonly expires: number
}

/** A sign-in as the slot file holds it, with no account id. */
export type Decoded = Omit<StoredOAuth, "accountId">

/** The owner mark a sign-in to the store carries. */
export const OWNER = { owner: "store" }

export interface SlotStore {
  /** Sign `label` in (the default entry when none): owned by the store unless `metadata` says otherwise. */
  readonly signIn: (
    label: string | undefined,
    tokens: Tokens,
    options?: { metadata?: Record<string, string>; signedInAt?: number },
  ) => Promise<void>
  /**
   * Another process's refresh of `label`, under the store's lock: `hold` runs
   * first with the lock held, as a refresh in flight does; then `next` is
   * written as a refresh writes it (no account id, the metadata and the stamp
   * kept). `next` answering `undefined` writes nothing, as a refresh that
   * finds the stored token fresh does.
   */
  readonly refresh: (label: string, next: (current: Decoded | undefined) => Tokens | undefined, hold?: Effect.Effect<void>) => Promise<void>
  /** The label's sign-in, decoded. */
  readonly get: (label: string) => Promise<Decoded | undefined>
}

const withoutAccount = ({ accountId: _accountId, ...rest }: StoredOAuth): Decoded => rest

/** The store's lock, taken: an exclusive transaction, polled while another connection holds it. */
const lock = (dir: string) =>
  Effect.acquireRelease(
    Effect.sync(() => mkdirSync(join(dir, ".locks"), { recursive: true })).pipe(
      Effect.andThen(
        Effect.try(() => new Database(join(dir, ".locks/anthropic.lock.db"), { create: true })).pipe(
          Effect.flatMap((db) =>
            Effect.try(() => {
              db.exec("PRAGMA busy_timeout = 0")
              db.exec("BEGIN EXCLUSIVE")
              return db
            }).pipe(Effect.tapError(() => Effect.sync(() => db.close()))),
          ),
        ),
      ),
      Effect.retry({ times: 400, schedule: Schedule.spaced("25 millis") }),
      Effect.orDie,
    ),
    (db) => Effect.sync(() => db.close()),
  )

export const openSlotStore = (dir: string): SlotStore => {
  const slots = join(dir, ".slots/anthropic")
  const file = (label: string) => join(slots, encodeURIComponent(label))
  const read = (label: string): Effect.Effect<Option.Option<Decoded>> =>
    Effect.try(() => readFileSync(file(label), "utf8")).pipe(
      Effect.map((text) => Option.map(Option.fromNullishOr(decodeStoredOAuth(text)), withoutAccount)),
      Effect.orElseSucceed(() => Option.none<Decoded>()),
    )
  return {
    signIn: async (label, tokens, options = {}) => {
      mkdirSync(slots, { recursive: true, mode: 0o700 })
      const signedIn = { type: "oauth" as const, ...tokens, metadata: options.metadata ?? OWNER }
      const stored = options.signedInAt === undefined ? signedIn : { ...signedIn, signedInAt: options.signedInAt }
      writeFileSync(file(label ?? "default"), encodeRefresh(stored, tokens), { mode: 0o600 })
    },
    refresh: (label, next, hold = Effect.void) =>
      run(
        Effect.scoped(
          Effect.gen(function* () {
            yield* lock(dir)
            yield* hold
            const held = yield* read(label)
            const tokens = Option.flatMap(held, (current) => Option.fromNullishOr(next(current)))
            if (Option.isNone(held) || Option.isNone(tokens)) return
            const staging = `${file(label)}.fake-write`
            writeFileSync(staging, encodeRefresh(held.value, tokens.value), { mode: 0o600 })
            renameSync(staging, file(label))
          }),
        ),
      ),
    get: (label) => run(read(label).pipe(Effect.map(Option.getOrUndefined))),
  }
}

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)
