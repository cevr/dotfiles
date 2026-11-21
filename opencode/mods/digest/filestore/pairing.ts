// The digest's pairing on disk: `pairing.json` beside the log, 0600 in the 0700 folder, versioned:
// `{"v":1,"key":"<32 random bytes, base64url>","codes":[{"hash":"<sha256 of the code, hex>","expires":<epoch ms>}]}`.
// The key signs each paired browser's cookie (HMAC-SHA256 of a random id), so deleting the file unpairs every
// browser. A code is kept only as its hash and compared in constant time; it is removed when exchanged, used or not,
// and when out of time. A file of a version this build does not know is never written to: every call fails and
// names it. A write replaces the file whole (a temporary file renamed over it), so a reader never sees half of one;
// the pair command and a server's exchange at the same instant may lose the code just made (run the command again).
import { Buffer } from "node:buffer"
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Array as Arr, Effect, Option, Schema } from "effect"
import { ALPHABET, CODE_LENGTH, CODE_TTL_MS, normalizeCode, PairingUnavailable, PairRefused, type Pairing } from "../pairing.ts"

export const FILE = "pairing.json"
export const VERSION = 1

const Code = Schema.Struct({ hash: Schema.String, expires: Schema.Number })
const Stored = Schema.Struct({ v: Schema.Literal(VERSION), key: Schema.String, codes: Schema.Array(Code) })
type Stored = typeof Stored.Type
const Versioned = Schema.Struct({ v: Schema.Number })

const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(Stored))
const decodeVersion = Schema.decodeUnknownOption(Schema.fromJsonString(Versioned))
const encodeStored = Schema.encodeSync(Schema.fromJsonString(Stored))

const isMissing = (cause: unknown): boolean => cause instanceof Error && "code" in cause && cause.code === "ENOENT"

const unavailable = (message: string) => new PairingUnavailable({ message: `${FILE}: ${message}` })

const hashOf = (code: string): Buffer => createHash("sha256").update(normalizeCode(code)).digest()

/** Equal in constant time, for two texts of any length. */
const same = (left: Buffer, right: Buffer): boolean => left.length === right.length && timingSafeEqual(left, right)

const signatureOf = (key: string, id: string): Buffer => createHmac("sha256", Buffer.from(key, "base64url")).update(`v1:${id}`).digest()

/** A cookie value this build signs: `v1.<id>.<HMAC of the id>`. */
const SIGNED = /^v1\.([A-Za-z0-9_-]{8,64})\.([A-Za-z0-9_-]{16,128})$/

export const make = (dir: string): Pairing => {
  const path = join(dir, FILE)

  /** The file as stored; a fresh key when there is none. */
  const read = Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: (cause) => cause }).pipe(
    Effect.map(Option.some),
    Effect.catchIf(isMissing, () => Effect.succeed(Option.none<string>())),
    Effect.mapError((cause) => unavailable(String(cause))),
    Effect.flatMap((text) =>
      Option.match(text, {
        onNone: () => Effect.sync((): Stored => ({ v: VERSION, key: randomBytes(32).toString("base64url"), codes: [] })),
        onSome: (stored) =>
          Option.match(decodeStored(stored), {
            onSome: Effect.succeed,
            onNone: () =>
              Effect.fail(
                Option.match(Option.filter(decodeVersion(stored), (each) => each.v !== VERSION), {
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

  const live = (stored: Stored, now: number): Stored => ({ ...stored, codes: stored.codes.filter((code) => code.expires > now) })

  return {
    issue: (now) =>
      Effect.gen(function* () {
        const stored = yield* read
        const code = Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join("")
        yield* write({ ...live(stored, now), codes: [...live(stored, now).codes, { hash: hashOf(code).toString("hex"), expires: now + CODE_TTL_MS }] })
        return code
      }),
    exchange: (code, now) =>
      Effect.gen(function* () {
        const stored = yield* read
        const given = hashOf(code)
        // Every stored hash is compared, so how long it takes says nothing of which matched.
        const matched = stored.codes.filter((each) => same(Buffer.from(each.hash, "hex"), given))
        const found = yield* Effect.fromOption(Arr.head(matched)).pipe(Effect.mapError(() => new PairRefused({ reason: "unknown" })))
        // Used up whatever comes of it: a code is exchanged once.
        yield* write(live({ ...stored, codes: stored.codes.filter((each) => !matched.includes(each)) }, now))
        if (found.expires <= now) return yield* new PairRefused({ reason: "expired" })
        const id = randomBytes(18).toString("base64url")
        return `v1.${id}.${signatureOf(stored.key, id).toString("base64url")}`
      }),
    verify: (cookie) =>
      read.pipe(
        Effect.map((stored) => {
          return Option.match(Option.fromNullishOr(SIGNED.exec(cookie)), {
            onNone: () => false,
            onSome: ([, id = "", signature = ""]) => same(Buffer.from(signature, "base64url"), signatureOf(stored.key, id)),
          })
        }),
        Effect.orElseSucceed(() => false),
      ),
  }
}
