// The page's listener over a real socket: it binds loopback only, serves the page's built files with their content
// types and nothing outside them, answers the view as JSON, and takes a mark, a Later or a rename only as a POST from
// its own origin with the page's header. A port another server holds is waited for, never shared.
import { describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { networkInterfaces } from "node:os"
import { join } from "node:path"
import { Effect, Option, Ref, Scope } from "effect"
import { scratch } from "../../../tests/scratch.ts"
import { AnswerOutcome, type PageAnswer } from "../answers.ts"
import * as FilePairing from "../filestore/pairing.ts"
import type { MarkLine } from "../marks.ts"
import { ACCESS, CODE_TTL_MS, COOKIE, type Pairing, RATE_FAILURES } from "../pairing.ts"
import { type Handlers, HOSTNAME, kindOf, listen, PAGE_HEADER } from "./listener.ts"

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

/** What a test reads of its listener's handlers: the lines written, the answers sent, its clock, its pairing. */
interface Rig {
  readonly written: Ref.Ref<ReadonlyArray<MarkLine>>
  readonly answered: Ref.Ref<ReadonlyArray<PageAnswer>>
  readonly clock: Ref.Ref<number>
  readonly pairing: Pairing
  /** What the next answer comes to. */
  readonly outcome: Ref.Ref<AnswerOutcome>
}

/** Handlers that keep each line written and each answer sent, and answer a fixed view, on the rig's clock. */
const handlers = (rig: Rig, failures: Ref.Ref<ReadonlyArray<number>>): Handlers => ({
  view: Effect.succeed('{"v":1}'),
  write: (line) => Ref.update(rig.written, (lines) => [...lines, line]),
  now: Ref.get(rig.clock),
  zone: "America/Montreal",
  answer: (input) => Ref.update(rig.answered, (all) => [...all, input]).pipe(Effect.andThen(Ref.get(rig.outcome))),
  pairing: rig.pairing,
  failures,
})

const rigOf = (dir: string) =>
  Effect.gen(function* () {
    return {
      written: yield* Ref.make<ReadonlyArray<MarkLine>>([]),
      answered: yield* Ref.make<ReadonlyArray<PageAnswer>>([]),
      clock: yield* Ref.make(NOW),
      pairing: FilePairing.make(dir),
      outcome: yield* Ref.make<AnswerOutcome>(AnswerOutcome.Answered({ replaced: Option.none() })),
    }
  })

/** The listener on a free port for `body`, closed after it; its pairing file beside the built page. */
const withListener = <A>(dist: string, body: (base: string, written: Ref.Ref<ReadonlyArray<MarkLine>>, hostname: string, rig: Rig) => Promise<A>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const rig = yield* rigOf(join(dist, "..", "pairing"))
        const bound = yield* listen(0, handlers(rig, yield* Ref.make<ReadonlyArray<number>>([])), dist)
        return yield* Effect.promise(() => body(`http://${HOSTNAME}:${bound.port}`, rig.written, bound.hostname, rig))
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
        Effect.scoped(Effect.flatMap(Effect.zip(rigOf(join(dist, "..", "pairing")), Ref.make<ReadonlyArray<number>>([])), ([rig, failures]) => listen(port, handlers(rig, failures), dist))).pipe(Effect.provideService(Scope.Scope, Scope.makeUnsafe())),
      )
      expect(second._tag).toBe("Failure")
    })
  })
})

/** The page's own headers on a write, with `cookie` when given. */
const own = (base: string, cookie = "") => ({ origin: base, [PAGE_HEADER]: "1", cookie })

/** Pair through `/api/pair` with a fresh code; the cookie it set, as a request sends it. */
const paired = async (base: string, rig: Rig): Promise<string> => {
  const code = await Effect.runPromise(rig.pairing.issue(await Effect.runPromise(Ref.get(rig.clock))))
  const answer = await post(`${base}/api/pair`, { code }, own(base))
  expect(answer.status).toBe(204)
  const set = String(answer.headers.get("set-cookie"))
  expect(set).toContain("HttpOnly")
  expect(set).toContain("SameSite=Strict")
  return set.split(";")[0] ?? ""
}

describe("who may do what", () => {
  test("one table, by listener and route: on loopback only an answer needs a paired browser; elsewhere all but pairing does", () => {
    const routes: ReadonlyArray<readonly [string, string]> = [
      ["GET", "/"],
      ["GET", "/view.json"],
      ["GET", "/paired.json"],
      ["GET", "/assets/index-abc.js"],
      ["POST", "/api/mark"],
      ["POST", "/api/later"],
      ["POST", "/api/name"],
      ["POST", "/api/since"],
      ["POST", "/api/answer"],
      ["POST", "/api/pair"],
      ["PUT", "/api/answer"],
    ]
    const table = routes.map(([method, path]) => [method, path, ...Option.match(kindOf(method, path), { onNone: () => ["refused", "refused"], onSome: (kind) => [ACCESS.loopback[kind], ACCESS.remote[kind]] })])
    expect(table).toEqual([
      ["GET", "/", "open", "paired"],
      ["GET", "/view.json", "open", "paired"],
      ["GET", "/paired.json", "open", "paired"],
      ["GET", "/assets/index-abc.js", "open", "paired"],
      ["POST", "/api/mark", "open", "paired"],
      ["POST", "/api/later", "open", "paired"],
      ["POST", "/api/name", "open", "paired"],
      ["POST", "/api/since", "open", "paired"],
      ["POST", "/api/answer", "paired", "paired"],
      ["POST", "/api/pair", "open", "open"],
      ["PUT", "/api/answer", "refused", "refused"],
    ])
  })
})

describe("pairing and answering", () => {
  const ANSWER = { id: "question:ses_a:q1", option: "Keep it" }

  test("a paired browser answers; the answer reaches the handler and the page is told it went", async () => {
    using held = scratch("digest-http-")
    await withListener(builtPage(held.path), async (base, _written, _hostname, rig) => {
      expect(await (await fetch(`${base}/paired.json`)).json()).toEqual({ paired: false })
      const cookie = await paired(base, rig)
      expect(await (await fetch(`${base}/paired.json`, { headers: { cookie } })).json()).toEqual({ paired: true })
      const answer = await post(`${base}/api/answer`, ANSWER, own(base, cookie))
      expect([answer.status, await answer.json()]).toEqual([200, { answered: true }])
      expect(await Effect.runPromise(Ref.get(rig.answered))).toEqual([ANSWER])
    })
  })

  test("an answer with no cookie, a forged one, or from another origin is refused and sends nothing", async () => {
    using held = scratch("digest-http-")
    await withListener(builtPage(held.path), async (base, _written, _hostname, rig) => {
      const cookie = await paired(base, rig)
      const forged = `${COOKIE}=v1.AAAAAAAAAAAA.${"B".repeat(43)}`
      const refusals = [
        await post(`${base}/api/answer`, ANSWER, own(base)),
        await post(`${base}/api/answer`, ANSWER, own(base, forged)),
        await post(`${base}/api/answer`, ANSWER, { ...own(base, cookie), origin: "http://evil.example" }),
        await post(`${base}/api/answer`, ANSWER, { origin: base, cookie }),
      ]
      expect(refusals.map((each) => each.status)).toEqual([401, 401, 403, 403])
      expect(await Effect.runPromise(Ref.get(rig.answered))).toEqual([])
    })
  })

  test("a replayed code, a wrong one and an expired one buy no cookie; past the minute's failures every try is refused", async () => {
    using held = scratch("digest-http-")
    await withListener(builtPage(held.path), async (base, _written, _hostname, rig) => {
      const code = await Effect.runPromise(rig.pairing.issue(NOW))
      expect((await post(`${base}/api/pair`, { code }, own(base))).status).toBe(204)
      const replayed = await post(`${base}/api/pair`, { code }, own(base))
      expect([replayed.status, replayed.headers.has("set-cookie")]).toEqual([403, false])
      const late = await Effect.runPromise(rig.pairing.issue(NOW))
      await Effect.runPromise(Ref.set(rig.clock, NOW + CODE_TTL_MS))
      expect((await post(`${base}/api/pair`, { code: late }, own(base))).status).toBe(410)
      // The replay was minutes ago; the expired try is this minute's one failure. Spend the rest, then even a good code is refused.
      for (let left = RATE_FAILURES - 1; left > 0; left -= 1) expect((await post(`${base}/api/pair`, { code: "ABCDEFGHJK" }, own(base))).status).toBe(403)
      const good = await Effect.runPromise(rig.pairing.issue(NOW + CODE_TTL_MS))
      expect((await post(`${base}/api/pair`, { code: good }, own(base))).status).toBe(429)
      // A minute on, it may try again.
      await Effect.runPromise(Ref.set(rig.clock, NOW + CODE_TTL_MS + 60_000))
      expect((await post(`${base}/api/pair`, { code: good }, own(base))).status).toBe(204)
    })
  })

  test("an answer to a question already closed is told who closed it and when; a refused one says why, with its status", async () => {
    using held = scratch("digest-http-")
    await withListener(builtPage(held.path), async (base, _written, _hostname, rig) => {
      const cookie = await paired(base, rig)
      await Effect.runPromise(Ref.set(rig.outcome, AnswerOutcome.AlreadyClosed({ answer: Option.some("Cut it"), via: Option.some("tray"), at: Option.some(NOW - 5) })))
      const closed = await post(`${base}/api/answer`, ANSWER, own(base, cookie))
      expect([closed.status, await closed.json()]).toEqual([409, { answered: false, answer: "Cut it", via: "tray", at: NOW - 5, reason: "already answered" }])
      await Effect.runPromise(Ref.set(rig.outcome, AnswerOutcome.Refused({ status: 413, reason: "an answer is at most 2000 characters" })))
      const long = await post(`${base}/api/answer`, { id: "question:ses_a:q1", text: "x".repeat(2_001) }, own(base, cookie))
      expect([long.status, await long.json()]).toEqual([413, { answered: false, reason: "an answer is at most 2000 characters" }])
      expect((await post(`${base}/api/answer`, { id: "" }, own(base, cookie))).status).toBe(400)
    })
  })
})
