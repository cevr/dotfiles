// SearchProviders over OpenCode's websearch domain: the providers it lists,
// and a query through one by id (the host's own `websearch.query` with a
// `providerID`, which never asks the consent form). A provider's failure,
// whatever the host wraps it in, fails ProviderFailed with the deepest
// message it carries, so the agent reads `HTTP 429`, not a wrapper's name.
import { Effect, Layer } from "effect"
import { type Hit, ProviderFailed, SearchProviders } from "../service.ts"

/** As much of the plugin context's `websearch` as this reads. */
export interface Host {
  readonly providers: () => Effect.Effect<{ readonly data: ReadonlyArray<{ readonly id: string }> }, unknown>
  readonly query: (input: { readonly query: string; readonly providerID: string }) => Effect.Effect<{ readonly data: { readonly results: ReadonlyArray<Hit> } }, unknown>
}

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && key in value ? (value as Record<string, unknown>)[key] : undefined

/** The innermost non-empty message of an error and the causes it wraps; an HTTP status read off a response when there is one. */
export const describe = (error: unknown): string => {
  const messages: string[] = []
  let status: unknown
  for (let at = error, depth = 0; at !== undefined && at !== null && depth < 6; at = field(at, "cause"), depth += 1) {
    const message = field(at, "message")
    if (typeof message === "string" && message.trim() !== "") messages.push(message.trim())
    status ??= field(field(at, "response"), "status")
  }
  const message = messages.at(-1) ?? String(error)
  return typeof status === "number" && !message.includes(String(status)) ? `HTTP ${status}: ${message}` : message
}

export const layer = (host: Host) =>
  Layer.succeed(
    SearchProviders,
    SearchProviders.of({
      available: () =>
        host.providers().pipe(
          Effect.map((answer) => answer.data.map((provider) => provider.id)),
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
        ),
      query: (provider, query) =>
        host.query({ query, providerID: provider }).pipe(
          Effect.map((answer) => answer.data.results),
          Effect.mapError((error) => new ProviderFailed({ provider, message: describe(error) })),
        ),
    }),
  )
