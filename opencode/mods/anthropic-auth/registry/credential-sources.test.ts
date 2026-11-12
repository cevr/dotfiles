import { Effect, Layer } from "effect"
import { credentialSourcesLaws, type LawSource } from "../laws.ts"
import { layer } from "./credential-sources.ts"

/** A registry of this file's own, handed to the layer in place of the process's: no test writes `globalThis`. */
const registry = new Map<string, Set<LawSource>>()

/**
 * Each law registers its sources under an integration of its own, as another
 * plugin would, and takes them out when its layer is released.
 */
const registered = (sources: ReadonlyArray<LawSource>) => {
  const integrationID = `law-${crypto.randomUUID()}`
  return Layer.unwrap(
    Effect.acquireRelease(
      Effect.sync(() => {
        registry.set(integrationID, new Set(sources))
        return layer(integrationID, () => registry)
      }),
      () => Effect.sync(() => void registry.delete(integrationID)),
    ),
  )
}

credentialSourcesLaws("an injected registry", registered)
