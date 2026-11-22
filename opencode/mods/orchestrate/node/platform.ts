// The host's platform for the orchestrate plugin's adapters: files, paths and processes (the fork's
// @effect/platform-node, built on the same `effect` the plugin runs on, linked by scripts/link-fork.ts) and SHA
// digests on WebCrypto. Provided once at a composition root (the plugin's server, the record CLI, a test's boundary);
// the adapters ask for the services, never for node builtins.
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Layer } from "effect"
import { Digest } from "effect/crypto"

/** Every platform service an orchestrate adapter may ask for. */
export const platform = Layer.mergeAll(NodeServices.layer, Digest.layerWebCrypto)
