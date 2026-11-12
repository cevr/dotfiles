// A credential another plugin keeps outside OpenCode's credential store (the
// pool's login store): the token it hands out, checked, and when a failure
// says the credential may be tried again. The registry the plugins meet in is
// `registry/credential-sources.ts`; the contract this plugin reads it through
// is `CredentialSources` in service.ts.
import { isRecord } from "./json.ts"

/** The token a source hands out for one request. */
export interface SourcedCredential {
  readonly access: string
  /** Epoch ms. */
  readonly expires: number
}

/** A source's answer as a token: none unless it has a non-empty access token and a finite expiry. */
export function usable(credential: unknown): SourcedCredential | undefined {
  if (!isRecord(credential)) return undefined
  const { access, expires } = credential
  if (typeof access !== "string" || access === "" || typeof expires !== "number" || !Number.isFinite(expires)) {
    return undefined
  }
  return { access, expires }
}

/** When a source's failure says the credential may be tried again (epoch ms), if it says. */
export function retryAtOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("retryAt" in error)) return undefined
  const retryAt = error.retryAt
  return typeof retryAt === "number" && Number.isFinite(retryAt) ? retryAt : undefined
}

export const UNUSABLE_SOURCED_TOKEN = "The credential source answered without a usable token"
