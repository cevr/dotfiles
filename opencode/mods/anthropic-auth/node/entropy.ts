// Randomness from Node's CSPRNG.
import { randomBytes } from "node:crypto"
import { Layer } from "effect"
import { Entropy } from "../service.ts"

export const layer = Layer.succeed(Entropy, {
  bytes: (size) => new Uint8Array(randomBytes(size)),
})
