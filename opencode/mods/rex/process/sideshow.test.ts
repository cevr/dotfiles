// @reads all
// @reads-reason subprocess reads at mods/rex/process/sideshow.ts: const out = Bun.spawnSync(["ps", "-o", "ppid=,comm=", "-p", String(pid)], { stdout: "pipe", std
// The Sideshow adapter against a stand-in server on a free local port: the
// session the CLI would use (its state file, else the folder's last active
// session), posts, titles, assets and flattened posts read back, the token
// sent only to the CLI's own server, and each way a read fails.
import { describe, expect } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Option } from "effect"
import { effectTest } from "../../../sim-tui/effect-test.ts"
import { Sideshow } from "../service.ts"
import * as ProcessSideshow from "./sideshow.ts"

const POSTS = [{ id: "p1", sessionId: "s1", title: "notes", version: 2, createdAt: "x", updatedAt: "2026-11-15T10:00:00Z", surfaces: [{ kind: "markdown", index: 0, markdown: "# hi", id: "u" }] }]
const SESSIONS = [
  { id: "s1", title: "Plan", cwd: "/work", lastActiveAt: "2026-11-15T10:00:00Z" },
  { id: "s0", title: "Old", cwd: "/work", lastActiveAt: "2026-11-15T09:00:00Z" },
]

/** The list as Sideshow sends it: an untitled session with no folder has null for both. */
const SESSIONS_SENT = JSON.stringify(SESSIONS).replace(/\]$/, ',{"id":"bare","title":null,"cwd":null,"lastActiveAt":"2026-11-15T11:00:00Z"}]')

/** A stand-in Sideshow for the test's span, recording each request's path and authorization: its address and the log. */
const served = Effect.acquireRelease(
  Effect.sync(() => {
    const log: Array<string> = []
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        const path = new URL(request.url).pathname
        log.push(`${path} ${request.headers.get("authorization") ?? "-"}`)
        if (path === "/api/sessions") return new Response(SESSIONS_SENT, { headers: { "content-type": "application/json" } })
        if (path === "/api/sessions/s1/posts") return Response.json(POSTS)
        if (path === "/a/a1") return new Response(new Uint8Array([1, 2, 3]))
        if (path === "/api/posts/p1/markdown") return new Response("# notes flattened")
        if (path === "/api/sessions/broken/posts") return new Response("oops", { status: 500 })
        return new Response("not found", { status: 404 })
      },
    })
    return { server, log, base: `http://127.0.0.1:${server.port}` }
  }),
  (held) => Effect.promise(() => held.server.stop(true)),
)

/** A scratch state folder, removed after. */
const stateDir = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "rex-sideshow-state-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
)

const places = (base: string, dir: string, more: Partial<ProcessSideshow.Places> = {}): ProcessSideshow.Places => ({
  base,
  token: Option.none(),
  session: Option.none(),
  agent: 4242,
  cwd: "/work",
  stateDir: dir,
  ...more,
})

const mineWith = (where: ProcessSideshow.Places) => Sideshow.use((sideshow) => sideshow.mine).pipe(Effect.provide(ProcessSideshow.layer(where)))

const sideshowWith = (where: ProcessSideshow.Places) => Sideshow.use(Effect.succeed).pipe(Effect.provide(ProcessSideshow.layer(where)))

describe("the caller's own session", () => {
  effectTest(
    "is $SIDESHOW_SESSION, else the CLI's state file while the server knows it, else the folder's last active session",
    Effect.scoped(
      Effect.gen(function* () {
        const { base } = yield* served
        const dir = yield* stateDir
        expect(yield* mineWith(places(base, dir, { session: Option.some("env") }))).toEqual(Option.some("env"))
        expect(yield* mineWith(places(base, dir))).toEqual(Option.some("s1"))
        yield* Effect.sync(() => {
          mkdirSync(dir, { recursive: true })
          writeFileSync(ProcessSideshow.stateFile(dir, 4242, "/work"), JSON.stringify({ session: "gone" }))
        })
        expect(yield* mineWith(places(base, dir))).toEqual(Option.some("s1"))
        yield* Effect.sync(() => writeFileSync(ProcessSideshow.stateFile(dir, 4242, "/work"), JSON.stringify({ session: "s1", agent: "x" })))
        expect(yield* mineWith(places(base, dir, { cwd: "/elsewhere" }))).toEqual(Option.none())
        yield* Effect.sync(() => writeFileSync(ProcessSideshow.stateFile(dir, 4242, "/elsewhere"), JSON.stringify({ session: "s1" })))
        expect(yield* mineWith(places(base, dir, { cwd: "/elsewhere" }))).toEqual(Option.some("s1"))
      }),
    ),
    10_000,
  )

  effectTest(
    "is keyed like the CLI's: the first 12 hex of sha1(agent:cwd)",
    Effect.sync(() => {
      expect(ProcessSideshow.stateFile("/t", 123, "/w")).toBe(`/t/${new Bun.CryptoHasher("sha1").update("123:/w").digest("hex").slice(0, 12)}.json`)
      expect(ProcessSideshow.agentOf(process.pid)).toBeGreaterThan(1)
    }),
    5_000,
  )
})

describe("reading a server", () => {
  effectTest(
    "posts, a title, an asset and a flattened post; the token only to the CLI's own server",
    Effect.scoped(
      Effect.gen(function* () {
        const own = yield* served
        const other = yield* served
        const dir = yield* stateDir
        const sideshow = yield* sideshowWith(places(`${own.base}/`, dir, { token: Option.some("t0k") }))
        expect(sideshow.base).toBe(own.base)
        const server = sideshow.at(own.base)
        expect((yield* server.posts("s1")).map((shown) => [shown.id, shown.version, shown.surfaces[0].markdown])).toEqual([["p1", 2, "# hi"]])
        expect(yield* server.title("s1")).toEqual(Option.some("Plan"))
        expect(yield* server.title("nope")).toEqual(Option.none())
        expect(yield* server.title("bare")).toEqual(Option.none())
        expect(Array.from(yield* server.asset("a1"))).toEqual([1, 2, 3])
        expect(yield* server.markdown("p1")).toBe("# notes flattened")
        expect(own.log.every((line) => line.endsWith(" Bearer t0k"))).toBe(true)
        yield* sideshow.at(other.base).posts("s1")
        expect(other.log).toEqual(["/api/sessions/s1/posts -"])
      }),
    ),
    10_000,
  )

  effectTest(
    "fails with why: an unknown session, an error status, a server that is down",
    Effect.scoped(
      Effect.gen(function* () {
        const { base } = yield* served
        const dir = yield* stateDir
        const sideshow = yield* sideshowWith(places(base, dir))
        const why = (effect: Effect.Effect<unknown, { readonly message: string }>) => Effect.map(Effect.flip(effect), (error) => error.message)
        expect(yield* why(sideshow.at(base).posts("nope"))).toBe(`Sideshow at ${base} has no session nope`)
        expect(yield* why(sideshow.at(base).posts("broken"))).toBe(`Sideshow at ${base} answered 500 to /api/sessions/broken/posts`)
        const down = yield* Effect.scoped(Effect.map(served, (held) => held.base))
        expect(yield* why(sideshow.at(down).posts("s1"))).toBe(`Sideshow not reachable at ${down}: ECONNREFUSED`)
      }),
    ),
    10_000,
  )
})
