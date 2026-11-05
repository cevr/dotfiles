// PKCE (RFC 7636, S256) for the Claude sign-in: a verifier from 64 random
// bytes, and its challenge.
import { base64url, sha256 } from "./sha256.ts"

export interface Pkce {
  readonly verifier: string
  readonly challenge: string
  readonly method: "S256"
}

/** The PKCE pair for `entropy` (64 random bytes). */
export function pkceFrom(entropy: Uint8Array): Pkce {
  const verifier = base64url(entropy)
  return { verifier, challenge: base64url(sha256(verifier)), method: "S256" }
}
