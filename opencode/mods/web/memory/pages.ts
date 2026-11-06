// Pages held in memory: each URL to its body and content type, or to a
// status that is not 2xx; any other URL fails as a network failure would.
// Each read is recorded, with the bytes asked for.
import { Effect, Layer } from "effect"
import { PageUnreadable, Pages } from "../service.ts"

export type Entry =
  | { readonly body: string | Uint8Array; readonly contentType: string; readonly declared?: boolean }
  | { readonly status: number }

export type World = Readonly<Record<string, Entry>>

/** The pages of `world`; `reads` collects each read's URL and maxBytes. */
export const layer = (world: World, reads: Array<{ readonly url: string; readonly maxBytes: number }> = []) =>
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
  )
