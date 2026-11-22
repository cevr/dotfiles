// The page's listener over a real socket:
// - It binds loopback only, serves the page's built files with their content types and nothing outside them, and
//   answers the view as JSON.
// - It takes a mark, a Later or a rename only as a POST from its own origin with the page's header.
// - An answer needs a paired browser's token in TOKEN_HEADER, which the page keeps in its origin's localStorage.
//   Nothing ambient pairs: no cookie is set, and none is read. Another server on 127.0.0.1 that the browser visits
//   receives nothing it could answer with.
// - Every answer, an error too, carries the CSP.
// - A port another server holds is waited for, never shared.
import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { networkInterfaces } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Match, Option, Ref, Schedule, Scope } from "effect"
import { scratch } from "../../../tests/scratch.ts"
import { AnswerOutcome, type PageAnswer } from "../answers.ts"
import { noTailnet, StatusRead, type Tailnet } from "../bind.ts"
import * as FilePairing from "../filestore/pairing.ts"
import type { TailnetState } from "../health.ts"
import type { MarkLine } from "../marks.ts"
import { CODE_TTL_MS, OLD_COOKIE, type Pairing, SOURCE_FAILURES, TOKEN_HEADER } from "../pairing.ts"
import { keysOf, membersWith } from "../devices.ts"
import * as FileDevices from "../filestore/devices.ts"
import { closed, type Exclusion, type Members, membersOf, sourceOf, type WriteConfig } from "../members.ts"
import { ACCESS, type Listener, type TailnetWrite } from "../policy.ts"
import { statusFrom } from "../process/tailnet.ts"
import { type Handlers, HOSTNAME, kindOf, listen, PAGE_HEADER, type PeerOf, type Place, serveTailnet, socketPeer } from "./listener.ts"

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
const handlers = (rig: Rig): Handlers => ({
  view: Effect.succeed('{"v":1}'),
  peerView: Effect.succeed('{"wire":1}'),
  write: (line) => Ref.update(rig.written, (lines) => [...lines, line]),
  now: Ref.get(rig.clock),
  zone: "America/Montreal",
  answer: (input) => Ref.update(rig.answered, (all) => [...all, input]).pipe(Effect.andThen(Ref.get(rig.outcome))),
  pairing: rig.pairing,
  health: Effect.succeed("digest ok dev host=harbor events=3 last=none peers=none tailnet=no"),
  tailnetRead: "paired",
  members: Effect.succeed(closed("none", NOW)),
})

/** A place on loopback, on a free port: as `listener` (the tailnet listener bound to 127.0.0.1, with invented names). */
const NAMES: Readonly<Record<Listener, ReadonlyArray<string>>> = { loopback: [], tailnet: ["harbor.example-tailnet.ts.net", "harbor"] }
const placeOf = (listener: Listener = "loopback", port = 0): Place => ({ address: HOSTNAME, port, listener, names: NAMES[listener] })

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

/** The listener on a free port for `body`, closed after it; its pairing file beside the built page (`pairing/`). */
/**
 * Where a test's request comes from. The test binds 127.0.0.1 only, so on the tailnet listener a tailnet address
 * stands in for the socket's peer: by default another user's device (the status names it as no device of his).
 */
const ANOTHER_USERS = "100.100.1.1"
const peerOf = (listener: Listener): PeerOf => Match.value(listener).pipe(Match.when("loopback", () => socketPeer), Match.orElse((): PeerOf => () => ANOTHER_USERS))

const withListener = <A>(
  dist: string,
  body: (base: string, written: Ref.Ref<ReadonlyArray<MarkLine>>, hostname: string, rig: Rig) => Promise<A>,
  make: (rig: Rig) => Handlers = handlers,
  listener: Listener = "loopback",
  peer: PeerOf = peerOf(listener),
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const rig = yield* rigOf(join(dist, "..", "pairing"))
        const bound = yield* listen(placeOf(listener), make(rig), dist, peer)
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
      // On loopback the health line is whole, unauthenticated, with the write switch in force and his devices' count.
      expect(await (await fetch(`${base}/health`)).text()).toBe("digest ok dev host=harbor events=3 last=none peers=none tailnet=no writes=paired:none members=0 writers=0 excluded=0")
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
        Effect.scoped(Effect.flatMap(rigOf(join(dist, "..", "pairing")), (rig) => listen(placeOf("loopback", port), handlers(rig), dist))).pipe(Effect.provideService(Scope.Scope, Scope.makeUnsafe())),
      )
      expect(second._tag).toBe("Failure")
    })
  })

  test("every answer carries the CSP (script-src 'self', no inline script, no eval, no other origin), an error and a failure too, and none sets a cookie", async () => {
    using held = scratch("digest-http-")
    // The view's handler dies, as a bug would: the listener still answers 500 with its headers.
    const dying = (rig: Rig): Handlers => ({ ...handlers(rig), view: Effect.die("an invented bug") })
    await withListener(
      builtPage(held.path),
      async (base, _written, _hostname, rig) => {
        const code = await Effect.runPromise(rig.pairing.issue(NOW))
        const own = { origin: base, [PAGE_HEADER]: "1" }
        const answers = [
          await fetch(`${base}/`),
          await fetch(`${base}/assets/index-abc.js`),
          await fetch(`${base}/view.json`),
          await fetch(`${base}/paired.json`),
          await fetch(`${base}/missing`),
          await fetch(`${base}/view.json`, { headers: { host: "evil.example" } }),
          await fetch(`${base}/api/answer`, { method: "PUT" }),
          await post(`${base}/api/answer`, { id: "question:s:q1", option: "Keep it" }, own),
          await post(`${base}/api/mark`, { id: "m1", mark: "read" }, { origin: "http://evil.example", [PAGE_HEADER]: "1" }),
          await post(`${base}/api/pair`, { code }, own),
          await post(`${base}/api/pair`, { code }, own),
        ]
        expect(answers.map((answer) => answer.status)).toEqual([200, 200, 500, 200, 404, 421, 405, 401, 403, 200, 403])
        for (const answer of answers) {
          const csp = String(answer.headers.get("content-security-policy"))
          expect([answer.status, csp.includes("script-src 'self'"), csp.includes("unsafe-inline"), csp.includes("unsafe-eval"), csp.includes("connect-src 'self'"), /https?:/.test(csp)]).toEqual([answer.status, true, false, false, true, false])
          expect(answer.headers.has("set-cookie")).toBe(false)
        }
      },
      dying,
    )
  })
})

/** The page's own headers on a write, with its token when it has one. */
const own = (base: string, token = "") => ({ origin: base, [PAGE_HEADER]: "1", ...Object.fromEntries(Option.toArray(Option.map(Option.liftPredicate(token, (each) => each !== ""), (each) => [TOKEN_HEADER, each] as const))) })

/** Pair through `/api/pair` with a fresh code: the token the body answered, as the page keeps it. */
const paired = async (base: string, rig: Rig): Promise<string> => {
  const code = await Effect.runPromise(rig.pairing.issue(await Effect.runPromise(Ref.get(rig.clock))))
  const answer = await post(`${base}/api/pair`, { code }, own(base))
  expect([answer.status, answer.headers.has("set-cookie"), answer.headers.get("cache-control")]).toEqual([200, false, "no-store"])
  const body: { readonly id: string; readonly token: string } = await answer.json()
  expect(body.token).toStartWith(`v2.${body.id}.`)
  return body.token
}

describe("who may do what", () => {
  test("one table, by listener and route: on loopback only an answer needs a paired browser; on the tailnet all but the shell, pairing and health's ok", () => {
    const routes: ReadonlyArray<readonly [string, string]> = [
      ["GET", "/"],
      ["GET", "/view.json"],
      ["GET", "/paired.json"],
      ["GET", "/health"],
      ["GET", "/assets/index-abc.js"],
      ["POST", "/api/mark"],
      ["POST", "/api/later"],
      ["POST", "/api/name"],
      ["POST", "/api/since"],
      ["POST", "/api/answer"],
      ["POST", "/api/pair"],
      ["PUT", "/api/answer"],
    ]
    const table = routes.map(([method, path]) => [method, path, ...Option.match(kindOf(method, path), { onNone: () => ["refused", "refused"], onSome: (kind) => [ACCESS.loopback[kind], ACCESS.tailnet[kind]] })])
    expect(table).toEqual([
      ["GET", "/", "open", "open"],
      ["GET", "/view.json", "open", "paired"],
      ["GET", "/paired.json", "open", "open"],
      ["GET", "/health", "open", "brief"],
      ["GET", "/assets/index-abc.js", "open", "open"],
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

/**
 * A browser, as far as credentials go: cookies by host alone (RFC 6265 §8.5: a cookie is not port-scoped), and
 * localStorage by origin (scheme, host and port). It visits a URL with whatever it would attach by itself.
 */
const browser = () => {
  const cookies = new Map<string, Array<string>>()
  const storage = new Map<string, Map<string, string>>()
  const storeOf = (origin: string) =>
    Option.getOrElse(Option.fromUndefinedOr(storage.get(origin)), () => {
      const made = new Map<string, string>()
      storage.set(origin, made)
      return made
    })
  return {
    /** What a server's answer leaves in the browser: each Set-Cookie, under the host alone. */
    keep: (url: string, answer: Response) => {
      const host = new URL(url).hostname
      cookies.set(host, [...Option.getOrElse(Option.fromUndefinedOr(cookies.get(host)), () => []), ...answer.headers.getSetCookie()])
    },
    /** The page of `origin` keeps `value` in its localStorage. */
    store: (origin: string, key: string, value: string) => void storeOf(origin).set(key, value),
    /** A top-level visit: the cookies of the host go along; localStorage stays with its own origin's page. */
    visit: (url: string) => fetch(url, { headers: { cookie: Option.getOrElse(Option.fromUndefinedOr(cookies.get(new URL(url).hostname)), () => []).join("; ") } }),
    /** What a script of `origin`'s page can read of localStorage. */
    read: (origin: string, key: string) => Option.fromUndefinedOr(storeOf(origin).get(key)),
  }
}

describe("pairing and answering", () => {
  const ANSWER = { id: "question:ses_a:q1", option: "Keep it" }

  test("a paired browser answers with its token; the answer reaches the handler and the page is told it went", async () => {
    using held = scratch("digest-http-")
    await withListener(builtPage(held.path), async (base, _written, _hostname, rig) => {
      expect(await (await fetch(`${base}/paired.json`)).json()).toEqual({ paired: false, answers: false })
      const token = await paired(base, rig)
      expect(await (await fetch(`${base}/paired.json`, { headers: { [TOKEN_HEADER]: token } })).json()).toEqual({ paired: true, answers: true })
      const answer = await post(`${base}/api/answer`, ANSWER, own(base, token))
      expect([answer.status, await answer.json()]).toEqual([200, { answered: true }])
      expect(await Effect.runPromise(Ref.get(rig.answered))).toEqual([ANSWER])
    })
  })

  test("another server on 127.0.0.1 that the paired browser visits receives nothing it can answer with (round 1's M1)", async () => {
    using held = scratch("digest-http-")
    await withListener(builtPage(held.path), async (base, _written, _hostname, rig) => {
      const visitor = browser()
      // The browser opens the page and pairs it, keeping whatever each answer leaves.
      visitor.keep(base, await visitor.visit(`${base}/`))
      const code = await Effect.runPromise(rig.pairing.issue(NOW))
      const pairing = await post(`${base}/api/pair`, { code }, own(base))
      visitor.keep(base, pairing.clone())
      const { token }: { readonly token: string } = await pairing.json()
      visitor.store(base, "digest.token", token)
      // Another server on another port of 127.0.0.1 (a dev server, a container), logging what reaches it.
      const received = new Array<Readonly<Record<string, string>>>()
      using other = Bun.serve({
        hostname: HOSTNAME,
        port: 0,
        fetch: (request) => {
          received.push(Object.fromEntries(request.headers.entries()))
          return new Response("hello")
        },
      })
      const elsewhere = `http://${HOSTNAME}:${other.port}`
      await visitor.visit(`${elsewhere}/`)
      expect(received).toHaveLength(1)
      const got = received[0] ?? {}
      expect([got["cookie"] ?? "", got[TOKEN_HEADER] ?? ""]).toEqual(["", ""])
      expect(Object.values(got).some((value) => value.includes(token.split(".")[2] ?? token))).toBe(false)
      // Its own page's script reads its own origin's storage: nothing there.
      expect(visitor.read(elsewhere, "digest.token")).toEqual(Option.none())
      // It replays all it got, forging the page's origin and header (a server sets any header): refused, nothing sent.
      const replayed = await post(`${base}/api/answer`, ANSWER, { ...got, host: new URL(base).host, origin: base, [PAGE_HEADER]: "1" })
      expect(replayed.status).toBe(401)
      // A request with round 1's cookie, whatever its value, is not paired either.
      expect((await post(`${base}/api/answer`, ANSWER, { ...own(base), cookie: `${OLD_COOKIE}=v1.AAAAAAAAAAAA.${"B".repeat(43)}` })).status).toBe(401)
      expect((await post(`${base}/api/answer`, ANSWER, { ...own(base), cookie: `${OLD_COOKIE}=${token}` })).status).toBe(401)
      expect(await Effect.runPromise(Ref.get(rig.answered))).toEqual([])
    })
  })

  test("an answer with no token, a forged one, or with a good token from another origin or naming another host is refused and sends nothing", async () => {
    using held = scratch("digest-http-")
    await withListener(builtPage(held.path), async (base, _written, _hostname, rig) => {
      const token = await paired(base, rig)
      const refusals = [
        await post(`${base}/api/answer`, ANSWER, own(base)),
        await post(`${base}/api/answer`, ANSWER, own(base, `v2.AAAAAAAA.${"B".repeat(43)}`)),
        await post(`${base}/api/answer`, ANSWER, own(base, `${token}x`)),
        await post(`${base}/api/answer`, ANSWER, { ...own(base, token), origin: "http://evil.example" }),
        await post(`${base}/api/answer`, ANSWER, { ...own(base, token), origin: `http://127.0.0.1:${Number(new URL(base).port) + 1}` }),
        await post(`${base}/api/answer`, ANSWER, { origin: base, [TOKEN_HEADER]: token }),
        await post(`${base}/api/answer`, ANSWER, { ...own(base, token), host: "evil.example" }),
      ]
      expect(refusals.map((each) => each.status)).toEqual([401, 401, 401, 403, 403, 403, 421])
      expect(await Effect.runPromise(Ref.get(rig.answered))).toEqual([])
    })
  })

  test("a token outlives a restart of the server; a revoked one is refused at once", async () => {
    using held = scratch("digest-http-")
    const dist = builtPage(held.path)
    const token = await withListener(dist, async (base, _written, _hostname, rig) => paired(base, rig))
    await withListener(dist, async (base, _written, _hostname, rig) => {
      expect((await post(`${base}/api/answer`, ANSWER, own(base, token))).status).toBe(200)
      expect(await Effect.runPromise(rig.pairing.revoke("all"))).toBe(1)
      expect((await post(`${base}/api/answer`, ANSWER, own(base, token))).status).toBe(401)
    })
  })

  test("a replayed code, a wrong one and an expired one buy no token; past the minute's failures every try is refused, a burst too", async () => {
    using held = scratch("digest-http-")
    await withListener(builtPage(held.path), async (base, _written, _hostname, rig) => {
      const code = await Effect.runPromise(rig.pairing.issue(NOW))
      expect((await post(`${base}/api/pair`, { code }, own(base))).status).toBe(200)
      const replayed = await post(`${base}/api/pair`, { code }, own(base))
      expect([replayed.status, replayed.headers.has("set-cookie"), (await replayed.text()).includes("token")]).toEqual([403, false, false])
      const late = await Effect.runPromise(rig.pairing.issue(NOW))
      await Effect.runPromise(Ref.set(rig.clock, NOW + CODE_TTL_MS))
      expect((await post(`${base}/api/pair`, { code: late }, own(base))).status).toBe(410)
      // One failure so far this window (the late code; the replay was five minutes ago); a burst of 50 at once gets the rest, then 429s.
      const burst = await Effect.runPromise(Effect.all(Array.from({ length: 50 }, () => Effect.map(Effect.promise(() => post(`${base}/api/pair`, { code: "ABCDEFGHJK" }, own(base))), (answer) => answer.status)), { concurrency: 50 }))
      expect(burst.filter((status) => status === 403)).toHaveLength(SOURCE_FAILURES - 1)
      expect(burst.filter((status) => status === 429)).toHaveLength(50 - (SOURCE_FAILURES - 1))
      const good = await Effect.runPromise(rig.pairing.issue(NOW + CODE_TTL_MS))
      expect((await post(`${base}/api/pair`, { code: good }, own(base))).status).toBe(429)
      // A minute on, it may try again.
      await Effect.runPromise(Ref.set(rig.clock, NOW + CODE_TTL_MS + 60_000))
      expect((await post(`${base}/api/pair`, { code: good }, own(base))).status).toBe(200)
    })
  })

  test("an answer to a question already closed is told who closed it and when; a refused one says why, with its status", async () => {
    using held = scratch("digest-http-")
    await withListener(builtPage(held.path), async (base, _written, _hostname, rig) => {
      const token = await paired(base, rig)
      await Effect.runPromise(Ref.set(rig.outcome, AnswerOutcome.AlreadyClosed({ answer: Option.some("Cut it"), via: Option.some("tray"), at: Option.some(NOW - 5) })))
      const closed = await post(`${base}/api/answer`, ANSWER, own(base, token))
      expect([closed.status, await closed.json()]).toEqual([409, { answered: false, answer: "Cut it", via: "tray", at: NOW - 5, reason: "already answered" }])
      await Effect.runPromise(Ref.set(rig.outcome, AnswerOutcome.Refused({ status: 413, reason: "an answer is at most 2000 characters" })))
      const long = await post(`${base}/api/answer`, { id: "question:ses_a:q1", text: "x".repeat(2_001) }, own(base, token))
      expect([long.status, await long.json()]).toEqual([413, { answered: false, reason: "an answer is at most 2000 characters" }])
      expect((await post(`${base}/api/answer`, { id: "" }, own(base, token))).status).toBe(400)
    })
  })
})

// The tailnet listener. A test never binds the host's real tailnet address: it binds 127.0.0.1 as the tailnet
// listener (its policy and its names), on a free port, with invented names.
describe("the tailnet listener", () => {
  test("an address that is not loopback or the tailnet's is refused before any socket is made: a wildcard, a LAN, a public one", async () => {
    using held = scratch("digest-http-")
    const dist = builtPage(held.path)
    const refused = await Effect.runPromise(
      Effect.forEach(["0.0.0.0", "::", "", "192.168.1.20", "10.0.0.5", "8.8.8.8", "100.128.0.1", "fd7a:115c:a1e1::1", "localhost"], (address) =>
        Effect.scoped(Effect.flatMap(rigOf(join(dist, "..", "pairing")), (rig) => listen({ ...placeOf("tailnet"), address }, handlers(rig), dist))).pipe(
          Effect.match({ onSuccess: () => `${address}: bound`, onFailure: (failure) => `${address}: ${failure._tag}` }),
        ),
      ),
    )
    expect(refused).toEqual(["0.0.0.0", "::", "", "192.168.1.20", "10.0.0.5", "8.8.8.8", "100.128.0.1", "fd7a:115c:a1e1::1", "localhost"].map((address) => `${address}: BindRefused`))
  })

  test("unpaired, it serves the shell (no data), whether paired, the pairing and health's `ok`; the view, a mark and an answer need the token", async () => {
    using held = scratch("digest-http-")
    await withListener(
      builtPage(held.path),
      async (base, written, _hostname, rig) => {
        const unpaired = [
          await fetch(`${base}/`),
          await fetch(`${base}/assets/index-abc.js`),
          await fetch(`${base}/paired.json`),
          await fetch(`${base}/view.json`),
          await fetch(`${base}/anything`),
          await post(`${base}/api/mark`, { id: "m1", mark: "read" }, own(base)),
          await post(`${base}/api/answer`, { id: "question:s:q1", option: "Keep it" }, own(base)),
        ]
        expect(unpaired.map((each) => each.status)).toEqual([200, 200, 200, 401, 401, 401, 401])
        const health = await fetch(`${base}/health`)
        expect([health.status, await health.text(), health.headers.get("cache-control"), String(health.headers.get("content-security-policy")).includes("default-src 'self'")]).toEqual([200, "ok", "no-store", true])
        const refusal = await (await fetch(`${base}/view.json`)).text()
        expect([refusal.includes("pair.ts"), refusal.includes('"v"')]).toEqual([true, false])
        // Paired: the view, the whole health line, a mark.
        const token = await paired(base, rig)
        expect(await (await fetch(`${base}/view.json`, { headers: { [TOKEN_HEADER]: token } })).text()).toBe('{"v":1}')
        expect(await (await fetch(`${base}/health`, { headers: { [TOKEN_HEADER]: token } })).text()).toStartWith("digest ok dev host=harbor events=3")
        expect((await post(`${base}/api/mark`, { id: "m1", mark: "read" }, own(base, token))).status).toBe(204)
        expect((await Effect.runPromise(Ref.get(written))).length).toBe(1)
      },
      handlers,
      "tailnet",
    )
  })

  test("it answers its own names only (a loopback name and a rebound one are refused on every route), and each name is its own origin", async () => {
    using held = scratch("digest-http-")
    await withListener(
      builtPage(held.path),
      async (base, written, _hostname, rig) => {
        const port = new URL(base).port
        const statusAt = async (host: string, path: string) => (await fetch(`${base}${path}`, { headers: { host } })).status
        for (const path of ["/", "/assets/index-abc.js", "/paired.json", "/health", "/view.json"]) {
          expect([path, await statusAt(`localhost:${port}`, path), await statusAt(`evil.example:${port}`, path), await statusAt(`harbor:${port}`, path), await statusAt(`harbor.example-tailnet.ts.net:${port}`, path)]).toEqual([path, 421, 421, [200, 401][Number(path === "/view.json")], [200, 401][Number(path === "/view.json")]])
        }
        // A write naming one of its names must come from that name's origin: the page opened by IP is not the page opened by name.
        const token = await paired(base, rig)
        const byName = await post(`${base}/api/mark`, { id: "m1", mark: "read" }, { ...own(base, token), host: `harbor:${port}`, origin: `http://harbor:${port}` })
        const crossed = await post(`${base}/api/mark`, { id: "m1", mark: "read" }, { ...own(base, token), origin: `http://harbor:${port}` })
        expect([byName.status, crossed.status]).toEqual([204, 403])
        expect((await Effect.runPromise(Ref.get(written))).length).toBe(1)
      },
      handlers,
      "tailnet",
    )
  })

  test(`digest.tailnetRead "member" opens the tailnet's reads to his own devices; marks and answers still need the token under tailnetWrite "paired"`, async () => {
    using held = scratch("digest-http-")
    await withListener(
      builtPage(held.path),
      async (base, written, _hostname, rig) => {
        const port = new URL(base).port
        // Every read, with no token: the shell, whether paired, the view (by IP and by each name), and health's `ok`.
        const reads = [
          await fetch(`${base}/`),
          await fetch(`${base}/assets/index-abc.js`),
          await fetch(`${base}/paired.json`),
          await fetch(`${base}/view.json`),
          await fetch(`${base}/view.json`, { headers: { host: `harbor:${port}` } }),
          await fetch(`${base}/view.json`, { headers: { host: `harbor.example-tailnet.ts.net:${port}` } }),
        ]
        expect(reads.map((each) => each.status)).toEqual([200, 200, 200, 200, 200, 200])
        expect(await (await fetch(`${base}/view.json`)).text()).toBe('{"v":1}')
        expect(await (await fetch(`${base}/paired.json`)).text()).toBe('{"paired":false,"answers":false}')
        expect(await (await fetch(`${base}/health`)).text()).toBe("ok")
        // Every write, with no token, from the page's own origin with its header: refused, and nothing written or sent.
        const writes = [
          await post(`${base}/api/mark`, { id: "m1", mark: "read" }, own(base)),
          await post(`${base}/api/later`, { id: "m2" }, own(base)),
          await post(`${base}/api/name`, { project: "harbor", name: "Harbor Lights" }, own(base)),
          await post(`${base}/api/since`, {}, own(base)),
          await post(`${base}/api/answer`, { id: "question:s:q1", option: "Keep it" }, own(base)),
        ]
        expect(writes.map((each) => each.status)).toEqual([401, 401, 401, 401, 401])
        // Pairing: a code it did not issue earns no token; only `bun cmd/digest/pair.ts` on the host issues one.
        const guessed = await post(`${base}/api/pair`, { code: "ABCDEFGHJK" }, own(base))
        expect([guessed.status === 200, (await guessed.text()).includes("token")]).toEqual([false, false])
        expect([await Effect.runPromise(Ref.get(written)), await Effect.runPromise(Ref.get(rig.answered))]).toEqual([[], []])
        // Host and Origin hold as with "paired": another name reads nothing, a write from another origin is refused.
        expect([(await fetch(`${base}/view.json`, { headers: { host: `evil.example:${port}` } })).status, (await fetch(`${base}/view.json`, { headers: { host: `localhost:${port}` } })).status]).toEqual([421, 421])
        const token = await paired(base, rig)
        expect((await post(`${base}/api/mark`, { id: "m1", mark: "read" }, { ...own(base, token), origin: "http://evil.example" })).status).toBe(403)
        // Paired, the writes go and the health line is whole.
        expect((await post(`${base}/api/mark`, { id: "m1", mark: "read" }, own(base, token))).status).toBe(204)
        expect((await post(`${base}/api/answer`, { id: "question:s:q1", option: "Keep it" }, own(base, token))).status).toBe(200)
        expect(await (await fetch(`${base}/health`, { headers: { [TOKEN_HEADER]: token } })).text()).toStartWith("digest ok dev host=harbor")
        expect([(await Effect.runPromise(Ref.get(written))).length, (await Effect.runPromise(Ref.get(rig.answered))).length]).toEqual([1, 1])
        // Another user's device on the same tailnet reads nothing unpaired: "member" is his own devices only.
        expect([(await fetch(`${base}/view.json`, { headers: { [PEER_HEADER]: "100.101.102.120" } })).status, (await fetch(`${base}/view.json`, { headers: { [PEER_HEADER]: ANOTHER_USERS } })).status]).toEqual([401, 401])
      },
      // His phone, under tailnetRead "member" with writes at their default ("paired").
      (rig) => ({ ...handlers(rig), tailnetRead: "member", members: Effect.succeed(his("paired")) }),
      "tailnet",
      (request) => Option.getOrElse(Option.fromNullishOr(request.headers.get(PEER_HEADER)), () => PHONE[0] ?? ""),
    )
  })

  test("it follows the tailnet: listens when an address appears, stops when it goes (saying why), waits while another instance holds it (all: held, some: partial), and takes it over", async () => {
    using held = scratch("digest-http-")
    const dist = builtPage(held.path)
    // A free scratch port, on 127.0.0.1 standing in for the tailnet address.
    const free = Bun.serve({ hostname: HOSTNAME, port: 0, fetch: () => new Response("") })
    const port = Number(free.port)
    free.stop(true)
    const tailnet: Tailnet = { addresses: [HOSTNAME], names: ["harbor"], why: "" }
    // Two addresses (::1 standing in for the IPv6 one), for a partial hold.
    const both: Tailnet = { ...tailnet, addresses: [HOSTNAME, "::1"] }
    const reach = () =>
      Effect.runPromise(Effect.match(Effect.tryPromise(() => fetch(`http://${HOSTNAME}:${port}/`, { headers: { host: `harbor:${port}` } })), { onSuccess: (answer) => answer.status, onFailure: () => 0 }))
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const rig = yield* rigOf(join(dist, "..", "pairing"))
          const found = yield* Ref.make(noTailnet("no-address"))
          // Not what a first round finds, so its first answer shows.
          const state = yield* Ref.make<TailnetState>("held")
          const until = (wanted: TailnetState) => Ref.get(state).pipe(Effect.repeat({ until: (now) => now === wanted, schedule: Schedule.spaced(Duration.millis(10)) }), Effect.timeout(Duration.seconds(5)))
          yield* Effect.forkScoped(serveTailnet(port, handlers(rig), dist, Ref.get(found), state, Duration.millis(30), peerOf("tailnet")))
          // No tailnet: loopback only, nothing on the port, and health says why.
          yield* until("no:no-address")
          expect(yield* Effect.promise(reach)).toBe(0)
          // Tailscale comes up.
          yield* Ref.set(found, tailnet)
          yield* until("yes")
          expect(yield* Effect.promise(reach)).toBe(200)
          // It goes down: the listener stops.
          yield* Ref.set(found, noTailnet("not-running:Stopped"))
          yield* until("no:not-running:Stopped")
          expect(yield* Effect.promise(reach)).toBe(0)
          // Another instance holds the port when it comes back: this one waits, and health says so.
          const other = Bun.serve({ hostname: HOSTNAME, port, reusePort: false, fetch: () => new Response("the other instance") })
          yield* Ref.set(found, tailnet)
          yield* until("held")
          expect(yield* Effect.promise(async () => (await fetch(`http://${HOSTNAME}:${port}/`)).text())).toBe("the other instance")
          // Both addresses found, and the other instance holds one: this one serves the other, and health says partial.
          yield* Ref.set(found, both)
          yield* until("partial")
          // The other one stops (a restart's handover): this one takes the port.
          other.stop(true)
          yield* until("yes")
          expect(yield* Effect.promise(reach)).toBe(200)
        }),
      ),
    )
    // Its scope closed: nothing listens.
    expect(await reach()).toBe(0)
  })
})

// His devices write with no token (`digest.tailnetWrite`), through the real handlers. The tailnet listener is bound
// to 127.0.0.1; the test stands each source address in for the socket's peer through `listen`'s seam, from its own
// header X-Test-Peer (the listener never reads a header for it: the seam is the test's). Invented tailnet: this host
// (harbor, user 7), the agent host skiff (user 7), his phone (user 7), a colleague's laptop (user 9).
const HIS_TAILNET = StatusRead.Read({
  status: {
    backendState: "Running",
    dnsName: Option.some("harbor.example-tailnet.ts.net"),
    ips: ["100.101.102.103", "fd7a:115c:a1e0::42"],
    userId: Option.some(7),
    tagged: false,
    peers: [
      { dnsName: Option.some("skiff.example-tailnet.ts.net"), stableId: Option.none(), os: "", lastSeen: Option.none(), hostName: "skiff", ips: ["100.101.102.104", "fd7a:115c:a1e0::44"], userId: Option.some(7), tagged: false, shared: false },
      { dnsName: Option.some("phone.example-tailnet.ts.net"), stableId: Option.none(), os: "", lastSeen: Option.none(), hostName: "localhost", ips: ["100.101.102.110", "fd7a:115c:a1e0::110"], userId: Option.some(7), tagged: false, shared: false },
      { dnsName: Option.some("laptop.example-tailnet.ts.net"), stableId: Option.none(), os: "", lastSeen: Option.none(), hostName: "laptop", ips: ["100.101.102.120"], userId: Option.some(9), tagged: false, shared: false },
    ],
  },
})
const PEER_HEADER = "x-test-peer"
const fromHeader: PeerOf = (request) => Option.getOrElse(Option.fromNullishOr(request.headers.get(PEER_HEADER)), () => ANOTHER_USERS)
const his = (tailnetWrite: TailnetWrite, agentHosts: ReadonlyArray<string> = ["skiff"]): Members => membersOf({ tailnetWrite, agentHosts, excluded: [] }, HIS_TAILNET, NOW)
const PHONE = ["100.101.102.110", "::ffff:100.101.102.110", "fd7a:115c:a1e0::110", "FD7A:115C:A1E0:0:0:0:0:110"]
const AGENTS = ["100.101.102.103", "::ffff:100.101.102.103", "fd7a:115c:a1e0::42", "100.101.102.104", "::ffff:100.101.102.104", "fd7a:115c:a1e0:0:0:0:0:44"]

describe("his devices write without pairing; agent machines and everyone else do not", () => {
  const ANSWER = { id: "question:s:q1", option: "Keep it" }
  const member = (tailnetWrite: TailnetWrite) => (rig: Rig): Handlers => ({ ...handlers(rig), tailnetRead: "member", members: Effect.succeed(his(tailnetWrite)) })
  /** Each write route, from `from`, with the page's own headers (and `token`): its statuses. */
  const writes = async (base: string, from: string, token = "") => {
    const headers = { ...own(base, token), [PEER_HEADER]: from }
    return [
      (await post(`${base}/api/mark`, { id: "m1", mark: "read" }, headers)).status,
      (await post(`${base}/api/later`, { id: "m2" }, headers)).status,
      (await post(`${base}/api/name`, { project: "harbor", name: "Harbor Lights" }, headers)).status,
      (await post(`${base}/api/since`, {}, headers)).status,
      (await post(`${base}/api/answer`, ANSWER, headers)).status,
    ]
  }
  const pairedJson = async (base: string, from: string, token = "") => (await fetch(`${base}/paired.json`, { headers: { [PEER_HEADER]: from, ...Object.fromEntries(Option.toArray(Option.map(Option.liftPredicate(token, (each) => each !== ""), (each) => [TOKEN_HEADER, each] as const))) } })).json()

  test("member-except-hosts: his phone (every spelling) marks and answers with no token; this host and the agent host need the token; a colleague reads and writes nothing", async () => {
    using held = scratch("digest-http-")
    await withListener(
      builtPage(held.path),
      async (base, written, _hostname, rig) => {
        for (const from of PHONE) {
          expect([from, await writes(base, from)]).toEqual([from, [204, 204, 204, 204, 200]])
          expect([from, await pairedJson(base, from)]).toEqual([from, { paired: false, answers: true }])
          expect([from, (await fetch(`${base}/view.json`, { headers: { [PEER_HEADER]: from } })).status]).toEqual([from, 200])
        }
        expect([(await Effect.runPromise(Ref.get(written))).length, (await Effect.runPromise(Ref.get(rig.answered))).length]).toEqual([4 * PHONE.length, PHONE.length])
        // An agent machine: reads (his device), but marks and answers only with the token, as today.
        const token = await paired(base, rig)
        for (const from of AGENTS) {
          expect([from, await writes(base, from)]).toEqual([from, [401, 401, 401, 401, 401]])
          expect([from, await writes(base, from, `${token}x`)]).toEqual([from, [401, 401, 401, 401, 401]])
          expect([from, await pairedJson(base, from)]).toEqual([from, { paired: false, answers: false }])
          expect([from, (await fetch(`${base}/view.json`, { headers: { [PEER_HEADER]: from } })).status]).toEqual([from, 200])
          expect([from, await writes(base, from, token)]).toEqual([from, [204, 204, 204, 204, 200]])
          expect([from, await pairedJson(base, from, token)]).toEqual([from, { paired: true, answers: true }])
        }
        // Another user's device, and an address the status does not name: nothing without the token.
        for (const from of ["100.101.102.120", "::ffff:100.101.102.120", "100.127.0.9"]) {
          expect([from, await writes(base, from)]).toEqual([from, [401, 401, 401, 401, 401]])
          expect([from, (await fetch(`${base}/view.json`, { headers: { [PEER_HEADER]: from } })).status, await (await fetch(`${base}/health`, { headers: { [PEER_HEADER]: from } })).text()]).toEqual([from, 401, "ok"])
        }
        // A source outside Tailscale's ranges (the bind makes it impossible): refused on every route, the shell too.
        for (const from of ["192.168.1.5", "127.0.0.1", "::1", "unknown"]) {
          expect([from, (await fetch(`${base}/`, { headers: { [PEER_HEADER]: from } })).status, (await fetch(`${base}/paired.json`, { headers: { [PEER_HEADER]: from } })).status, await writes(base, from, token)]).toEqual([from, 403, 403, [403, 403, 403, 403, 403]])
        }
      },
      member("member-except-hosts"),
      "tailnet",
      fromHeader,
    )
  })

  test("member: the agent machines write too; paired: nobody does without the token; an unresolved agent host closes member-except-hosts to paired", async () => {
    using held = scratch("digest-http-")
    const dist = builtPage(held.path)
    await withListener(dist, async (base) => {
      for (const from of [...AGENTS, ...PHONE]) expect([from, await writes(base, from)]).toEqual([from, [204, 204, 204, 204, 200]])
      expect(await writes(base, "100.101.102.120")).toEqual([401, 401, 401, 401, 401])
    }, member("member"), "tailnet", fromHeader)
    await withListener(dist, async (base) => {
      for (const from of [...AGENTS, ...PHONE, "100.101.102.120"]) expect([from, await writes(base, from)]).toEqual([from, [401, 401, 401, 401, 401]])
    }, member("paired"), "tailnet", fromHeader)
    await withListener(dist, async (base) => {
      for (const from of PHONE) expect([from, await writes(base, from)]).toEqual([from, [401, 401, 401, 401, 401]])
    }, (rig) => ({ ...member("member-except-hosts")(rig), members: Effect.succeed(his("member-except-hosts", ["skiff", "dinghy"])) }), "tailnet", fromHeader)
    // Members older than their lifetime count for nothing: his phone needs the token again.
    await withListener(dist, async (base, _written, _hostname, rig) => {
      await Effect.runPromise(Ref.set(rig.clock, NOW + 76_000))
      expect(await writes(base, PHONE[0] ?? "")).toEqual([401, 401, 401, 401, 401])
    }, member("member-except-hosts"), "tailnet", fromHeader)
  })

  test("with no token on the tailnet, the Origin and page header are the only guard, and they hold: a form, text/plain, a preflight, no Origin, Origin null, another site's", async () => {
    using held = scratch("digest-http-")
    await withListener(
      builtPage(held.path),
      async (base, written, _hostname, rig) => {
        const from = PHONE[0] ?? ""
        const mark = JSON.stringify({ id: "m1", mark: "read" })
        const send = (path: string, init: { readonly body: string; readonly headers: Record<string, string> }) => fetch(`${base}${path}`, { method: "POST", body: init.body, headers: { [PEER_HEADER]: from, ...init.headers } })
        const attacks = [
          // A form on another site posting to the page (no preflight: a simple request).
          await send("/api/mark", { body: "id=m1&mark=read", headers: { origin: "http://evil.example", "content-type": "application/x-www-form-urlencoded" } }),
          await send("/api/answer", { body: "id=question%3As%3Aq1&option=Keep+it", headers: { origin: "http://evil.example", "content-type": "application/x-www-form-urlencoded" } }),
          // A fetch with a text/plain JSON body (no preflight).
          await send("/api/mark", { body: mark, headers: { origin: "http://evil.example", "content-type": "text/plain" } }),
          await send("/api/answer", { body: JSON.stringify(ANSWER), headers: { origin: "http://evil.example", "content-type": "text/plain;charset=UTF-8" } }),
          // What a browser sends after a preflight it would not get: the page's header and JSON, from another origin.
          await send("/api/mark", { body: mark, headers: { origin: "http://evil.example", [PAGE_HEADER]: "1", "content-type": "application/json" } }),
          // Another of his own names' origin, or another port of the same address.
          await send("/api/mark", { body: mark, headers: { origin: `http://harbor:${new URL(base).port}`, [PAGE_HEADER]: "1", "content-type": "application/json" } }),
          await send("/api/mark", { body: mark, headers: { origin: `http://127.0.0.1:${Number(new URL(base).port) + 1}`, [PAGE_HEADER]: "1", "content-type": "application/json" } }),
          // No Origin; Origin null (a sandboxed frame, a data: page, a redirect).
          await send("/api/mark", { body: mark, headers: { [PAGE_HEADER]: "1", "content-type": "application/json" } }),
          await send("/api/answer", { body: JSON.stringify(ANSWER), headers: { origin: "null", [PAGE_HEADER]: "1", "content-type": "application/json" } }),
          // The page's own origin without its header, or with a body that is not JSON.
          await send("/api/mark", { body: mark, headers: { origin: base, "content-type": "application/json" } }),
          await send("/api/mark", { body: mark, headers: { origin: base, [PAGE_HEADER]: "1", "content-type": "text/plain" } }),
          // A rebound name: the right Origin for the Host it names, but a Host that is not one of the listener's.
          await send("/api/mark", { body: mark, headers: { host: "evil.example", origin: "http://evil.example", [PAGE_HEADER]: "1", "content-type": "application/json" } }),
        ]
        expect(attacks.map((each) => each.status)).toEqual([403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 415, 421])
        // The preflight is not answered with any CORS grant, so a browser never sends the request it guards.
        const preflight = await fetch(`${base}/api/mark`, { method: "OPTIONS", headers: { [PEER_HEADER]: from, origin: "http://evil.example", "access-control-request-method": "POST", "access-control-request-headers": `${PAGE_HEADER},content-type` } })
        expect([preflight.status, [...preflight.headers.keys()].filter((key) => key.startsWith("access-control-"))]).toEqual([405, []])
        // A GET changes nothing, whatever it names.
        expect((await fetch(`${base}/api/mark?id=m1&mark=read`, { headers: { [PEER_HEADER]: from } })).status).toBe(405)
        expect([await Effect.runPromise(Ref.get(written)), await Effect.runPromise(Ref.get(rig.answered))]).toEqual([[], []])
      },
      member("member-except-hosts"),
      "tailnet",
      fromHeader,
    )
  })

  test("the source is the socket's peer, never a header: X-Forwarded-For, Forwarded or X-Real-IP naming his phone change nothing", async () => {
    using held = scratch("digest-http-")
    const forged = { "x-forwarded-for": PHONE[0] ?? "", forwarded: `for=${PHONE[0] ?? ""}`, "x-real-ip": PHONE[0] ?? "" }
    // From this host (an agent machine), naming the phone in every forwarding header: still needs the token.
    await withListener(builtPage(held.path), async (base, written) => {
      expect((await post(`${base}/api/mark`, { id: "m1", mark: "read" }, { ...own(base), ...forged, [PEER_HEADER]: "100.101.102.103" })).status).toBe(401)
      expect(await Effect.runPromise(Ref.get(written))).toEqual([])
    }, member("member-except-hosts"), "tailnet", fromHeader)
    // The listener's own peer (the real socket, 127.0.0.1 here) on the tailnet listener: outside the tailnet, refused, headers or not.
    await withListener(builtPage(held.path), async (base, written) => {
      expect([(await fetch(`${base}/`, { headers: forged })).status, (await post(`${base}/api/mark`, { id: "m1", mark: "read" }, { ...own(base), ...forged })).status]).toEqual([403, 403])
      expect(await Effect.runPromise(Ref.get(written))).toEqual([])
    }, member("member-except-hosts"), "tailnet", socketPeer)
  })

  test("loopback is unchanged under every switch (marks open, an answer paired), and only there does health name the switch and count his devices", async () => {
    using held = scratch("digest-http-")
    const dist = builtPage(held.path)
    await withListener(dist, async (base) => {
      expect((await post(`${base}/api/mark`, { id: "m1", mark: "read" }, own(base))).status).toBe(204)
      expect((await post(`${base}/api/answer`, ANSWER, own(base))).status).toBe(401)
      expect(await (await fetch(`${base}/paired.json`)).json()).toEqual({ paired: false, answers: false })
      expect(await (await fetch(`${base}/health`)).text()).toEndWith(" tailnet=no writes=member-except-hosts members=2 writers=1 excluded=0")
    }, member("member-except-hosts"))
    await withListener(dist, async (base, _written, _hostname, rig) => {
      const token = await paired(base, rig)
      const line = await (await fetch(`${base}/health`, { headers: { [TOKEN_HEADER]: token, [PEER_HEADER]: PHONE[0] ?? "" } })).text()
      expect([line.startsWith("digest ok "), line.includes("writes="), line.includes("members=")]).toEqual([true, false, false])
    }, member("member-except-hosts"), "tailnet", fromHeader)
  })
})


// ── The verifier's four cases (round 1, B1), through the real listener ──

// This host harbor (user 7); his workbox "skiff" (user 7); a colleague's devbox (user 9) that calls itself "skiff"
// (Tailscale gives it the MagicDNS name skiff-1; its HostName is what the device says).
const colleagueTailnet = (colleagueHostName: string, withOwnSkiff = true) =>
  StatusRead.Read({
    status: {
      backendState: "Running",
      dnsName: Option.some("harbor.example-tailnet.ts.net"),
      ips: ["100.101.102.103"],
      userId: Option.some(7),
      tagged: false,
      peers: [
        ...[{ dnsName: Option.some("skiff.example-tailnet.ts.net"), stableId: Option.none(), os: "", lastSeen: Option.none(), hostName: "skiff", ips: ["100.101.102.104"], userId: Option.some(7), tagged: false, shared: false }].filter(() => withOwnSkiff),
        { dnsName: Option.some("skiff-1.example-tailnet.ts.net"), stableId: Option.none(), os: "", lastSeen: Option.none(), hostName: colleagueHostName, ips: ["100.101.102.120"], userId: Option.some(9), tagged: false, shared: false },
      ],
    },
  })
const COLLEAGUE = "100.101.102.120"

/** A served page: its base URL, how many marks and answers reached the handlers, and a paired token. */
interface Served {
  readonly base: string
  readonly written: () => Promise<number>
  readonly pair: () => Promise<string>
}

/** The real listener on a scratch loopback port, the source injected at its `peerOf` seam. */
const serveAs = async (setup: { readonly config: WriteConfig; readonly status: StatusRead; readonly peer: string; readonly listener: "tailnet" | "loopback"; readonly members?: Members }, body: (served: Served) => Promise<void>) => {
  using held = scratch("digest-agenthost-")
  return await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const written = yield* Ref.make<ReadonlyArray<MarkLine>>([])
        const answered = yield* Ref.make<ReadonlyArray<PageAnswer>>([])
        const pairing = FilePairing.make(join(held.path, "pairing"))
        const handlers: Handlers = {
          view: Effect.succeed('{"secret":"his digest"}'),
          peerView: Effect.succeed('{"wire":1}'),
          write: (line) => Ref.update(written, (all) => [...all, line]),
          now: Effect.succeed(NOW),
          zone: "America/Montreal",
          answer: (input) => Ref.update(answered, (all) => [...all, input]).pipe(Effect.as(AnswerOutcome.Answered({ replaced: Option.none() }))),
          pairing,
          health: Effect.succeed("digest ok dev host=harbor events=3 last=none peers=none tailnet=yes"),
          tailnetRead: "member",
          members: Effect.succeed(Option.getOrElse(Option.fromUndefinedOr(setup.members), () => membersOf(setup.config, setup.status, NOW))),
        }
        const peer: PeerOf = () => setup.peer
        const bound = yield* listen({ address: HOSTNAME, port: 0, listener: setup.listener, names: ["harbor"] }, handlers, join(held.path, "dist"), peer)
        const base = `http://${HOSTNAME}:${bound.port}`
        const count = async () => (await Effect.runPromise(Ref.get(written))).length + (await Effect.runPromise(Ref.get(answered))).length
        const pair = async () => {
          const code = await Effect.runPromise(pairing.issue(NOW))
          const answer = await fetch(`${base}/api/pair`, { method: "POST", body: JSON.stringify({ code }), headers: { origin: base, [PAGE_HEADER]: "1", "content-type": "application/json" } })
          const got: { readonly token: string } = await answer.json()
          return got.token
        }
        return yield* Effect.promise(() => body({ base, written: count, pair }))
      }),
    ),
  )
}

const runAs = (tailnetWrite: TailnetWrite, agentHosts: ReadonlyArray<string>, status: StatusRead, body: (base: string, written: () => Promise<number>) => Promise<void>) =>
  serveAs({ config: { tailnetWrite, agentHosts, excluded: [] }, status, peer: COLLEAGUE, listener: "tailnet" }, (served) => body(served.base, served.written))

const markFrom = (base: string) => fetch(`${base}/api/mark`, { method: "POST", body: JSON.stringify({ id: "m1", mark: "read" }), headers: { origin: base, [PAGE_HEADER]: "1", "content-type": "application/json" } })

describe("a colleague's device that calls itself like an agent host (round 1, B1)", () => {
  test("(a) as an address the installer could have shipped while the colleague answered to the name, it opens nothing after the rename", async () => {
    // An address entry of another user's device is no agent host of his.
    await runAs("member-except-hosts", ["100.101.102.104", COLLEAGUE], colleagueTailnet("devbox"), async (base) => {
      expect((await fetch(`${base}/view.json`)).status).toBe(401)
    })
  })

  test("(b) by name, the shipped switches: it reads nothing with no token", async () => {
    await runAs("member-except-hosts", ["skiff"], colleagueTailnet("skiff"), async (base) => {
      const view = await fetch(`${base}/view.json`)
      expect([view.status, (await view.text()).includes("his digest")]).toEqual([401, false])
    })
    expect(Match.value(sourceOf(COLLEAGUE, membersOf({ tailnetWrite: "member-except-hosts", agentHosts: ["skiff"], excluded: [] }, colleagueTailnet("skiff"), NOW))).pipe(Match.orElse((each) => each))).toBe("other")
  })

  test("(c) under tailnetWrite member: its mark is refused and nothing is stored", async () => {
    await runAs("member", ["skiff"], colleagueTailnet("skiff"), async (base, written) => {
      expect([(await markFrom(base)).status, await written()]).toEqual([401, 0])
    })
  })

  test("(d) his own workbox missing from the status: the writes close as unresolved, whatever the colleague's device is called", () => {
    const members = membersOf({ tailnetWrite: "member-except-hosts", agentHosts: ["skiff"], excluded: [] }, colleagueTailnet("skiff", false), NOW)
    expect([members.write, members.why, sourceOf(COLLEAGUE, members)]).toEqual(["paired", "unresolved:skiff", "other"])
  })
})

// ── An excluded device of his (digest.excludedDevices), through the real listener ──

// This host harbor; his phone; his workbox skiff (an agent host); his spare laptop dinghy, excluded by its stable ID.
const DINGHY = "100.101.102.130"
const OWN_PHONE = "100.101.102.110"
const EXCLUDED: ReadonlyArray<Exclusion> = [{ name: "dinghy", ids: ["nDinghy1CNTRL"] }]
const withDinghy = (dinghy: { readonly dnsName: string; readonly id: string }) =>
  StatusRead.Read({
    status: {
      backendState: "Running",
      dnsName: Option.some("harbor.example-tailnet.ts.net"),
      ips: ["100.101.102.103"],
      userId: Option.some(7),
      tagged: false,
      peers: [
        { dnsName: Option.some("phone.example-tailnet.ts.net"), stableId: Option.some("nPhone1CNTRL"), os: "", lastSeen: Option.none(), hostName: "localhost", ips: [OWN_PHONE], userId: Option.some(7), tagged: false, shared: false },
        { dnsName: Option.some("skiff.example-tailnet.ts.net"), stableId: Option.some("nSkiff1CNTRL"), os: "", lastSeen: Option.none(), hostName: "skiff", ips: ["100.101.102.104"], userId: Option.some(7), tagged: false, shared: false },
        { dnsName: Option.some(`${dinghy.dnsName}.example-tailnet.ts.net`), stableId: Option.some(dinghy.id), os: "", lastSeen: Option.none(), hostName: dinghy.dnsName, ips: [DINGHY], userId: Option.some(7), tagged: false, shared: false },
      ],
    },
  })
const AS_SHIPPED = { tailnetWrite: "member-except-hosts", agentHosts: ["skiff"], excluded: EXCLUDED } as const
const AN_ANSWER = { id: "question:s:q1", option: "Keep it" }
const send = (served: Served, path: string, body: Readonly<Record<string, string>>, token = "") =>
  fetch(`${served.base}${path}`, { method: "POST", body: JSON.stringify(body), headers: { origin: served.base, [PAGE_HEADER]: "1", "content-type": "application/json", ...Object.fromEntries([[TOKEN_HEADER, token]].filter(() => token !== "")) } })

describe("an excluded device of his gets nothing unpaired, as another user's device", () => {
  test("with no token it reads 401, marks 401 and answers 401, and nothing is stored; paired, it reads, marks and answers", async () => {
    await serveAs({ config: AS_SHIPPED, status: withDinghy({ dnsName: "dinghy", id: "nDinghy1CNTRL" }), peer: DINGHY, listener: "tailnet" }, async (served) => {
      const view = await fetch(`${served.base}/view.json`)
      expect([view.status, (await view.text()).includes("his digest")]).toEqual([401, false])
      expect([(await send(served, "/api/mark", { id: "m1", mark: "read" })).status, (await send(served, "/api/answer", AN_ANSWER)).status, await served.written()]).toEqual([401, 401, 0])
      expect(await (await fetch(`${served.base}/paired.json`)).json()).toEqual({ paired: false, answers: false })
      const token = await served.pair()
      expect([(await fetch(`${served.base}/view.json`, { headers: { [TOKEN_HEADER]: token } })).status, (await send(served, "/api/mark", { id: "m1", mark: "read" }, token)).status, (await send(served, "/api/answer", AN_ANSWER, token)).status, await served.written()]).toEqual([200, 204, 200, 2])
    })
  })

  test("renamed (a new MagicDNS name, the same stable ID), it stays out; his phone still marks unpaired", async () => {
    await serveAs({ config: AS_SHIPPED, status: withDinghy({ dnsName: "lifeboat", id: "nDinghy1CNTRL" }), peer: DINGHY, listener: "tailnet" }, async (served) => {
      expect([(await fetch(`${served.base}/view.json`)).status, (await send(served, "/api/mark", { id: "m1", mark: "read" })).status]).toEqual([401, 401])
    })
    await serveAs({ config: AS_SHIPPED, status: withDinghy({ dnsName: "lifeboat", id: "nDinghy1CNTRL" }), peer: OWN_PHONE, listener: "tailnet" }, async (served) => {
      expect([(await fetch(`${served.base}/view.json`)).status, (await send(served, "/api/mark", { id: "m1", mark: "read" })).status]).toEqual([200, 204])
    })
  })

  test("re-keyed (a new stable ID, the same name), it stays out by name, and health says its ID matches no device of his", async () => {
    await serveAs({ config: AS_SHIPPED, status: withDinghy({ dnsName: "dinghy", id: "nDinghy2CNTRL" }), peer: DINGHY, listener: "tailnet" }, async (served) => {
      expect((await fetch(`${served.base}/view.json`)).status).toBe(401)
    })
    expect(membersOf(AS_SHIPPED, withDinghy({ dnsName: "dinghy", id: "nDinghy2CNTRL" }), NOW).excluded).toBe("1:unmatched:dinghy")
  })

  test("on loopback health counts his devices without it, and those that write as him unpaired (the phone alone); an exclusion that finds nothing is named", async () => {
    await serveAs({ config: AS_SHIPPED, status: withDinghy({ dnsName: "dinghy", id: "nDinghy1CNTRL" }), peer: "127.0.0.1", listener: "loopback" }, async (served) => {
      expect(await (await fetch(`${served.base}/health`)).text()).toEndWith(" writes=member-except-hosts members=2 writers=1 excluded=1")
    })
    // Renamed and re-registered (a new node: new name, new ID), nothing finds the old one: the device is gone as far as
    // Tailscale says (as when he removes it from his tailnet), so access is as it was, and health notes it.
    await serveAs({ config: AS_SHIPPED, status: withDinghy({ dnsName: "lifeboat", id: "nDinghy2CNTRL" }), peer: "127.0.0.1", listener: "loopback" }, async (served) => {
      expect(await (await fetch(`${served.base}/health`)).text()).toEndWith(" writes=member-except-hosts members=3 writers=2 excluded=0:unmatched:dinghy")
    })
  })

  test("an exclusion with no ID yet (unkeyed) closes every tailnet source, his phone too, reads and writes, and health says why", async () => {
    const unkeyed = { ...AS_SHIPPED, excluded: [{ name: "dinghy", ids: [] }] }
    for (const peer of [OWN_PHONE, DINGHY, "100.101.102.104"])
      await serveAs({ config: unkeyed, status: withDinghy({ dnsName: "dinghy", id: "nDinghy1CNTRL" }), peer, listener: "tailnet" }, async (served) => {
        expect([peer, (await fetch(`${served.base}/view.json`)).status, (await send(served, "/api/mark", { id: "m1", mark: "read" })).status, await served.written()]).toEqual([peer, 401, 401, 0])
        // Pairing still works.
        expect((await fetch(`${served.base}/view.json`, { headers: { [TOKEN_HEADER]: await served.pair() } })).status).toBe(200)
      })
    await serveAs({ config: unkeyed, status: withDinghy({ dnsName: "dinghy", id: "nDinghy1CNTRL" }), peer: "127.0.0.1", listener: "loopback" }, async (served) => {
      expect(await (await fetch(`${served.base}/health`)).text()).toEndWith(" writes=paired:unkeyed:dinghy members=0 writers=0 excluded=0")
    })
  })
})

// ── The device store lost (round 3's B1), through the real listener ──

// The verifier's round-3 probe 2e (verify-r3.test.ts), adopted: dinghy keyed in the store by the command, then the
// store lost, dinghy renamed lifeboat (same stable ID) and ANOTHER device of his now named dinghy. Nothing looks the
// name up again, so the other device's ID never stands in: the store keys nothing, every tailnet source is paired,
// and health says why. One copy lost: the other still keys dinghy.
describe("a lost device store closes, it never re-keys by name", () => {
  const NAMES = { tailnetWrite: "member-except-hosts", agentHosts: [], excluded: ["dinghy"] } as const
  /** The store's damage, each as an outsider (a reset, a crash, a hand edit) leaves it. */
  const DAMAGE: ReadonlyArray<readonly [string, (path: string) => void, string]> = [
    ["deleted", (path) => rmSync(path, { force: true }), "absent"],
    ["emptied", (path) => writeFileSync(path, ""), "unparsable"],
    ["truncated", (path) => writeFileSync(path, '{"v":1,"agents":[],"exclu'), "unparsable"],
    ["garbage", (path) => writeFileSync(path, "\u0000\u00ff not json"), "unparsable"],
    ["of an old shape", (path) => writeFileSync(path, JSON.stringify([{ name: "dinghy", id: "nDinghy1CNTRL" }])), "wrong-version"],
    ["of another version", (path) => writeFileSync(path, JSON.stringify({ v: 2, agents: [], excluded: [{ name: "dinghy", ids: ["nDinghy1CNTRL"] }] })), "wrong-version"],
    ["of a wrong shape", (path) => writeFileSync(path, JSON.stringify({ v: 1, excluded: "dinghy" })), "wrong-shape"],
    ["mode 000", (path) => chmodSync(path, 0o000), "unreadable-EACCES"],
    ["a directory in its place", (path) => (rmSync(path, { force: true }), mkdirSync(path)), "unreadable-EISDIR"],
  ]
  // The status after the store was lost: dinghy renamed lifeboat, and his new laptop took the name dinghy.
  const cliIn = (dir: string) => {
    const cli = join(dir, "tailscale")
    const peer = (key: string, name: string, id: string, ip: string) => `"${key}":{"DNSName":"${name}.example-tailnet.ts.net.","ID":"${id}","HostName":"${name}","TailscaleIPs":["${ip}"],"UserID":7}`
    const peers = [peer("k1", "phone", "nPhone1CNTRL", OWN_PHONE), peer("k2", "lifeboat", "nDinghy1CNTRL", DINGHY), peer("k3", "dinghy", "nLaptop1CNTRL", "100.101.102.140")].join(",")
    writeFileSync(cli, `#!/bin/sh\necho '{"BackendState":"Running","Self":{"DNSName":"harbor.example-tailnet.ts.net.","ID":"nHarbor","TailscaleIPs":["100.101.102.103"],"UserID":7},"Peer":{${peers}}}'\n`, { mode: 0o755 })
    return cli
  }
  const keyed = (dir: string) => {
    const paths = [join(dir, "state/devices.json"), join(dir, "config/opencode-digest/devices.json")] as const
    return Effect.runPromise(Effect.as(FileDevices.change(paths, Effect.succeed(withDinghy({ dnsName: "dinghy", id: "nDinghy1CNTRL" })), (store) => Effect.succeed({ ...store, excluded: [{ name: "dinghy", ids: ["nDinghy1CNTRL"] }] })), paths))
  }
  const membersAt = async (paths: readonly [string, string], cli: string) => {
    const [primary, secondary] = await Effect.runPromise(FileDevices.readCopies(paths))
    return membersWith(NAMES.tailnetWrite, keysOf(NAMES, primary, secondary), await Effect.runPromise(statusFrom([cli])), NOW)
  }
  const config = { tailnetWrite: NAMES.tailnetWrite, agentHosts: [], excluded: [] } as const

  for (const [label, damage, word] of DAMAGE)
    test(`both copies ${label}, dinghy renamed and another device of his named dinghy: dinghy reads, marks and answers nothing unpaired, health says unkeyed`, async () => {
      using held = scratch("digest-storeloss-")
      const cli = cliIn(held.path)
      const paths = await keyed(held.path)
      for (const path of paths) damage(path)
      const members = await membersAt(paths, cli)
      const status = await Effect.runPromise(statusFrom([cli]))
      for (const peer of [DINGHY, OWN_PHONE, "100.101.102.140"])
        await serveAs({ config, status, members, peer, listener: "tailnet" }, async (served) => {
          expect([peer, (await fetch(`${served.base}/view.json`)).status, (await send(served, "/api/mark", { id: "m1", mark: "read" })).status, (await send(served, "/api/answer", AN_ANSWER)).status, await served.written()]).toEqual([peer, 401, 401, 401, 0])
        })
      await serveAs({ config, status, members, peer: "127.0.0.1", listener: "loopback" }, async (served) => {
        expect(await (await fetch(`${served.base}/health`)).text()).toEndWith(` writes=paired:unkeyed:dinghy:store-${word}/${word} members=0 writers=0 excluded=0:store-${word}/${word}`)
      })
    })

  test("an agent host the store does not key (never keyed, or lost from it) closes the writes: skiff and his phone mark nothing unpaired, both still read", async () => {
    using held = scratch("digest-storeloss-")
    const paths = await keyed(held.path)
    const [primary, secondary] = await Effect.runPromise(FileDevices.readCopies(paths))
    const status = withDinghy({ dnsName: "dinghy", id: "nDinghy1CNTRL" })
    const members = membersWith("member-except-hosts", keysOf({ agentHosts: ["skiff"], excluded: ["dinghy"] }, primary, secondary), status, NOW)
    for (const peer of ["100.101.102.104", OWN_PHONE])
      await serveAs({ config, status, members, peer, listener: "tailnet" }, async (served) => {
        expect([peer, (await fetch(`${served.base}/view.json`)).status, (await send(served, "/api/mark", { id: "m1", mark: "read" })).status, await served.written()]).toEqual([peer, 200, 401, 0])
      })
    await serveAs({ config, status, members, peer: "127.0.0.1", listener: "loopback" }, async (served) => {
      expect(await (await fetch(`${served.base}/health`)).text()).toEndWith(" writes=paired:agent-unkeyed:skiff:store-ok/ok members=2 writers=0 excluded=1")
    })
  })

  for (const lost of [0, 1] as const)
    test(`copy ${lost + 1} deleted, dinghy renamed and another device of his named dinghy: the other copy keys dinghy (out by its ID), the laptop is out by the name, his phone still marks unpaired, health names the copy`, async () => {
      using held = scratch("digest-storeloss-")
      const cli = cliIn(held.path)
      const paths = await keyed(held.path)
      rmSync(paths[lost], { force: true })
      const members = await membersAt(paths, cli)
      const status = await Effect.runPromise(statusFrom([cli]))
      for (const [peer, view, mark] of [[DINGHY, 401, 401], ["100.101.102.140", 401, 401], [OWN_PHONE, 200, 204]] as const)
        await serveAs({ config, status, members, peer, listener: "tailnet" }, async (served) => {
          expect([peer, (await fetch(`${served.base}/view.json`)).status, (await send(served, "/api/mark", { id: "m1", mark: "read" })).status]).toEqual([peer, view, mark])
        })
      const condition = ["store-absent/ok", "store-ok/absent"][lost]
      await serveAs({ config, status, members, peer: "127.0.0.1", listener: "loopback" }, async (served) => {
        // Two of his devices out (lifeboat by its ID, the laptop by the name), his phone in.
        expect(await (await fetch(`${served.base}/health`)).text()).toEndWith(` writes=member-except-hosts members=1 writers=1 excluded=2:${condition}`)
      })
    })
})
