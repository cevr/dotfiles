// @reads all
// @reads-reason computed read at mods/digest/filestore/devices.ts: Effect.tryPromise({ try: () => stat(path), catch: codeOf }).pipe(
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
import { hostOf, noTailnet, StatusRead, type Tailnet } from "../bind.ts"
import * as FilePairing from "../filestore/pairing.ts"
import type { TailnetState } from "../health.ts"
import type { MarkLine } from "../marks.ts"
import { CODE_TTL_MS, OLD_COOKIE, type Pairing, SOURCE_FAILURES, TOKEN_HEADER } from "../pairing.ts"
import { keysOf, membersWith } from "../devices.ts"
import * as FileDevices from "../filestore/devices.ts"
import { closed, type Exclusion, type Members, membersOf, sourceOf, type WriteConfig } from "../members.ts"
import { ACCESS, ADDRESS_ONLY, type Decision, type Listener, PAIR_FIRST, type Policy, type TailnetWrite } from "../policy.ts"
import { statusFrom } from "../process/tailnet.ts"
import { answerOf, type Asking, type Handlers, HOSTNAME, kindOf, listen, loopbackSite, PAGE_HEADER, type PeerOf, type Place, screen, serveTailnet, siteOf, type Site, socketPeer } from "./listener.ts"

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
  peerOrigins: Effect.succeed([]),
  peerPages: Effect.succeed([]),
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

  test("it serves under its own address only: a loopback name and a rebound one are refused on every route; under its names GET / is sent on to the address, every other route refused, token or not", async () => {
    using held = scratch("digest-http-")
    await withListener(
      builtPage(held.path),
      async (base, written, _hostname, rig) => {
        const port = new URL(base).port
        const token = await paired(base, rig)
        const statusAt = async (host: string, path: string, headers: Record<string, string> = {}) => (await fetch(`${base}${path}`, { headers: { host, ...headers }, redirect: "manual" })).status
        for (const path of ["/", "/assets/index-abc.js", "/paired.json", "/health", "/view.json"]) {
          expect([path, await statusAt(`localhost:${port}`, path), await statusAt(`evil.example:${port}`, path)]).toEqual([path, 421, 421])
          for (const name of [`harbor:${port}`, `harbor.example-tailnet.ts.net:${port}`]) {
            const expected = [421, 308][Number(path === "/")]
            expect([path, name, await statusAt(name, path), await statusAt(name, path, { [TOKEN_HEADER]: token })]).toEqual([path, name, expected, expected])
          }
        }
        // A write under a name, from that name's origin, with the token: refused, nothing written; by the address it goes.
        const byName = await post(`${base}/api/mark`, { id: "m1", mark: "read" }, { ...own(base, token), host: `harbor:${port}`, origin: `http://harbor:${port}` })
        const crossed = await post(`${base}/api/mark`, { id: "m1", mark: "read" }, { ...own(base, token), origin: `http://harbor:${port}` })
        expect([byName.status, crossed.status]).toEqual([421, 403])
        expect(await Effect.runPromise(Ref.get(written))).toEqual([])
        expect((await post(`${base}/api/mark`, { id: "m1", mark: "read" }, own(base, token))).status).toBe(204)
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
        // Every read, with no token: the shell, whether paired, the view (by its address; never by a name), and health's `ok`.
        const reads = [
          await fetch(`${base}/`),
          await fetch(`${base}/assets/index-abc.js`),
          await fetch(`${base}/paired.json`),
          await fetch(`${base}/view.json`),
          await fetch(`${base}/view.json`, { headers: { host: `harbor:${port}` } }),
          await fetch(`${base}/view.json`, { headers: { host: `harbor.example-tailnet.ts.net:${port}` } }),
        ]
        expect(reads.map((each) => each.status)).toEqual([200, 200, 200, 200, 421, 421])
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
      Effect.runPromise(Effect.match(Effect.tryPromise(() => fetch(`http://${HOSTNAME}:${port}/`)), { onSuccess: (answer) => answer.status, onFailure: () => 0 }))
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
          peerOrigins: Effect.succeed([]),
          peerPages: Effect.succeed([]),
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


// ── The address only (digest-address-only), through the real listener ──
//
// His phone reads and writes with no token, so its network position is the credential, and every page in its
// browser shares it. Which server a NAME reaches is decided by the browser's resolver (a hostile Wi-Fi's search
// domain, a name rebound after the attacker's page loaded under it), so a page in a name's origin may be anyone's;
// an address origin is one no resolver decides. Two tailnet listeners, bound on 127.0.0.1 and ::1 standing in for
// the host's 100.x and fd7a: addresses, under the switches his hosts ship, each request from his phone (the test's
// peer seam), with no token unless it says so.

/** A tailnet listener as the cases reach it: its own address origin, as a browser writes it, and its port. */
interface AtAddress {
  readonly origin: string
  readonly host: string
  readonly port: number
}

/** What both listeners stored, and a paired browser's token for the token cases. */
interface Stored {
  readonly rig: Rig
  readonly token: string
}

const PAGE_ROUTES = ["view", "mark", "later", "name", "since", "answer"] as const
type PageRoute = (typeof PAGE_ROUTES)[number]
const WRITE_ROUTES: ReadonlyArray<PageRoute> = PAGE_ROUTES.filter((route) => route !== "view")
const BODIES: Readonly<Record<PageRoute, Readonly<Record<string, string>>>> = {
  view: {},
  mark: { id: "m1", mark: "read" },
  later: { id: "m2" },
  name: { project: "harbor", name: "Harbor Lights" },
  since: {},
  answer: { id: "question:s:q1", option: "Keep it" },
}

/** Both listeners on free ports, from his phone, under the shipped switches, sharing one rig. */
const withAddresses = (dist: string, body: (v4: AtAddress, v6: AtAddress, stored: Stored) => Promise<void>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const rig = yield* rigOf(join(dist, "..", "pairing"))
        const shipped: Handlers = { ...handlers(rig), tailnetRead: "member", members: Effect.succeed(his("member-except-hosts")) }
        const atOf = (bound: { readonly port: number }, written: string): AtAddress => ({ origin: `http://${written}:${bound.port}`, host: `${written}:${bound.port}`, port: bound.port })
        const v4 = atOf(yield* listen({ address: "127.0.0.1", port: 0, listener: "tailnet", names: NAMES.tailnet }, shipped, dist, () => OWN_PHONE), "127.0.0.1")
        const v6 = atOf(yield* listen({ address: "::1", port: 0, listener: "tailnet", names: NAMES.tailnet }, shipped, dist, () => OWN_PHONE), "[::1]")
        const token = (yield* rig.pairing.exchange(yield* rig.pairing.issue(NOW), NOW, "Invented Browser 1.0", OWN_PHONE)).token
        yield* Effect.promise(() => body(v4, v6, { rig, token }))
      }),
    ),
  )

/** One request to `at` naming `host` and `origin` ("" sends none), with `token` ("" none): the view, or a write as the page sends it. */
const ask = (at: AtAddress, route: PageRoute, host: string, origin: string, token = "") => {
  const headers = new Headers({ host })
  if (origin !== "") headers.set("origin", origin)
  if (token !== "") headers.set(TOKEN_HEADER, token)
  if (route === "view") return fetch(`${at.origin}/view.json`, { headers, redirect: "manual" })
  headers.set("content-type", "application/json")
  headers.set(PAGE_HEADER, "1")
  return fetch(`${at.origin}/api/${route}`, { method: "POST", body: JSON.stringify(BODIES[route]), headers, redirect: "manual" })
}

const storedCount = async (stored: Stored) => (await Effect.runPromise(Ref.get(stored.rig.written))).length + (await Effect.runPromise(Ref.get(stored.rig.answered))).length

/** Every spelling of the listener's names a request may carry as `Host`: as Tailscale names them, upper case, a trailing dot. */
const nameForms = (port: number) => [...NAMES.tailnet, "HARBOR.EXAMPLE-TAILNET.TS.NET", "Harbor", "harbor.example-tailnet.ts.net.", "harbor."].map((name) => `${name}:${port}`)

describe("on the tailnet the page answers at its own address only", () => {
  test("under a name (full, first label, upper case, trailing dot), with or without a token: the view and every write refused, nothing stored", async () => {
    using held = scratch("digest-http-")
    await withAddresses(builtPage(held.path), async (v4, v6, stored) => {
      for (const at of [v4, v6])
        for (const host of nameForms(at.port))
          for (const token of ["", stored.token]) {
            const view = await ask(at, "view", host, "", token)
            expect([host, token !== "", view.status, (await view.text()).includes('"v"')]).toEqual([host, token !== "", 421, false])
            for (const route of WRITE_ROUTES) expect([host, route, token !== "", (await ask(at, route, host, `http://${host}`, token)).status]).toEqual([host, route, token !== "", 421])
          }
      expect(await storedCount(stored)).toBe(0)
    })
  })

  test("under its address, from its own origin or (a GET) none, with no token: as before, his phone reads, marks and answers", async () => {
    using held = scratch("digest-http-")
    await withAddresses(builtPage(held.path), async (v4, v6, stored) => {
      for (const at of [v4, v6]) {
        const view = await ask(at, "view", at.host, "")
        expect([at.host, view.status, await view.text(), (await ask(at, "view", at.host, at.origin)).status]).toEqual([at.host, 200, '{"v":1}', 200])
        const statuses: Array<number> = []
        for (const route of WRITE_ROUTES) statuses.push((await ask(at, route, at.host, at.origin)).status)
        expect([at.host, statuses]).toEqual([at.host, [204, 204, 204, 204, 200]])
      }
      expect(await storedCount(stored)).toBe(10)
    })
  })

  test("GET / (any query) and HEAD / under a name: 308 to the bound address's page whatever the request names, no body, no cookie, no CORS grant; every other path refused", async () => {
    using held = scratch("digest-http-")
    await withAddresses(builtPage(held.path), async (v4, v6) => {
      for (const at of [v4, v6])
        for (const host of NAMES.tailnet.map((name) => `${name}:${at.port}`)) {
          for (const [method, path] of [["GET", "/"], ["HEAD", "/"], ["GET", "/?p=harbor"]] as const) {
            const answer = await fetch(`${at.origin}${path}`, { method, headers: { host, "x-forwarded-host": "evil.example", forwarded: "host=evil.example", origin: "http://evil.example" }, redirect: "manual" })
            const grants = [...answer.headers.keys()].filter((key) => key.startsWith("access-control-") || key === "set-cookie")
            expect([host, method, path, answer.status, answer.headers.get("location"), await answer.text(), grants]).toEqual([host, method, path, 308, `${at.origin}/`, "", []])
          }
          for (const path of ["/assets/index-abc.js", "/paired.json", "/health", "/index.html", "/anything"]) expect([host, path, (await fetch(`${at.origin}${path}`, { headers: { host }, redirect: "manual" })).status]).toEqual([host, path, 421])
        }
    })
  })

  test("over every generated Host and Origin pair: a tokenless request is accepted iff the Host is this listener's address and the Origin its own, or absent on a GET", async () => {
    using held = scratch("digest-http-")
    await withAddresses(builtPage(held.path), async (v4, v6, stored) => {
      const forms = (port: number) => [
        // This device's names, another of his devices', a colleague's: bare, with the port.
        ...["harbor.example-tailnet.ts.net", "harbor", "HARBOR", "harbor.", "phone.example-tailnet.ts.net", "phone", "skiff", "laptop.example-tailnet.ts.net", "laptop", "localhost", "evil.example"].flatMap((name) => [name, `${name}:${port}`]),
        // Addresses: this listener's and the other's, other tailnet hosts', IPv4, IPv6, IPv4-mapped, spelled out; bare, with the port, another port.
        ...["127.0.0.1", "[::1]", "[0:0:0:0:0:0:0:1]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "::1", "127.000.000.001", "100.101.102.103", "[fd7a:115c:a1e0::42]", "100.101.102.110", "[::ffff:100.101.102.103]"].flatMap((address) => [address, `${address}:${port}`, `${address}:${port + 1}`]),
      ]
      const wrong: Array<string> = []
      let accepted = 0
      let index = 0
      for (const at of [v4, v6]) {
        const hosts = forms(at.port)
        for (const host of hosts)
          for (const origin of ["", "null", ...hosts.map((each) => `http://${each}`), `https://${at.host}`, `${at.origin}/`]) {
            const route = PAGE_ROUTES[index % PAGE_ROUTES.length] ?? "view"
            index += 1
            const status = (await ask(at, route, host, origin)).status
            const expected = host === at.host && (origin === at.origin || (origin === "" && route === "view"))
            accepted += Number(status < 300 && route !== "view")
            if ((status < 300) !== expected) wrong.push(`${at.host} ${route} Host=${host} Origin=${origin}: ${status}`)
          }
      }
      expect(wrong.slice(0, 5)).toEqual([])
      expect([index > 2000, await storedCount(stored)]).toEqual([true, accepted])
    })
  })
})


// ── The order: the tailnet's authority before its method (round 1, B1), and loopback as main had it (round 1, M2) ──

/** A decision as the cases compare it: its status (Serve, Brief, Redirect by name) and its reason. */
const verdict = (decision: Decision): string =>
  Match.valueTags(decision, { Refuse: (refused) => `${refused.status} ${refused.reason}`, Serve: () => "Serve", Brief: () => "Brief", Redirect: () => "Redirect" })

/** A header as a case writes it: ABSENT for one not sent; anything else, "" included, is sent as is. */
const ABSENT = "<absent>"
const sent = (value: string): Option.Option<string> => Option.liftPredicate(value, (each) => each !== ABSENT)

/** One request as `screen` reads it, its Host and Origin written as `sent` reads them (Origin absent by default). */
const askingOf = (method: string, url: string, host: string, extra: Omit<Partial<Asking>, "host" | "origin"> & { readonly origin?: string } = {}): Asking => ({ method, url, pageHeader: true, json: true, paired: false, source: "own", ...extra, host: sent(host), origin: sent(extra.origin ?? ABSENT) })

const MEMBER_POLICY: Policy = { tailnetRead: "member", tailnetWrite: "member-except-hosts" }

/** Methods a request may carry (Bun hands each to the listener; its fetch would rewrite unknown ones to GET). */
const METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "TRACE", "CONNECT", "PROPFIND", "FOO", "get"]
/** Targets: the page, its data and its writes, an asset, a route that is none, an encoded or doubled path. */
const TARGETS = ["/", "/?p=harbor", "/health", "/view.json", "/paired.json", "/api/mark", "/api/answer", "/api/pair", "/assets/index-abc.js", "/anything", "//evil.example/", "/%2e%2e/secret.txt"]

describe("the order: on the tailnet the authority comes first, whatever the method, path or target", () => {
  test("over methods × targets × Host forms on the tailnet listener (8240, 80, 443; IPv4 and IPv6): not its address is 421, but a GET or HEAD of / by name, which is 308", () => {
    const sites = [8240, 80, 443].flatMap((port) => ["100.101.102.103", "fd7a:115c:a1e0::42"].map((address) => ({ port, site: siteOf({ address, port, listener: "tailnet", names: ["harbor.example-tailnet.ts.net", "harbor"] }, port) })))
    const hostsAt = (port: number, own: string, site: Site) =>
      [...new Set([own, ...site.names, "HARBOR", "harbor.", "phone.example-tailnet.ts.net", "evil.example", "localhost", "127.0.0.1", "100.101.102.110", "[::ffff:100.101.102.103]"].flatMap((each) => [each, `${each}:${port}`, `${each}:1`]).concat(["", "null", ABSENT, "[fd7a:115c:a1e0:0:0:0:0:42]:8240"]))]
    const cases = sites.flatMap(({ port, site }) => hostsAt(port, site.hosts[0] ?? "", site).flatMap((host) => METHODS.flatMap((method) => [...TARGETS, "*", "harbor:443"].map((target) => ({ site, host, method, target })))))
    /** What the authority alone says: the redirect, a 421, or nothing (the Host is the address: what follows decides). */
    const expectedOf = (site: Site, host: string, method: string, target: string) => {
      // The root as the listener reads it: the path of the URL Bun builds (an odd target may parse to `/`; the redirect still names only the address).
      const rootRead = (method === "GET" || method === "HEAD") && Option.exists(Option.fromNullishOr(URL.parse(`http://${host}${target}`)), (url) => url.pathname === "/")
      return Match.value({ own: host === site.hosts[0], named: site.names.includes(host), rootRead }).pipe(
        Match.when({ own: true }, () => "not the authority's"),
        Match.when({ named: true, rootRead: true }, () => "Redirect"),
        Match.orElse(() => "421"),
      )
    }
    const fits = (expected: string, got: string) =>
      Match.value(expected).pipe(
        Match.when("not the authority's", () => got !== "Redirect" && got !== `421 ${ADDRESS_ONLY}` && got !== "421 this page answers on its own names only"),
        Match.when("Redirect", () => got === "Redirect"),
        Match.orElse(() => got.startsWith("421 ")),
      )
    const wrong = cases.flatMap(({ site, host, method, target }) => {
      const got = verdict(screen(site, MEMBER_POLICY, askingOf(method, `http://${host}${target}`, host)).decision)
      const expected = expectedOf(site, host, method, target)
      return [`${site.home} ${method} ${target} Host=${host}: ${got} (expected ${expected})`].filter(() => !fits(expected, got))
    })
    expect(wrong.slice(0, 5)).toEqual([])
    expect(cases.length > 10_000).toBe(true)
  })

  test("over the real socket, any method and target under a name or another host: 421 (GET or HEAD of / by name: 308), never a CORS grant; Bun refuses what it cannot parse itself", async () => {
    using held = scratch("digest-http-")
    await withListener(
      builtPage(held.path),
      async (base) => {
        const port = Number(new URL(base).port)
        const raw = (text: string) =>
          Effect.runPromise(
            Effect.callback<string>((resume) => {
              let got = ""
              void Bun.connect({ hostname: HOSTNAME, port, socket: { open: (socket) => void socket.write(text), data: (_socket, data) => void (got += data.toString()), close: () => resume(Effect.succeed(got)), error: () => resume(Effect.succeed(got)) } })
            }),
          )
        const statusOf = (response: string) => response.split("\r\n")[0] ?? ""
        const wrong: Array<string> = []
        for (const host of [`harbor:${port}`, `harbor.example-tailnet.ts.net:${port}`, `evil.example:${port}`, `localhost:${port}`, `127.0.0.1:${port + 1}`])
          for (const method of ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "TRACE", "CONNECT", "PROPFIND"])
            for (const target of ["/", "/?p=harbor", "/health", "/view.json", "/api/mark", "/assets/index-abc.js", "http://evil.example/", ...["harbor:443"].filter(() => method === "CONNECT")]) {
              const response = await raw(`${method} ${target} HTTP/1.1\r\nHost: ${host}\r\nOrigin: http://evil.example\r\nAccess-Control-Request-Method: POST\r\nConnection: close\r\n\r\n`)
              const redirect = (method === "GET" || method === "HEAD") && ["/", "/?p=harbor", "http://evil.example/"].includes(target) && host.startsWith("harbor")
              const expected = [`HTTP/1.1 421 Misdirected Request`, `HTTP/1.1 308 Permanent Redirect`][Number(redirect)]
              const granted = /\r\naccess-control-|\r\nset-cookie:/i.test(response)
              if (statusOf(response) !== expected || granted) wrong.push(`${method} ${target} Host=${host}: ${statusOf(response)}${["", " with a CORS grant or cookie"][Number(granted)]}`)
            }
        expect(wrong.slice(0, 5)).toEqual([])
        // The round's probe as named: OPTIONS of / and of /health by name (405 before this round).
        expect([statusOf(await raw(`OPTIONS / HTTP/1.1\r\nHost: harbor:${port}\r\nConnection: close\r\n\r\n`)), statusOf(await raw(`OPTIONS /health HTTP/1.1\r\nHost: harbor:${port}\r\nConnection: close\r\n\r\n`))]).toEqual(["HTTP/1.1 421 Misdirected Request", "HTTP/1.1 421 Misdirected Request"])
        // Under its address the method is read after the authority, as before: OPTIONS is 405 there, with no CORS grant.
        const preflight = await raw(`OPTIONS /api/mark HTTP/1.1\r\nHost: ${HOSTNAME}:${port}\r\nOrigin: http://evil.example\r\nConnection: close\r\n\r\n`)
        expect([statusOf(preflight), /\r\naccess-control-/i.test(preflight)]).toEqual(["HTTP/1.1 405 Method Not Allowed", false])
        // What Bun cannot parse never reaches the listener: Bun answers 400 or closes, with none of the page's content.
        for (const line of [`OPTIONS * HTTP/1.1`, `FOO / HTTP/1.1`]) {
          const response = await raw(`${line}\r\nHost: harbor:${port}\r\nConnection: close\r\n\r\n`)
          expect([line, ["", "HTTP/1.1 400 Bad Request"].includes(statusOf(response)), response.includes("Digest")]).toEqual([line, true, false])
        }
      },
      (rig) => ({ ...handlers(rig), tailnetRead: "member", members: Effect.succeed(his("member-except-hosts")) }),
      "tailnet",
      () => OWN_PHONE,
    )
  })
})

// Main's loopback order (4afe1fda), vendored as the oracle: listener.ts `routed` up to the decision (a URL that does
// not parse: the defect's 500; a method no route takes: 405), its `kindOf`, its loopback hosts (bind.ts `hostsOf`:
// each name with `:port`, always), and policy.ts `decide` with `ACCESS.loopback`. The routes after the decision are
// the same code at both commits, so the same decision is the same answer.
const MAIN_PAIR_FIRST = "pair this browser first: run bun cmd/digest/pair.ts on the host and type the code it prints here"
const mainKindOf = (method: string, path: string): Option.Option<string> =>
  Match.value({ method, path }).pipe(
    Match.when({ method: "POST", path: "/api/answer" }, () => Option.some("answer")),
    Match.when({ method: "POST", path: "/api/pair" }, () => Option.some("pair")),
    Match.when({ method: "POST" }, () => Option.some("mark")),
    Match.when({ method: (each) => each !== "GET" && each !== "HEAD" }, () => Option.none<string>()),
    Match.when({ path: (each) => each === "/" || each.startsWith("/assets/") }, () => Option.some("shell")),
    Match.when({ path: "/paired.json" }, () => Option.some("status")),
    Match.when({ path: "/health" }, () => Option.some("health")),
    Match.orElse(() => Option.some("read")),
  )
// Main read the headers as `String(get("host"))` and `String(get("origin") ?? "")`: an absent Host is "null", an
// absent Origin "", as an empty one.
const mainHostOf = (asking: Asking) => Option.getOrElse(asking.host, () => "null")
const mainOriginOf = (asking: Asking) => Option.getOrElse(asking.origin, () => "")
const mainWriteRefusal = (asking: Asking): Option.Option<string> => {
  if (mainOriginOf(asking) !== `http://${mainHostOf(asking)}`) return Option.some("403 a write must come from the page's own origin")
  if (!asking.pageHeader) return Option.some("403 a write must carry the page's header")
  return Option.liftPredicate("415 a write is JSON", () => !asking.json)
}
const mainDecide = (kind: string, asking: Asking, port: number): string => {
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(mainHostOf(asking))) return "421 this page answers on its own names only"
  const refused = Option.filter(Option.some(kind), (each) => ["mark", "answer", "pair"].includes(each)).pipe(Option.flatMap(() => mainWriteRefusal(asking)))
  if (Option.isSome(refused)) return refused.value
  return ["Serve", `401 ${MAIN_PAIR_FIRST}`][Number(kind === "answer" && !asking.paired)] ?? ""
}
const mainLoopback = (asking: Asking, port: number): string =>
  Option.match(Option.fromNullishOr(URL.parse(asking.url)), {
    onNone: () => "500 the digest failed this request",
    onSome: (url) => Option.match(mainKindOf(asking.method, url.pathname), { onNone: () => "405 GET or POST only", onSome: (kind) => mainDecide(kind, asking, port) }),
  })

describe("loopback is main's, unchanged (round 1, M2)", () => {
  test("a differential over generated requests (ports 80, 443, 8240 and others; Host forms, methods, targets, Origins, headers, token): this head's loopback decision is main's for every one", () => {
    const random = (() => {
      let state = 20_261_122
      return () => {
        state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
        return state
      }
    })()
    const ports = [80, 443, 8240, 1, 65_535, ...Array.from({ length: 3 }, () => 1024 + (random() % 60_000))]
    const hostsAt = (port: number) => ["localhost", "127.0.0.1", "[::1]", "LOCALHOST", "localhost.", "127.0.0.2", "evil.example", "100.101.102.103"].flatMap((each) => [each, `${each}:${port}`, `${each}:80`, `${each}:${port + 1}`]).concat(["", "null", ABSENT])
    const headersOf = (host: string, port: number) =>
      [ABSENT, "", " ", "null", `http://${host}`, `http://${host}, http://${host}`, `http://${host}/`, `http://localhost:${port}`].flatMap((origin) => ([[true, true], [false, true], [true, false]] as const).flatMap(([pageHeader, json]) => [false, true].map((paired) => ({ origin, pageHeader, json, paired, source: "local" as const }))))
    const cases = ports.flatMap((port) =>
      hostsAt(port).flatMap((host) =>
        ["GET", "HEAD", "POST", "PUT", "OPTIONS", "TRACE", "FOO", "CONNECT"].flatMap((method) =>
          ["/", "/?p=x", "/assets/index-abc.js", "/view.json", "/health", "/paired.json", "/api/mark", "/api/answer", "/api/pair", "/x"].flatMap((target) => headersOf(host, port).map((extra) => ({ port, asking: askingOf(method, `http://${host}${target}`, host, extra) }))),
        ),
      ),
    )
    const wrong = cases.flatMap(({ port, asking }) => {
      const got = verdict(screen(loopbackSite(port), MEMBER_POLICY, asking).decision)
      const expected = mainLoopback(asking, port)
      return [`${port} ${asking.method} ${asking.url} Host=${asking.host} Origin=${asking.origin} header=${asking.pageHeader} json=${asking.json} paired=${asking.paired}: ${got} (main: ${expected})`].filter(() => got !== expected)
    })
    expect(wrong.slice(0, 5)).toEqual([])
    expect(cases.length > 100_000).toBe(true)
    expect(MAIN_PAIR_FIRST).toBe(PAIR_FIRST)
  })

  test("the round's probe: on digest.port 80, Host localhost:80 and 127.0.0.1:80 read health, a bare localhost is refused, as on main", async () => {
    using held = scratch("digest-http-")
    const dist = builtPage(held.path)
    const rig = await Effect.runPromise(rigOf(join(dist, "..", "pairing")))
    const statuses: Array<number> = []
    for (const host of ["localhost:80", "127.0.0.1:80", "localhost", "127.0.0.1"])
      statuses.push((await Effect.runPromise(answerOf(handlers(rig), dist, new Request(`http://${host}/health`, { headers: { host } }), loopbackSite(80)))).status)
    expect(statuses).toEqual([200, 200, 421, 421])
  })
})

describe("the tailnet on a default port: exactly what a browser sends", () => {
  test("on port 80 a browser sends Host and Origin without the port, and only that is the page's; on 443 (not http's default) with it", () => {
    for (const address of ["100.101.102.103", "fd7a:115c:a1e0::42"]) {
      const written = hostOf(address)
      // What a browser writes (WHATWG URL): http's default port is left out of the host and the origin.
      expect([new URL(`http://${written}:80/`).host, new URL(`http://${written}:80/`).origin, new URL(`http://${written}:443/`).host]).toEqual([written, `http://${written}`, `${written}:443`])
      for (const [port, browser, refused] of [[80, written, [`${written}:80`]], [443, `${written}:443`, [written, `${written}:80`]], [8240, `${written}:8240`, [written]]] as const) {
        const site = siteOf({ address, port, listener: "tailnet", names: ["harbor"] }, port)
        const mark = (host: string, origin: string) => verdict(screen(site, MEMBER_POLICY, askingOf("POST", `http://${host}/api/mark`, host, { origin })).decision)
        expect([port, site.hosts, site.home, mark(browser, `http://${browser}`), verdict(screen(site, MEMBER_POLICY, askingOf("GET", `http://${browser}/view.json`, browser)).decision)]).toEqual([port, [browser], `http://${browser}/`, "Serve", "Serve"])
        for (const other of refused) expect([port, other, mark(other, `http://${other}`).slice(0, 3), mark(browser, `http://${other}`).slice(0, 3)]).toEqual([port, other, "421", "403"])
        expect(verdict(screen(site, MEMBER_POLICY, askingOf("GET", `http://harbor${["", `:${port}`][Number(port !== 80)]}/`, `harbor${["", `:${port}`][Number(port !== 80)]}`)).decision)).toBe("Redirect")
      }
    }
  })
})


// ── An Origin sent is an Origin (round 2, B2): presence is the header's existence, never its value ──

/** One raw HTTP/1.1 exchange with the listener on `port` (the headers exactly as written, a duplicate too). */
const rawExchange = (port: number, text: string) =>
  Effect.runPromise(
    Effect.callback<string>((resume) => {
      let got = ""
      void Bun.connect({ hostname: HOSTNAME, port, socket: { open: (socket) => void socket.write(text), data: (_socket, data) => void (got += data.toString()), close: () => resume(Effect.succeed(got)), error: () => resume(Effect.succeed(got)) } })
    }),
  )

/** A request's Origin lines: none, one, or several (Bun joins two with ", "). */
const originLines = (origins: ReadonlyArray<string>) => origins.map((origin) => `Origin: ${origin}\r\n`).join("")

/** The page's own requests on the wire: a read of the view, or a write with the page's header and a JSON body. */
const wire = (route: "view" | "mark" | "answer", host: string, origins: ReadonlyArray<string>) => {
  const body = JSON.stringify([{}, { id: "m1", mark: "read" }, { id: "question:s:q1", option: "Keep it" }][["view", "mark", "answer"].indexOf(route)])
  return [
    `GET /view.json HTTP/1.1\r\nHost: ${host}\r\n${originLines(origins)}Connection: close\r\n\r\n`,
    `POST /api/${route} HTTP/1.1\r\nHost: ${host}\r\n${originLines(origins)}${PAGE_HEADER}: 1\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
  ][Number(route !== "view")] ?? ""
}

/**
 * The Origin forms a request may carry, by what each is on the wire: absent; empty; whitespace only (HTTP trims it
 * to empty); `null`; the address's origin; it twice (two headers, joined); another origin; it with a slash or a path.
 */
const originForms = (own: string): ReadonlyArray<readonly [string, ReadonlyArray<string>]> => [
  ["absent", []],
  ["empty", [""]],
  ["spaces", ["  "]],
  ["null", ["null"]],
  ["own", [own]],
  ["own twice", [own, own]],
  ["another", ["http://evil.example"]],
  ["own/", [`${own}/`]],
  ["own/path", [`${own}/view.json`]],
]

describe("an Origin that is sent is compared, whatever its value (round 2, B2)", () => {
  test("tailnet, from his phone with no token: a read is served only with no Origin or exactly the address's; a write only with exactly it; nothing else reads or stores", async () => {
    using held = scratch("digest-http-")
    await withListener(
      builtPage(held.path),
      async (base, written, _hostname, rig) => {
        const port = Number(new URL(base).port)
        const host = `${HOSTNAME}:${port}`
        const wrong: Array<string> = []
        for (const [label, origins] of originForms(base))
          for (const route of ["view", "mark", "answer"] as const) {
            const response = await rawExchange(port, wire(route, host, origins))
            const status = Number((response.split("\r\n")[0] ?? "").split(" ")[1])
            const served = label === "own" || (label === "absent" && route === "view")
            const expected = [403, [200, 204, 200][["view", "mark", "answer"].indexOf(route)] ?? 0][Number(served)]
            if (status !== expected || response.includes('"v":1') !== (served && route === "view")) wrong.push(`${route} Origin ${label}: ${status} (expected ${expected})`)
          }
        expect(wrong).toEqual([])
        expect([(await Effect.runPromise(Ref.get(written))).length, (await Effect.runPromise(Ref.get(rig.answered))).length]).toEqual([1, 1])
      },
      (rig) => ({ ...handlers(rig), tailnetRead: "member", members: Effect.succeed(his("member-except-hosts")) }),
      "tailnet",
      () => OWN_PHONE,
    )
  })

  test("loopback, on the wire: as main (a read reads no Origin; a mark only from exactly its own), and main's oracle says the same for each", async () => {
    using held = scratch("digest-http-")
    await withListener(builtPage(held.path), async (base, written) => {
      const port = Number(new URL(base).port)
      const host = `${HOSTNAME}:${port}`
      const wrong: Array<string> = []
      for (const [label, origins] of originForms(base))
        for (const route of ["view", "mark"] as const) {
          const status = Number(((await rawExchange(port, wire(route, host, origins))).split("\r\n")[0] ?? "").split(" ")[1])
          // Main read `String(get("origin") ?? "")`: absent and empty are both "", two are joined.
          const mainOrigin = [origins.join(", "), ""][Number(origins.length === 0)] ?? ""
          const main = mainLoopback(askingOf(["GET", "POST"][Number(route !== "view")] ?? "", `http://${host}/${["view.json", "api/mark"][Number(route !== "view")]}`, host, { origin: mainOrigin, source: "local" }), port)
          const expected = [200, [403, 204][Number(label === "own")]][Number(route !== "view")]
          if (status !== expected || (main === "Serve") !== (expected < 300)) wrong.push(`${route} Origin ${label}: ${status} (expected ${expected}, main's oracle ${main})`)
        }
      expect(wrong).toEqual([])
      expect((await Effect.runPromise(Ref.get(written))).length).toBe(1)
    })
  })
})
