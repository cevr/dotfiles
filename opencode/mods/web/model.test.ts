// The web mod's handlers on stand-in layers: what a failed webfetch call
// becomes, and the order the search providers are asked in.
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { Unfetchable } from "./fetch.ts"
import { type Config, type FetchCall, layer, Web } from "./model.ts"
import { SearchExhausted } from "./search.ts"
import { type Hit, PageUnreadable, Pages, PdfText, PdfUnreadable, ProviderFailed, SearchProviders } from "./service.ts"

const config: Config = { cutBytes: 1024, pdfMaxBytes: 4096, order: ["exa", "parallel", "tavily"] }

// The stand-ins. A "PDF" is `%PDF-` and its text; a page is its body or a status; a provider its hits or a failure.
const MemoryPdfText = {
  pdf: (text: string): Uint8Array => new TextEncoder().encode(`%PDF-${text}`),
  layer: Layer.succeed(
    PdfText,
    PdfText.of({
      extract: (bytes) => {
        const text = new TextDecoder().decode(bytes)
        return text.startsWith("%PDF-") ? Effect.succeed(text.slice(5)) : Effect.fail(new PdfUnreadable({ message: "not a PDF" }))
      },
    }),
  ),
}

type Entry = { readonly body: string | Uint8Array; readonly contentType: string; readonly declared?: boolean } | { readonly status: number }

const MemoryPages = {
  layer: (world: Readonly<Record<string, Entry>>, reads: Array<{ readonly url: string; readonly maxBytes: number }>) =>
    Layer.succeed(
      Pages,
      Pages.of({
        read: (url, options) =>
          Effect.gen(function* () {
            reads.push({ url, maxBytes: options.maxBytes })
            const entry = world[url]
            if (entry === undefined) return yield* new PageUnreadable({ url, message: "Transport error" })
            if ("status" in entry) return yield* new PageUnreadable({ url, message: `HTTP ${entry.status}` })
            const bytes = typeof entry.body === "string" ? new TextEncoder().encode(entry.body) : entry.body
            return {
              bytes: bytes.subarray(0, options.maxBytes),
              contentType: entry.contentType,
              cut: bytes.byteLength > options.maxBytes,
              ...(entry.declared === false ? {} : { totalBytes: bytes.byteLength }),
            }
          }),
      }),
    ),
}

type Answer = ReadonlyArray<Hit> | { readonly fail: string }

const MemoryProviders = {
  layer: (world: Readonly<Record<string, Answer>>, asked: string[]) =>
    Layer.succeed(
      SearchProviders,
      SearchProviders.of({
        available: () => Effect.succeed(Object.keys(world)),
        query: (provider) => {
          asked.push(provider)
          const answer = world[provider]
          if (answer === undefined) return Effect.fail(new ProviderFailed({ provider, message: "not found" }))
          if ("fail" in answer) return Effect.fail(new ProviderFailed({ provider, message: answer.fail }))
          return Effect.succeed(answer)
        },
      }),
    ),
}

const PDF_FAILURE = "Unsupported fetched file content type: application/pdf"
const LARGE_FAILURE = "Response too large (exceeds 5242880 byte limit)"

const call = (url: string, format: FetchCall["format"] = "markdown"): FetchCall => ({ url, format, timeoutMs: 5_000 })

const run = <A, E>(
  body: Effect.Effect<A, E, Web>,
  world: { pages?: Readonly<Record<string, Entry>>; providers?: Readonly<Record<string, Answer>> } = {},
  reads: Array<{ readonly url: string; readonly maxBytes: number }> = [],
  asked: string[] = [],
) =>
  Effect.runPromise(
    body.pipe(
      Effect.provide(
        layer(config).pipe(
          Layer.provide(Layer.mergeAll(MemoryPages.layer(world.pages ?? {}, reads), MemoryPdfText.layer, MemoryProviders.layer(world.providers ?? {}, asked))),
        ),
      ),
    ),
  )

describe("recover", () => {
  test("a PDF is read again, whole up to pdfMaxBytes, and answered as its text", async () => {
    const reads: Array<{ url: string; maxBytes: number }> = []
    const fetched = await run(
      Effect.gen(function* () {
        return yield* (yield* Web).recover(call("https://unh.edu/mayer.pdf"), PDF_FAILURE)
      }),
      { pages: { "https://unh.edu/mayer.pdf": { body: MemoryPdfText.pdf("Sabbath School lesson"), contentType: "application/pdf" } } },
      reads,
    )
    expect(fetched).toEqual(Option.some({ contentType: "application/pdf", output: "Sabbath School lesson", recovered: "pdf" }))
    expect(reads).toEqual([{ url: "https://unh.edu/mayer.pdf", maxBytes: 4096 }])
  })

  test("a PDF whose text is over cutBytes is cut, the note first", async () => {
    const fetched = await run(
      Effect.gen(function* () {
        return yield* (yield* Web).recover(call("https://a.dev/long.pdf"), PDF_FAILURE)
      }),
      { pages: { "https://a.dev/long.pdf": { body: MemoryPdfText.pdf("y".repeat(2048)), contentType: "application/pdf" } } },
    )
    const output = Option.getOrThrow(fetched).output
    expect(output).toStartWith("[webfetch: the PDF's text cut to the first 1 KB of 2 KB.")
    expect(output.endsWith(`\n\n${"y".repeat(1024)}`)).toBe(true)
  })

  test("a PDF over pdfMaxBytes fails, naming how to read it by hand", async () => {
    const error = await run(
      Effect.flip(
        Effect.gen(function* () {
          return yield* (yield* Web).recover(call("https://a.dev/huge.pdf"), PDF_FAILURE)
        }),
      ),
      { pages: { "https://a.dev/huge.pdf": { body: MemoryPdfText.pdf("z".repeat(8192)), contentType: "application/pdf" } } },
    )
    expect(error).toBeInstanceOf(Unfetchable)
    expect(error.message).toBe(
      "https://a.dev/huge.pdf is a PDF over 4 KB: download it (`curl -sL 'https://a.dev/huge.pdf' -o <file>.pdf`) and read it with `pdftotext <file>.pdf -`.",
    )
  })

  test("a body over the built-in's limit is read again, its first cutBytes only, as text under a note", async () => {
    const reads: Array<{ url: string; maxBytes: number }> = []
    const html = `<html><body><h1>Models</h1><p>${"m".repeat(4096)}</p></body></html>`
    const fetched = await run(
      Effect.gen(function* () {
        return yield* (yield* Web).recover(call("https://models.dev/api"), LARGE_FAILURE)
      }),
      { pages: { "https://models.dev/api": { body: html, contentType: "text/html; charset=utf-8" } } },
      reads,
    )
    const answer = Option.getOrThrow(fetched)
    expect(answer.recovered).toBe("cut")
    expect(answer.output).toStartWith("[webfetch: the body cut to the first 1 KB of 4 KB.")
    expect(answer.output).toContain("\n\nModels\nmmm")
    expect(answer.output).not.toContain("<h1>")
    expect(reads).toEqual([{ url: "https://models.dev/api", maxBytes: 1024 }])
  })

  test("format html keeps the cut body's markup", async () => {
    const fetched = await run(
      Effect.gen(function* () {
        return yield* (yield* Web).recover(call("https://a.dev/page", "html"), LARGE_FAILURE)
      }),
      { pages: { "https://a.dev/page": { body: `<p>${"h".repeat(2048)}</p>`, contentType: "text/html" } } },
    )
    expect(Option.getOrThrow(fetched).output).toContain("\n\n<p>hhh")
  })

  test("a body whose size the server did not declare says 'of a larger body'", async () => {
    const fetched = await run(
      Effect.gen(function* () {
        return yield* (yield* Web).recover(call("https://a.dev/stream.json"), LARGE_FAILURE)
      }),
      { pages: { "https://a.dev/stream.json": { body: "{".repeat(2048), contentType: "application/json", declared: false } } },
    )
    expect(Option.getOrThrow(fetched).output).toStartWith("[webfetch: the body cut to the first 1 KB of a larger body.")
  })

  test("a 404 on a guessed GitHub raw URL fails naming okra repo fetch, and reads nothing", async () => {
    const reads: Array<{ url: string; maxBytes: number }> = []
    const url = "https://raw.githubusercontent.com/anomalyco/rift/main/README.md"
    const error = await run(
      Effect.flip(
        Effect.gen(function* () {
          return yield* (yield* Web).recover(call(url), `StatusCode: non 2xx status code (404 GET ${url})`)
        }),
      ),
      {},
      reads,
    )
    expect(error.status).toBe(404)
    expect(error.message).toContain("run `okra repo fetch anomalyco/rift`")
    expect(reads).toEqual([])
  })

  test("any other failure is left to the built-in", async () => {
    const fetched = await run(
      Effect.gen(function* () {
        return yield* (yield* Web).recover(call("https://www.npr.org/x"), "Request timed out")
      }),
    )
    expect(fetched).toEqual(Option.none())
  })

  test("a refetch that fails says so, with the URL", async () => {
    const error = await run(
      Effect.flip(
        Effect.gen(function* () {
          return yield* (yield* Web).recover(call("https://a.dev/gone.pdf"), PDF_FAILURE)
        }),
      ),
    )
    expect(error.message).toBe("Unable to fetch https://a.dev/gone.pdf: Transport error")
  })
})

describe("search", () => {
  const hit = (url: string) => ({ url, title: url, time: {} })

  test("asks the providers in the configured order and answers with the first that has results", async () => {
    const asked: string[] = []
    const hits = await run(
      Effect.gen(function* () {
        return yield* (yield* Web).search("bun test")
      }),
      { providers: { tavily: [hit("https://t.dev")], parallel: [hit("https://p.dev")], exa: { fail: "HTTP 429: rate limited" } } },
      [],
      asked,
    )
    expect(hits.map((h) => h.url)).toEqual(["https://p.dev"])
    expect(asked).toEqual(["exa", "parallel"])
  })

  test("a provider with no results passes to the next; all empty answers empty", async () => {
    const asked: string[] = []
    const hits = await run(
      Effect.gen(function* () {
        return yield* (yield* Web).search("nothing")
      }),
      { providers: { exa: [], parallel: { fail: "timed out" }, tavily: [] } },
      [],
      asked,
    )
    expect(hits).toEqual([])
    expect(asked).toEqual(["exa", "parallel", "tavily"])
  })

  test("every provider failing fails SearchExhausted naming each", async () => {
    const error = await run(
      Effect.flip(
        Effect.gen(function* () {
          return yield* (yield* Web).search("bun test")
        }),
      ),
      { providers: { exa: { fail: "HTTP 401: Unauthorized" }, tavily: { fail: "timed out" } } },
    )
    expect(error).toBeInstanceOf(SearchExhausted)
    expect(error.message).toBe("every web search provider failed: exa: HTTP 401: Unauthorized; tavily: timed out")
  })

  test("a host with none of the order's providers fails saying so", async () => {
    const error = await run(
      Effect.flip(
        Effect.gen(function* () {
          return yield* (yield* Web).search("bun test")
        }),
      ),
      { providers: { brave: [hit("https://b.dev")] } },
    )
    expect(error.message).toBe("no web search provider of exa, parallel, tavily is registered")
  })
})
