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

export const CREDENTIAL_SOURCES = Symbol.for('opencode.credential-sources')

/** The token a source hands out for one request. */
export interface SourcedCredential {
  readonly access: string
  /** Epoch ms. */
  readonly expires: number
}

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
}

/** The source that owns `credentialID` among the integration's registered sources. */
export function credentialSource(
  integrationID: string,
  credentialID: string,
): CredentialSource | undefined {
  const registry = (globalThis as Record<symbol, unknown>)[CREDENTIAL_SOURCES]
  if (!(registry instanceof Map)) return undefined
  const sources: unknown = registry.get(integrationID)
  if (!(sources instanceof Set)) return undefined
  for (const source of sources as Set<Partial<CredentialSource>>) {
    if (
      typeof source?.owns === 'function' &&
      typeof source.resolve === 'function' &&
      source.owns(credentialID)
    ) {
      return source as CredentialSource
    }
  }
  return undefined
}

/** A source's token, checked: anything else fails the request. */
export async function resolveSourced(
  source: CredentialSource,
  credentialID: string,
): Promise<SourcedCredential> {
  const credential: unknown = await source.resolve(credentialID)
  const value = credential as Partial<SourcedCredential> | null
  if (
    typeof value?.access !== 'string' ||
    value.access === '' ||
    typeof value.expires !== 'number' ||
    !Number.isFinite(value.expires)
  ) {
    throw new Error('The credential source answered without a usable token')
  }
  return { access: value.access, expires: value.expires }
}

/** When a source's failure says the credential may be tried again (epoch ms), if it says. */
export function retryAtOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const retryAt = (error as { retryAt?: unknown }).retryAt
  return typeof retryAt === 'number' && Number.isFinite(retryAt)
    ? retryAt
    : undefined
}
