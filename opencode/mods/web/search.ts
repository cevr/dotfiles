// Web search that needs nobody to answer a form.
//
// OpenCode's websearch tool asks the session a consent form when no provider
// is selected; in a subagent nobody answers, and after a minute the call fails
// "Web search cancelled" (measured: 7 of 7 calls on the workbox, 7 of 51 on
// the Mac, all in subagents). The web mod registers one provider, `web`, that
// asks the host's own providers in turn and answers with the first that
// returns results, and makes it the default when nothing else is chosen.
import { Schema } from "effect"

/** The id of the provider the web mod registers. */
export const SELF = "web"

/**
 * The order the providers are asked in by default. Each of the host's built-in
 * providers answers without a key (probed on both hosts, 2026-11-06); with
 * `EXA_API_KEY`, `TAVILY_API_KEY` and the rest in the environment the host
 * sends the key. Exa answered fastest.
 */
export const DEFAULT_ORDER: ReadonlyArray<string> = ["exa", "parallel", "tavily", "firecrawl", "tinyfish"]

/** The providers to ask, in order: those of `order` the host has, never this mod's own. */
export const chain = (order: ReadonlyArray<string>, available: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(order)].filter((id) => id !== SELF && available.includes(id))

/** The provider the host's websearch should default to: `web` when nothing (no config, no earlier choice in this load) chose one. */
export const defaultSelection = (current: string | false | undefined): string | undefined => (current === undefined ? SELF : undefined)

/** One provider that failed, and how. */
export interface Attempt {
  readonly provider: string
  readonly message: string
}

/** Every provider in the chain failed, or the host has none of them. */
export class SearchExhausted extends Schema.TaggedError<SearchExhausted>()("SearchExhausted", {
  attempts: Schema.Array(Schema.Struct({ provider: Schema.String, message: Schema.String })),
  order: Schema.Array(Schema.String),
  message: Schema.String,
}) {}

/** The rejection for `attempts` over `order`, with the words the agent reads. */
export const exhausted = (attempts: ReadonlyArray<Attempt>, order: ReadonlyArray<string>): SearchExhausted =>
  new SearchExhausted({
    attempts: [...attempts],
    order: [...order],
    message:
      attempts.length === 0
        ? `no web search provider of ${order.join(", ")} is registered`
        : `every web search provider failed: ${attempts.map((attempt) => `${attempt.provider}: ${attempt.message}`).join("; ")}`,
  })
