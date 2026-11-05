import { describe, expect, test } from "bun:test"
import { Effect, Exit, type Scope } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { herdrLaws } from "../laws.ts"
import { agentParams } from "../report.ts"
import { Herdr, HerdrUnreachable } from "../service.ts"
import { listen } from "./fake-server.ts"
import * as SocketHerdr from "./socket.ts"

/** A scratch directory for the scope's lifetime; Unix socket paths must stay short. */
const scratch = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "herdr-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
)

/** A fake herdr listening in a scratch directory, for the scope's lifetime. */
const served = Effect.gen(function* () {
  const path = join(yield* scratch, "herdr.sock")
  return yield* Effect.acquireRelease(
    Effect.suspend(() => {
      const server = listen(path)
      return "failed" in server ? Effect.die(server.failed) : Effect.succeed(server)
    }),
    (server) => Effect.sync(server.stop),
  )
})

const TIMEOUT = 300

herdrLaws("socket Herdr", () =>
  Effect.gen(function* () {
    const server = yield* served
    return {
      layer: SocketHerdr.layer({ path: server.path, timeoutMillis: TIMEOUT }),
      peer: {
        received: Effect.sync(server.received),
        refuse: (code, message) => Effect.sync(() => server.answer({ kind: "refuse", code, message })),
      },
    }
  }),
)

const report = agentParams("w1:p1", { state: "idle", sessionId: "ses_1" }, 1)

const run = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(body))

describe("socket Herdr", () => {
  test("a socket nobody listens on fails HerdrUnreachable at once", () =>
    run(
      Effect.gen(function* () {
        const dir = yield* scratch
        const herdr = yield* Herdr.pipe(Effect.provide(SocketHerdr.layer({ path: join(dir, "missing.sock"), timeoutMillis: TIMEOUT })))
        const started = Date.now()
        const exit = yield* Effect.exit(herdr.report(report))
        expect(Exit.isFailure(exit)).toBe(true)
        expect(exit).toMatchObject({ cause: { reasons: [{ error: { _tag: "HerdrUnreachable" } }] } })
        expect(Date.now() - started).toBeLessThan(TIMEOUT)
      }),
    ))

  test("a herdr that never answers fails HerdrUnreachable after the timeout, having received the request", () =>
    run(
      Effect.gen(function* () {
        const server = yield* served
        server.answer({ kind: "silent" })
        const herdr = yield* Herdr.pipe(Effect.provide(SocketHerdr.layer({ path: server.path, timeoutMillis: TIMEOUT })))
        const started = Date.now()
        const exit = yield* Effect.exit(herdr.report(report))
        expect(exit).toEqual(Exit.fail(new HerdrUnreachable({ message: `herdr did not answer pane.report_agent within ${TIMEOUT} ms` })))
        expect(Date.now() - started).toBeGreaterThanOrEqual(TIMEOUT - 10)
        expect(server.received()).toEqual([{ method: "pane.report_agent", params: report }])
      }),
    ))

  test("one line per request, as herdr's NDJSON protocol reads it", () =>
    run(
      Effect.gen(function* () {
        const server = yield* served
        const herdr = yield* Herdr.pipe(Effect.provide(SocketHerdr.layer({ path: server.path, timeoutMillis: TIMEOUT })))
        yield* Effect.all([herdr.report(report), herdr.report({ ...report, seq: 2 })], { concurrency: 2 })
        expect(server.received().map((request) => request.params)).toContainEqual({ ...report, seq: 2 })
        expect(server.received()).toHaveLength(2)
      }),
    ))
})
