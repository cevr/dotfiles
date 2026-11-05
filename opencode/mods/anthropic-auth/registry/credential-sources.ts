/**
 * Credentials another plugin keeps outside OpenCode's credential store, such
 * as another program's logins that plugin reads and refreshes under that
 * program's own rules. The plugin registers a source for an integration in a
 * process-wide registry; when the credential a request is placed on
 * (`CREDENTIAL_HEADER`) belongs to a source, this plugin takes its token from
 * the source and never refreshes it itself.
 *
 * The registry is a `Map` from integration id to a `Set` of sources at
 * `globalThis[Symbol.for('opencode.credential-sources')]`. It lives in the
 * process, never over RPC, so a token never crosses the server's HTTP API.
 */
import { Effect, Layer } from "effect"
import { retryAtOf, type SourcedCredential, UNUSABLE_SOURCED_TOKEN, usable } from "../credential-source.ts"
import { CredentialSources, type Source, SourceFailed } from "../service.ts"

export const CREDENTIAL_SOURCES = Symbol.for("opencode.credential-sources")

/** A source as another plugin registers it. */
export interface CredentialSource {
  /** Whether `credentialID` names one of this source's credentials. */
  readonly owns: (credentialID: string) => boolean
  /**
   * The token to send now. The source refreshes it when it must, under its
   * own rules. A failure may carry `retryAt` (epoch ms): the credential is
   * refused until then, else until the owner signs in again.
   */
  readonly resolve: (credentialID: string) => Promise<SourcedCredential>
  /** The provider rejected `access` (a 401): the source refreshes it next time if it still holds it. */
  readonly rejected?: (credentialID: string, access: string) => void
  /**
   * The token the source holds now while it is good, else none; never
   * refreshes. The usage sweep reads through it, so a sweep never makes a
   * source refresh. A source without it is not swept: its credentials keep
   * the readings their responses give.
   */
  readonly peek?: (credentialID: string) => Promise<SourcedCredential | undefined>
}

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> => typeof value === "object" && value !== null

/**
 * Whether a registered entry has the members every source must have. Its
 * optional members are checked again where they are called.
 */
function isCredentialSource(entry: unknown): entry is CredentialSource {
  return isRecord(entry) && typeof entry.owns === "function" && typeof entry.resolve === "function"
}

/** The source that owns `credentialID` among the integration's registered sources. */
export function credentialSource(integrationID: string, credentialID: string): CredentialSource | undefined {
  const registry: unknown = Reflect.get(globalThis, CREDENTIAL_SOURCES)
  if (!(registry instanceof Map)) return undefined
  const sources: unknown = registry.get(integrationID)
  if (!(sources instanceof Set)) return undefined
  for (const entry of sources) {
    if (isCredentialSource(entry) && entry.owns(credentialID)) return entry
  }
  return undefined
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** `source` as the plugin reads it: a checked token, a failure with its retry time, a 401 passed on. */
export function readSource(source: CredentialSource, credentialID: string): Source {
  return {
    resolve: Effect.tryPromise({
      try: () => source.resolve(credentialID),
      catch: (error) => {
        const retryAt = retryAtOf(error)
        return new SourceFailed({ message: messageOf(error), ...(retryAt === undefined ? {} : { retryAt }) })
      },
    }).pipe(
      Effect.flatMap((answer) => {
        const credential = usable(answer)
        return credential === undefined
          ? Effect.fail(new SourceFailed({ message: UNUSABLE_SOURCED_TOKEN }))
          : Effect.succeed(credential)
      }),
    ),
    peek:
      typeof source.peek === "function"
        ? Effect.promise(() =>
            Promise.resolve()
              .then(() => source.peek?.(credentialID))
              .then(usable, () => undefined),
          )
        : undefined,
    rejected: (access) =>
      Effect.try({
        try: () => {
          if (typeof source.rejected === "function") source.rejected(credentialID, access)
        },
        catch: () => undefined,
      }).pipe(Effect.ignore),
  }
}

/** The sources registered for `integrationID` in this process's registry. */
export const layer = (integrationID: string) =>
  Layer.succeed(CredentialSources, {
    find: (credentialID) =>
      Effect.sync(() => {
        const source = credentialSource(integrationID, credentialID)
        return source === undefined ? undefined : readSource(source, credentialID)
      }),
  })
