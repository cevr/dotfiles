// The web mod's handlers: `recover` answers a webfetch call the built-in
// failed, and `search` asks the host's search providers in turn. The plugin
// calls these and nothing else.
//
// `recover` acts on three failures (`fetch.ts`): a PDF is fetched again and
// read as text; a body over the built-in's limit is fetched again, only its
// first `cutBytes`, and answered with a note saying so; a 404 or 410 fails
// with what to do instead of guessing again. Any other failure stays the
// built-in's (`Option.none`).
import { Context, Effect, Layer, Option } from "effect"
import { classify, cutNote, cutText, missingMessage, size, textOf, Unfetchable } from "./fetch.ts"
import { chain, exhausted, type Attempt, type SearchExhausted } from "./search.ts"
import { type Hit, Pages, PdfText, SearchProviders } from "./service.ts"

/** The mod's settings, from the plugin's options. */
export interface Config {
  /** The most of a body (or a PDF's text) an answer carries; past it, the answer is cut and says so. */
  readonly cutBytes: number
  /** The largest PDF read. */
  readonly pdfMaxBytes: number
  /** The search providers to ask, in order. */
  readonly order: ReadonlyArray<string>
}

/** A webfetch call, as the built-in took it. */
export interface FetchCall {
  readonly url: string
  readonly format: "text" | "markdown" | "html"
  readonly timeoutMs: number
}

/** A recovered answer: the body as the built-in would have given it, and how it was recovered. */
export interface Fetched {
  readonly contentType: string
  readonly output: string
  readonly recovered: "pdf" | "cut"
}

export class Web extends Context.Service<
  Web,
  {
    /** The answer for `call`, which the built-in failed with `failure`: none when the failure is not one this mod acts on. */
    readonly recover: (call: FetchCall, failure: string) => Effect.Effect<Option.Option<Fetched>, Unfetchable>
    /** The first provider's results that has any; none when every provider that answered found nothing. */
    readonly search: (query: string) => Effect.Effect<ReadonlyArray<Hit>, SearchExhausted>
  }
>()("dotfiles-opencode/web/Web") {}

const isHtml = (contentType: string) => /\b(text\/html|application\/xhtml\+xml)\b/i.test(contentType)

export const layer = (config: Config) =>
  Layer.effect(
    Web,
    Effect.gen(function* () {
      const pages = yield* Pages
      const pdfs = yield* PdfText
      const providers = yield* SearchProviders

      const read = (call: FetchCall, maxBytes: number) =>
        pages
          .read(call.url, { maxBytes, timeoutMs: call.timeoutMs })
          .pipe(Effect.mapError((error) => new Unfetchable({ url: call.url, message: `Unable to fetch ${call.url}: ${error.message}` })))

      const pdf = Effect.fn("Web.pdf")(function* (call: FetchCall) {
        const page = yield* read(call, config.pdfMaxBytes)
        if (page.cut)
          return yield* new Unfetchable({
            url: call.url,
            message: `${call.url} is a PDF over ${size(config.pdfMaxBytes)}: download it (\`curl -sL '${call.url}' -o <file>.pdf\`) and read it with \`pdftotext <file>.pdf -\`.`,
          })
        const text = yield* pdfs
          .extract(page.bytes)
          .pipe(Effect.mapError((error) => new Unfetchable({ url: call.url, message: `${call.url} is a PDF whose text could not be read: ${error.message}` })))
        const shown = cutText(text, config.cutBytes)
        const output = shown.cut
          ? `${cutNote({ url: call.url, what: "the PDF's text", shownBytes: config.cutBytes, totalBytes: shown.bytes })}\n\n${shown.text}`
          : text
        return { contentType: page.contentType || "application/pdf", output, recovered: "pdf" } satisfies Fetched
      })

      const cut = Effect.fn("Web.cut")(function* (call: FetchCall) {
        const page = yield* read(call, config.cutBytes)
        const decoded = new TextDecoder().decode(page.bytes)
        const body = call.format !== "html" && isHtml(page.contentType) ? textOf(decoded) : decoded
        // A compressed response declares its compressed size, which can be less than what was read.
        const total = page.totalBytes !== undefined && page.totalBytes > page.bytes.byteLength ? { totalBytes: page.totalBytes } : {}
        const output = page.cut ? `${cutNote({ url: call.url, what: "the body", shownBytes: page.bytes.byteLength, ...total })}\n\n${body}` : body
        return { contentType: page.contentType, output, recovered: "cut" } satisfies Fetched
      })

      const recover = Effect.fn("Web.recover")(function* (call: FetchCall, failure: string) {
        const kind = classify(failure, call.url)
        switch (kind._tag) {
          case "Missing":
            return yield* new Unfetchable({ url: call.url, status: kind.status, message: missingMessage(call.url, kind.status) })
          case "Pdf":
            return Option.some(yield* pdf(call))
          case "TooLarge":
            return Option.some(yield* cut(call))
          case "Other":
            return Option.none<Fetched>()
        }
      })

      const search = Effect.fn("Web.search")(function* (query: string) {
        const ids = chain(config.order, yield* providers.available())
        const attempts: Attempt[] = []
        let answered = false
        for (const id of ids) {
          const result = yield* Effect.result(providers.query(id, query))
          if (result._tag === "Failure") {
            attempts.push({ provider: id, message: result.failure.message })
            continue
          }
          if (result.success.length > 0) return result.success
          answered = true
        }
        if (answered) return []
        return yield* exhausted(attempts, config.order)
      })

      return Web.of({ recover, search })
    }),
  )
