// What every implementation of the web mod's contracts owes, as shared test
// suites. Each implementation's test beside it runs the suite over its Layer.
import { describe, expect, test } from "bun:test"
import { Effect, type Layer, type Scope } from "effect"
import { PageUnreadable, Pages, PdfText, PdfUnreadable, ProviderFailed, SearchProviders } from "./service.ts"

/** The body `/small` serves, as text/plain. */
export const SMALL = "a small page"
/** The size of the body `/big` serves, as text/plain: 300 KB of `x`. */
export const BIG_BYTES = 300 * 1024

/** An implementation of Pages serving `/small`, `/big` (declaring its length) and a 404 at `/missing`, at `url(path)`. */
export interface PagesBench {
  readonly layer: Layer.Layer<Pages>
  readonly url: (path: "/small" | "/big" | "/missing") => string
}

export const pagesLaws = (name: string, bench: () => Effect.Effect<PagesBench, never, Scope.Scope>) =>
  describe(`${name} keeps the Pages laws`, () => {
    const check = <A, E>(body: (made: PagesBench) => Effect.Effect<A, E, Pages>) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const made = yield* bench()
            return yield* body(made).pipe(Effect.provide(made.layer))
          }),
        ),
      )

    test("a body under the limit comes whole, with its content type, not cut", () =>
      check((made) =>
        Effect.gen(function* () {
          const page = yield* (yield* Pages).read(made.url("/small"), { maxBytes: 1024, timeoutMs: 5_000 })
          expect(new TextDecoder().decode(page.bytes)).toBe(SMALL)
          expect(page.contentType).toStartWith("text/plain")
          expect(page.cut).toBe(false)
        }),
      ))

    test("a body over the limit comes as exactly its first maxBytes, cut, with the declared total", () =>
      check((made) =>
        Effect.gen(function* () {
          const page = yield* (yield* Pages).read(made.url("/big"), { maxBytes: 64 * 1024, timeoutMs: 5_000 })
          expect(page.bytes.byteLength).toBe(64 * 1024)
          expect(page.cut).toBe(true)
          expect(page.totalBytes).toBe(BIG_BYTES)
        }),
      ))

    test("a 404 fails PageUnreadable naming the URL and the status", () =>
      check((made) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip((yield* Pages).read(made.url("/missing"), { maxBytes: 1024, timeoutMs: 5_000 }))
          expect(error).toBeInstanceOf(PageUnreadable)
          expect(error.url).toBe(made.url("/missing"))
          expect(error.message).toContain("404")
        }),
      ))
  })

/** An implementation of PdfText and how it makes a PDF that says a line. */
export interface PdfBench {
  readonly layer: Layer.Layer<PdfText>
  readonly pdf: (text: string) => Uint8Array
}

export const pdfTextLaws = (name: string, bench: PdfBench) =>
  describe(`${name} keeps the PdfText laws`, () => {
    test("a PDF's text comes back", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const text = yield* (yield* PdfText).extract(bench.pdf("The tenth commandment (Exodus 20:17)"))
          expect(text).toContain("The tenth commandment (Exodus 20:17)")
        }).pipe(Effect.provide(bench.layer)),
      ))

    test("bytes that are no PDF fail PdfUnreadable with a reason", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const error = yield* Effect.flip((yield* PdfText).extract(new TextEncoder().encode("<html>not a pdf</html>")))
          expect(error).toBeInstanceOf(PdfUnreadable)
          expect(error.message).not.toBe("")
        }).pipe(Effect.provide(bench.layer)),
      ))
  })

/** An implementation of SearchProviders over `steady` (answers one result for any query) and `down` (fails with HTTP 429). */
export const searchProvidersLaws = (name: string, layer: Layer.Layer<SearchProviders>) =>
  describe(`${name} keeps the SearchProviders laws`, () => {
    test("it lists the providers and queries one by id", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const providers = yield* SearchProviders
          expect([...(yield* providers.available())].sort()).toEqual(["down", "steady"])
          const hits = yield* providers.query("steady", "bun test")
          expect(hits.length).toBe(1)
          expect(hits[0]?.url).toStartWith("https://")
        }).pipe(Effect.provide(layer)),
      ))

    test("a provider's failure is ProviderFailed naming it, with the status in its message", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const error = yield* Effect.flip((yield* SearchProviders).query("down", "bun test"))
          expect(error).toBeInstanceOf(ProviderFailed)
          expect(error.provider).toBe("down")
          expect(error.message).toContain("429")
        }).pipe(Effect.provide(layer)),
      ))
  })
