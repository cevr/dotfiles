// Pages over HTTP against a loopback server, under the Pages laws, and the
// redirect and timeout cases the laws leave to it.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { BIG_BYTES, pagesLaws, SMALL } from "../laws.ts"
import { Pages } from "../service.ts"
import { layer } from "./pages.ts"

const serve = Effect.acquireRelease(
  Effect.sync(() =>
    Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const path = new URL(request.url).pathname
        if (path === "/small") return new Response(SMALL, { headers: { "content-type": "text/plain; charset=utf-8" } })
        if (path === "/big") return new Response("x".repeat(BIG_BYTES), { headers: { "content-type": "text/plain" } })
        if (path === "/moved") return Response.redirect("/small", 302)
        if (path === "/slow") {
          await Bun.sleep(2_000)
          return new Response("late")
        }
        return new Response("not found", { status: 404 })
      },
    }),
  ),
  (server) => Effect.sync(() => server.stop(true)),
)

pagesLaws("Pages over HTTP", () => serve.pipe(Effect.map((server) => ({ layer, url: (path) => `http://127.0.0.1:${server.port}${path}` }))))

describe("Pages over HTTP", () => {
  const run = <A, E>(body: (base: string) => Effect.Effect<A, E, Pages>) =>
    Effect.runPromise(Effect.scoped(serve.pipe(Effect.flatMap((server) => body(`http://127.0.0.1:${server.port}`).pipe(Effect.provide(layer))))))

  test("follows a redirect", () =>
    run((base) =>
      Effect.gen(function* () {
        const page = yield* (yield* Pages).read(`${base}/moved`, { maxBytes: 1024, timeoutMs: 5_000 })
        expect(new TextDecoder().decode(page.bytes)).toBe(SMALL)
      }),
    ))

  test("a server slower than the timeout fails 'Request timed out'", () =>
    run((base) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip((yield* Pages).read(`${base}/slow`, { maxBytes: 1024, timeoutMs: 200 }))
        expect(error.message).toBe("Request timed out")
      }),
    ))
})
