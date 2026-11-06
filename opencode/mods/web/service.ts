// The contracts the web mod needs from outside: pages over HTTP, the text of
// a PDF, and the host's web search providers. Each states its failure;
// `laws.ts` states what every implementation owes.
import { Context, type Effect, Schema } from "effect"

/** A page read from the web, whole or cut. */
export interface Page {
  /** The body, at most the `maxBytes` asked for. */
  readonly bytes: Uint8Array
  /** The response's `content-type`, as sent ("" when none). */
  readonly contentType: string
  /** Whether the body went on past `bytes`. */
  readonly cut: boolean
  /** The whole body's size, when the server declared it (`content-length`). */
  readonly totalBytes?: number
}

/** A page could not be read: a network failure, a timeout, or a status other than 2xx. */
export class PageUnreadable extends Schema.TaggedError<PageUnreadable>()("PageUnreadable", {
  url: Schema.String,
  message: Schema.String,
}) {}

/** The web, as far as the web mod reads it. */
export class Pages extends Context.Service<
  Pages,
  {
    /** The first `maxBytes` of the body at `url` (redirects followed), within `timeoutMs`. */
    readonly read: (url: string, options: { readonly maxBytes: number; readonly timeoutMs: number }) => Effect.Effect<Page, PageUnreadable>
  }
>()("dotfiles-opencode/web/Pages") {}

/** A PDF's text could not be extracted: not a PDF, damaged, or no extractor on this machine. */
export class PdfUnreadable extends Schema.TaggedError<PdfUnreadable>()("PdfUnreadable", {
  message: Schema.String,
}) {}

/** PDFs, as text. */
export class PdfText extends Context.Service<
  PdfText,
  {
    /** The text of the PDF in `bytes`, page after page. */
    readonly extract: (bytes: Uint8Array) => Effect.Effect<string, PdfUnreadable>
  }
>()("dotfiles-opencode/web/PdfText") {}

/** One search result, as the host's websearch carries it. */
export interface Hit {
  readonly url: string
  readonly title?: string
  readonly content?: string
  readonly time: { readonly published?: number }
}

/** One provider's search failed. */
export class ProviderFailed extends Schema.TaggedError<ProviderFailed>()("ProviderFailed", {
  provider: Schema.String,
  message: Schema.String,
}) {}

/** The host's web search providers. */
export class SearchProviders extends Context.Service<
  SearchProviders,
  {
    /** The ids of the providers the host has now. */
    readonly available: () => Effect.Effect<ReadonlyArray<string>>
    /** `query` through the provider `provider`, by id. */
    readonly query: (provider: string, query: string) => Effect.Effect<ReadonlyArray<Hit>, ProviderFailed>
  }
>()("dotfiles-opencode/web/SearchProviders") {}
