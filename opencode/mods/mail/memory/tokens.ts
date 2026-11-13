// Tokens from Effect's `Random`, for the simulated hosts: on a seeded random a
// run's codes, secrets and nonces replay with its seed. Never for a real host:
// they are as guessable as the seed.
import { Effect, Layer, Random } from "effect"
import { Tokens } from "../service.ts"

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

/** `bytes` random bytes' worth of base64url characters, from the fiber's `Random`. */
export const token = (bytes: number) =>
  Effect.forEach(Array.from({ length: Math.ceil((bytes * 4) / 3) }), () => Random.nextIntBetween(0, ALPHABET.length)).pipe(
    Effect.map((indexes) => indexes.map((index) => ALPHABET.charAt(index)).join("")),
  )

export const layer = Layer.succeed(Tokens, Tokens.of({ token }))
