// What the orchestrate plugin provides itself at its composition root (cmd/orchestrate/server.ts): SHA digests on
// WebCrypto, from `effect` alone. Files, paths and processes are the host's: the fork's plugin host gives a server
// plugin FileSystem, Path and ChildProcessSpawner (`@opencode/plugin/effect` `Plugin.Environment`), so the plugin
// imports no platform implementation and the record's layer carries those three in its requirements.
import { Digest } from "effect/crypto"
import { CryptoHasher } from "bun"

/** The one platform service the plugin provides itself. */
export const platform = Digest.layerWebCrypto

/** Native synchronous HMAC for the commitment store's immediate transaction. */
export const filingMac = (key: Uint8Array) => (original: string): string =>
  new CryptoHasher("sha256", key).update(original).digest("hex")
