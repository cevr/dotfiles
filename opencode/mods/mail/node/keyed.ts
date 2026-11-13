// The keyed hash, plain hash and random values pairing uses, from node:crypto:
// HMAC-SHA256 and SHA-256 as base64url, a constant-time compare, and random
// tokens for codes, secrets and nonces.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { Effect, Layer } from "effect"
import type { Keyed } from "../pairing.ts"
import { Tokens } from "../service.ts"

export const keyed: Keyed = {
  mac: (secret, text) => createHmac("sha256", secret).update(text).digest("base64url"),
  hash: (text) => createHash("sha256").update(text).digest("base64url"),
  same: (left, right) => {
    const a = Buffer.from(left)
    const b = Buffer.from(right)
    return a.length === b.length && timingSafeEqual(a, b)
  },
}

/** `bytes` random bytes as base64url: 32 for a secret, 18 for a code, 16 for a nonce. */
export const token = (bytes: number): string => randomBytes(bytes).toString("base64url")

/** Tokens from the operating system's random source. */
export const tokens = Layer.succeed(Tokens, Tokens.of({ token: (bytes) => Effect.sync(() => token(bytes)) }))
