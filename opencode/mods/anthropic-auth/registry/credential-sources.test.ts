import { Effect, Layer } from "effect"
import { credentialSourcesLaws, type LawSource } from "../laws.ts"
import { CREDENTIAL_SOURCES, layer } from "./credential-sources.ts"

/** The process registry, made if no plugin has made it yet. */
const registry = (): Map<string, Set<unknown>> => {
  const found: unknown = Reflect.get(globalThis, CREDENTIAL_SOURCES)
  if (found instanceof Map) return found
  const made = new Map<string, Set<unknown>>()
  Reflect.set(globalThis, CREDENTIAL_SOURCES, made)
  return made
}

// Each law registers its sources under an integration of its own, as another
// plugin would, and takes them out when its layer is released.
const registered = (sources: ReadonlyArray<LawSource>) => {
  const integrationID = `law-${crypto.randomUUID()}`
  return Layer.unwrap(
    Effect.acquireRelease(
      Effect.sync(() => {
        registry().set(integrationID, new Set(sources))
        return layer(integrationID)
      }),
      () => Effect.sync(() => void registry().delete(integrationID)),
    ),
  )
}

credentialSourcesLaws("the process registry", registered)
