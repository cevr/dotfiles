// The page's listener over a real socket: it binds loopback only, serves the page's built files with their content
// types and nothing outside them, answers the view as JSON, and takes a mark, a Later or a rename only as a POST from
// its own origin with the page's header. A port another server holds is waited for, never shared.
import { describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { networkInterfaces } from "node:os"
import { join } from "node:path"
import { Effect, Option, Ref, Scope } from "effect"
import { scratch } from "../../../tests/scratch.ts"
import type { MarkLine } from "../marks.ts"
import { type Handlers, HOSTNAME, listen, PAGE_HEADER } from "./listener.ts"

const NOW = 1_795_204_800_000

/** A built page in `dir`: index.html and one asset, and a file beside the folder that must never be served. */
const builtPage = (root: string): string => {
  const dist = join(root, "dist")
  mkdirSync(join(dist, "assets"), { recursive: true })
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>Digest</title>")
  writeFileSync(join(dist, "assets", "index-abc.js"), "console.log(1)")
  writeFileSync(join(dist, "assets", "index-abc.css"), "body{}")
  writeFileSync(join(root, "secret.txt"), "not for the page")
  return dist
}

/** Handlers that keep each line written, and answer a fixed view. */
const handlers = (written: Ref.Ref<ReadonlyArray<MarkLine>>): Handlers => ({
  view: Effect.succeed('{"v":1}'),
  write: (line) => Ref.update(written, (lines) => [...lines, line]),
  now: Effect.succeed(NOW),
  zone: "America/Montreal",
})

/** The listener on a free port for `body`, closed after it. */
const withListener = <A>(dist: string, body: (base: string, written: Ref.Ref<ReadonlyArray<MarkLine>>, hostname: string) => Promise<A>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const written = yield* Ref.make<ReadonlyArray<MarkLine>>([])
        const bound = yield* listen(0, handlers(written), dist)
        return yield* Effect.promise(() => body(`http://${HOSTNAME}:${bound.port}`, written, bound.hostname))
      }),
    ),
  )

const post = (url: string, body: Readonly<Record<string, string>>, headers: Record<string, string>) =>
  fetch(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } })

describe("the page's listener", () => {
  test("binds 127.0.0.1 only: no other address of the host reaches it", async () => {
    using held = scratch("digest-http-")
    await withListener(builtPage(held.path), async (base, _written, hostname) => {
      expect(hostname).toBe("127.0.0.1")
      expect((await fetch(`${base}/`)).status).toBe(200)
      const port = new URL(base).port
      const others = Object.values(networkInterfaces())
        .flat()
        .flatMap((each) => Option.toArray(Option.map(Option.filter(Option.fromUndefinedOr(each), (one) => one.family === "IPv4" && !one.internal), (one) => one.address)))
      for (const address of others) expect(await Effect.runPromise(Effect.match(Effect.tryPromise(() => fetch(`http://${address}:${port}/`)), { onSuccess: () => "reached", onFailure: () => "refused" }))).toBe("refused")
    })
  })

  test("serves the page and its assets with their content types, and the view as JSON", async () => {
    using held = scratch("digest-http-")
    await withListener(builtPage(held.path), async (base) => {
      const page = await fetch(`${base}/`)
      expect([page.status, page.headers.get("content-type"), await page.text()]).toEqual([200, "text/html; charset=utf-8", "<!doctype html><title>Digest</title>"])
      expect(page.headers.get("content-security-policy")).toContain("default-src 'self'")
      expect(page.headers.get("x-content-type-options")).toBe("nosniff")
      const script = await fetch(`${base}/assets/index-abc.js`)
      expect([script.status, script.headers.get("content-type")]).toEqual([200, "text/javascript; charset=utf-8"])
      expect((await fetch(`${base}/assets/index-abc.css`)).headers.get("content-type")).toBe("text/css; charset=utf-8")
      const view = await fetch(`${base}/view.json`)
      expect([view.status, view.headers.get("content-type"), view.headers.get("cache-control"), await view.text()]).toEqual([200, "application/json", "no-store", '{"v":1}'])
    })
  })

  test("nothing outside the built page is served, however the path is spelled", async () => {
    using held = scratch("digest-http-")
    await withListener(builtPage(held.path), async (base) => {
      const paths = ["/assets/../../secret.txt", "/assets/%2e%2e/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt", "/assets/.%2e/.%2e/secret.txt", "/../secret.txt", "/secret.txt", "/assets/", "/assets/missing.js", "/index.html/../../secret.txt", "/assets/%00.js"]
      for (const path of paths) {
        const answer = await fetch(`${base}${path}`)
        expect([path, answer.status === 404 || answer.status === 400, (await answer.text()).includes("not for the page")]).toEqual([path, true, false])
      }
    })
  })

  test("a request naming another host is refused (a rebound name never reads the view)", async () => {
    using held = scratch("digest-http-")
    await withListener(builtPage(held.path), async (base) => {
      expect((await fetch(`${base}/view.json`, { headers: { host: "evil.example:8240" } })).status).toBe(421)
      expect((await fetch(`${base}/view.json`, { headers: { host: `localhost:${new URL(base).port}` } })).status).toBe(200)
    })
  })

  test("a mark, a Later and a rename are written from the page's own origin with its header", async () => {
    using held = scratch("digest-http-")
    await withListener(builtPage(held.path), async (base, written) => {
      const own = { origin: base, [PAGE_HEADER]: "1" }
      expect((await post(`${base}/api/mark`, { id: "m1", mark: "read" }, own)).status).toBe(204)
      expect((await post(`${base}/api/later`, { id: "m2" }, own)).status).toBe(204)
      expect((await post(`${base}/api/name`, { project: "harbor", name: "Harbor Lights" }, own)).status).toBe(204)
      expect((await post(`${base}/api/since`, {}, own)).status).toBe(204)
      const lines = await Effect.runPromise(Ref.get(written))
      expect(lines.map((line) => line._tag)).toEqual(["Mark", "Mark", "Name", "Since"])
      // Friday 3 PM in Montreal: back Saturday 6 AM.
      expect(lines.flatMap((line) => Option.toArray(Option.map(Option.liftPredicate(line, (each) => each._tag === "Mark"), (each) => each.returnsAt)))).toEqual([Option.none(), Option.some(Date.parse("2026-11-21T11:00:00Z"))])
    })
  })

  test("a write from another origin, without the page's header, as a GET, or malformed is refused and writes nothing", async () => {
    using held = scratch("digest-http-")
    await withListener(builtPage(held.path), async (base, written) => {
      const mark = { id: "m1", mark: "read" }
      const refusals = [
        await post(`${base}/api/mark`, mark, { origin: "http://evil.example", [PAGE_HEADER]: "1" }),
        await post(`${base}/api/mark`, mark, { origin: "http://localhost:1", [PAGE_HEADER]: "1" }),
        await post(`${base}/api/mark`, mark, { [PAGE_HEADER]: "1" }),
        await post(`${base}/api/mark`, mark, { origin: base }),
        await fetch(`${base}/api/mark`, { method: "POST", body: JSON.stringify(mark), headers: { origin: base, [PAGE_HEADER]: "1", "content-type": "text/plain" } }),
        await fetch(`${base}/api/mark?id=m1&mark=read`),
        await post(`${base}/api/mark`, { id: "m1", mark: "gone" }, { origin: base, [PAGE_HEADER]: "1" }),
        await post(`${base}/api/name`, { project: "harbor", name: "x".repeat(81) }, { origin: base, [PAGE_HEADER]: "1" }),
      ]
      expect(refusals.map((answer) => answer.status)).toEqual([403, 403, 403, 403, 415, 405, 400, 400])
      expect(await Effect.runPromise(Ref.get(written))).toEqual([])
    })
  })

  test("a port another server holds is not shared: the second listen fails, so it waits its turn", async () => {
    using held = scratch("digest-http-")
    const dist = builtPage(held.path)
    await withListener(dist, async (base) => {
      const port = Number(new URL(base).port)
      const second = await Effect.runPromiseExit(
        Effect.scoped(Effect.flatMap(Ref.make<ReadonlyArray<MarkLine>>([]), (written) => listen(port, handlers(written), dist))).pipe(Effect.provideService(Scope.Scope, Scope.makeUnsafe())),
      )
      expect(second._tag).toBe("Failure")
    })
  })
})
