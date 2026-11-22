// The digest's pairing on disk: `pairing.json` beside the log, 0600 in the 0700 folder, versioned:
// `{"v":2,"codes":[{hash,expires}],"paired":[{id,hash,created,label}],"failures":[<epoch ms>]}`.
// - A code and a token are kept only as their SHA-256 hashes, so reading the file gives nothing that pairs or answers.
//   The token's hash is compared in constant time. A code is removed when it is tried (whether it matched or not)
//   and when it is out of time.
// - `failures` are the failed tries of the last RATE_WINDOW_MS, so the rate limit survives a restart.
// - Each change (issue, exchange, revoke) runs under one lock: a semaphore for this process's fibers, and an
//   exclusive lock file (`pairing.lock`, made with O_EXCL) for the pair command and the server at the same instant.
//   So a code is exchanged once however many requests bring it, and a failed try is counted before the next one is
//   compared. A lock file older than LOCK_STALE_MS was left by a process that died holding it; it is taken over.
// - A write replaces the file whole (a temporary file renamed over it), so a reader never sees half of one.
// - Round 1's file (v1: an HMAC key for cookies) is read as no browser paired, its codes kept. A file of a version
//   this build does not know is never written to: every call fails and names it.
import { Buffer } from "node:buffer"
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto"
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Array as Arr, Clock, Effect, Option, Predicate, Schedule, Schema, Semaphore } from "effect"
import { ALPHABET, CODE_LENGTH, CODE_TTL_MS, failuresIn, MAX_PAIRED, mayTry, normalizeCode, PairingUnavailable, PairRefused, type Pairing } from "../pairing.ts"

export const FILE = "pairing.json"
export const LOCK = "pairing.lock"
export const VERSION = 2
/** A lock file this old was left by a process that died holding it. */
export const LOCK_STALE_MS = 10_000
/** A label's most characters (the browser's User-Agent, cut). */
export const LABEL_MAX = 120

const Code = Schema.Struct({ hash: Schema.String, expires: Schema.Number })
const Browser = Schema.Struct({ id: Schema.String, hash: Schema.String, created: Schema.Number, label: Schema.String })
const Stored = Schema.Struct({ v: Schema.Literal(VERSION), codes: Schema.Array(Code), paired: Schema.Array(Browser), failures: Schema.Array(Schema.Number) })
type Stored = typeof Stored.Type
const RoundOne = Schema.Struct({ v: Schema.Literal(1), codes: Schema.Array(Code) })
const Versioned = Schema.Struct({ v: Schema.Number })

const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(Stored))
const decodeRoundOne = Schema.decodeUnknownOption(Schema.fromJsonString(RoundOne))
const decodeVersion = Schema.decodeUnknownOption(Schema.fromJsonString(Versioned))
const encodeStored = Schema.encodeSync(Schema.fromJsonString(Stored))

const EMPTY: Stored = { v: VERSION, codes: [], paired: [], failures: [] }

const codeOf = (cause: unknown): string => String(Predicate.hasProperty(cause, "code") && cause.code)

const unavailable = (message: string) => new PairingUnavailable({ message: `${FILE}: ${message}` })

const sha256 = (text: string): Buffer => createHash("sha256").update(text).digest()

/** Equal in constant time, for two hashes of any length. */
const same = (left: Buffer, right: Buffer): boolean => left.length === right.length && timingSafeEqual(left, right)

/** A token this build makes: `v2.<id>.<secret>`, the id 8 and the secret 43 base64url characters. */
const TOKEN = /^v2\.([A-Za-z0-9_-]{8})\.([A-Za-z0-9_-]{43})$/

/** The process's lock for each pairing folder, so its fibers take turns before they take the file lock. */
const turns = new Map<string, Semaphore.Semaphore>()
const turnOf = (dir: string): Semaphore.Semaphore =>
  Option.getOrElse(Option.fromUndefinedOr(turns.get(dir)), () => {
    const made = Semaphore.makeUnsafe(1)
    turns.set(dir, made)
    return made
  })

export const make = (dir: string): Pairing => {
  const path = join(dir, FILE)
  const lockPath = join(dir, LOCK)

  const removeLock = Effect.promise(() => unlink(lockPath).then(
    () => true,
    () => false,
  ))
  /** A lock file left by a process that died holding it, removed. */
  const breakStale = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const age = yield* Effect.promise(() => stat(lockPath).then(
      (info) => now - info.mtimeMs,
      () => 0,
    ))
    if (age > LOCK_STALE_MS) yield* removeLock
  })
  /** One try at the file lock: made exclusively (true), or held by another (false, a stale one broken). */
  const tryLock = Effect.tryPromise({ try: () => open(lockPath, "wx", 0o600).then((handle) => handle.close()), catch: (cause) => cause }).pipe(
    Effect.as(true),
    Effect.catchIf(
      (cause) => codeOf(cause) === "EEXIST",
      () => Effect.as(breakStale, false),
    ),
    Effect.mapError((cause) => unavailable(String(cause))),
  )
  /** The file lock, taken; tried every 5 ms for about 5 s. */
  const takeLock = Effect.tryPromise({ try: () => mkdir(dir, { recursive: true, mode: 0o700 }), catch: (cause) => unavailable(String(cause)) }).pipe(
    Effect.andThen(tryLock.pipe(Effect.filterOrFail((made) => made, () => unavailable(`${LOCK} is held; try again`)), Effect.retry({ schedule: Schedule.spaced("5 millis"), times: 1_000 }))),
    Effect.asVoid,
  )
  const dropLock = Effect.asVoid(removeLock)
  const locked = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E | PairingUnavailable> =>
    turnOf(dir).withPermits(1)(Effect.acquireUseRelease(takeLock, () => effect, () => dropLock))

  /** The file as stored; none paired when there is none. */
  const read = Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: (cause) => cause }).pipe(
    Effect.map(Option.some),
    Effect.catchIf(
      (cause) => codeOf(cause) === "ENOENT",
      () => Effect.succeed(Option.none<string>()),
    ),
    Effect.mapError((cause) => unavailable(String(cause))),
    Effect.flatMap((text) =>
      Option.match(text, {
        onNone: () => Effect.succeed(EMPTY),
        onSome: (stored) =>
          Option.match(Option.orElse(decodeStored(stored), () => Option.map(decodeRoundOne(stored), (old): Stored => ({ ...EMPTY, codes: old.codes }))), {
            onSome: Effect.succeed,
            onNone: () =>
              Effect.fail(
                Option.match(Option.filter(decodeVersion(stored), (each) => each.v !== VERSION && each.v !== 1), {
                  onSome: (each) => unavailable(`version ${each.v} is not one this build knows; it is left as it is`),
                  onNone: () => unavailable("it does not read as a pairing file; it is left as it is"),
                }),
              ),
          }),
      }),
    ),
  )

  const write = (stored: Stored) =>
    Effect.tryPromise({
      try: () => {
        const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`
        return mkdir(dir, { recursive: true, mode: 0o700 })
          .then(() => writeFile(temporary, encodeStored(stored), { mode: 0o600 }))
          .then(() => chmod(temporary, 0o600))
          .then(() => rename(temporary, path))
      },
      catch: (cause) => unavailable(String(cause)),
    })

  /** The file without what time has ended: codes out of time for a while (until then, a try says "expired"), failures out of the window. */
  const live = (stored: Stored, now: number): Stored => ({ ...stored, codes: stored.codes.filter((code) => code.expires > now - CODE_TTL_MS), failures: failuresIn(stored.failures, now) })

  /** One change of the file, under the lock: `change` answers the file to write and what to return. */
  const change = <A, E>(now: number, step: (stored: Stored) => Effect.Effect<readonly [Stored, A], E>) =>
    locked(
      Effect.gen(function* () {
        const [next, result] = yield* step(live(yield* read, now))
        yield* write(next)
        return result
      }),
    )

  return {
    issue: (now) =>
      change(now, (stored) => {
        const code = Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join("")
        return Effect.succeed([{ ...stored, codes: [...stored.codes, { hash: sha256(normalizeCode(code)).toString("hex"), expires: now + CODE_TTL_MS }] }, code] as const)
      }),
    exchange: (code, now, label) =>
      Effect.flatten(
        change(now, (stored): Effect.Effect<readonly [Stored, Effect.Effect<{ readonly id: string; readonly token: string }, PairRefused>]> => {
          // Past the limit nothing is compared, and the try is not counted: the window ends RATE_WINDOW_MS after
          // the last counted failure.
          if (!mayTry(stored.failures, now)) return Effect.succeed([stored, Effect.fail(new PairRefused({ reason: "limited" }))] as const)
          const given = sha256(normalizeCode(code))
          // Every stored hash is compared, so how long it takes says nothing of which matched. The code is tried
          // once, whatever comes of it.
          const matched = Arr.head(stored.codes.filter((each) => same(Buffer.from(each.hash, "hex"), given)))
          const codes = stored.codes.filter((each) => Option.match(matched, { onNone: () => true, onSome: (found) => found !== each }))
          const refused = (reason: "unknown" | "expired") =>
            Effect.succeed([{ ...stored, codes, failures: [...stored.failures, now] }, Effect.fail(new PairRefused({ reason }))] as const)
          return Option.match(matched, {
            onNone: () => refused("unknown"),
            onSome: (found) => {
              if (found.expires <= now) return refused("expired")
              const id = randomBytes(6).toString("base64url")
              const secret = randomBytes(32).toString("base64url")
              const browser = { id, hash: sha256(secret).toString("hex"), created: now, label: label.slice(0, LABEL_MAX) }
              return Effect.succeed([{ ...stored, codes, paired: [...stored.paired, browser].slice(-MAX_PAIRED) }, Effect.succeed({ id, token: `v2.${id}.${secret}` })] as const)
            },
          })
        }),
      ),
    verify: (token) =>
      read.pipe(
        Effect.map((stored) =>
          Option.flatMap(Option.fromNullishOr(TOKEN.exec(token)), ([, id = "", secret = ""]) =>
            Option.map(
              Arr.findFirst(stored.paired, (browser) => browser.id === id && same(Buffer.from(browser.hash, "hex"), sha256(secret))),
              (browser) => browser.id,
            ),
          ),
        ),
        Effect.orElseSucceed(() => Option.none<string>()),
      ),
    list: Effect.map(read, (stored) => stored.paired.map(({ id, created, label }) => ({ id, created, label }))),
    revoke: (which) =>
      locked(
        Effect.gen(function* () {
          const stored = yield* read
          const kept = stored.paired.filter((browser) => which !== "all" && browser.id !== which.id)
          yield* write({ ...stored, paired: kept })
          return stored.paired.length - kept.length
        }),
      ),
  }
}
